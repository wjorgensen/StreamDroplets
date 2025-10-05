/**
 * Euler Finance Balance Tracker
 * Tracks ERC-4626 vault positions in Euler EVault on Sonic
 */

import { decodeEventLog, getAddress } from 'viem';
import { CONSTANTS, BlockRange } from '../../config/constants';
import { INTEGRATION_CONTRACTS } from '../../config/contracts';
import { EULER_VAULT_ABI } from '../../config/abis/eulerVault';
import { createLogger } from '../../utils/logger';
import { getDb } from '../../db/connection';
import { AlchemyService } from '../../utils/AlchemyService';
import { withAlchemyRetry } from '../../utils/retryUtils';

const logger = createLogger('EulerBalanceTracker');

export interface EulerEvent {
  chainId: number;
  contractAddress: string;
  protocolName: 'euler_finance';
  protocolType: 'vault';
  eventType: 'deposit' | 'withdraw' | 'transfer';
  userAddress: string;
  amount?: string; // For transfer, this is shares; for deposit/withdraw this is assets
  shares?: string; // For deposit/withdraw, this is the shares amount
  assets?: string; // For deposit/withdraw, this is the assets amount
  fromAddress?: string; // For transfers
  toAddress?: string; // For transfers
  ownerAddress?: string; // Canonical owner reported by the vault event
  blockNumber: number;
  timestamp: Date;
  txHash: string;
  logIndex: number;
  rawData: any;
}

export class EulerBalanceTracker {
  private readonly EULER_VAULT_ADDRESS = INTEGRATION_CONTRACTS.EULER_FINANCE.SONIC.XUSD_VAULT;
  private readonly db = getDb();
  private alchemyService: AlchemyService;

  constructor() {
    this.alchemyService = AlchemyService.getInstance();
    logger.info('Initialized Euler Balance Tracker');
  }

  /**
   * Converts an event date string to a Date object with UTC midnight timestamp
   */
  private getEventTimestamp(eventDate: string): Date {
    return new Date(`${eventDate}T00:00:00.000Z`);
  }

  /**
   * Fetches and stores Euler vault events for a block range
   */
  async fetchEventsForRange(
    fromBlock: number,
    toBlock: number,
    eventDate: string
  ): Promise<void> {
    logger.info(`Fetching Euler vault events from blocks ${fromBlock} to ${toBlock}`);
    
    try {
      const events = await this.fetchVaultEvents(fromBlock, toBlock, eventDate);
      
      if (events.length === 0) {
        logger.debug('No Euler vault events found in block range');
        return;
      }
      
      await this.storeEvents(events, eventDate);
      
      logger.info(`Stored ${events.length} Euler vault events`);
    } catch (error) {
      logger.error('Failed to fetch Euler vault events:', error);
      throw error;
    }
  }

  /**
   * Processes stored Euler vault events to update user balances
   */
  async processEventsForRange(range: BlockRange, eventDate: string): Promise<void> {
    if (range.chainId !== CONSTANTS.CHAIN_IDS.SONIC) {
      logger.warn(`Euler Finance not supported on chain ${range.chainId}`);
      return;
    }

    logger.info(`Processing stored Euler events for blocks ${range.fromBlock} to ${range.toBlock}`);

    const records = await this.db('daily_integration_events')
      .where({
        event_date: eventDate,
        protocol_name: 'euler_finance',
        chain_id: range.chainId,
      })
      .whereBetween('block_number', [range.fromBlock, range.toBlock])
      .orderBy('block_number')
      .orderBy('tx_hash')
      .orderBy('log_index');

    if (records.length === 0) {
      logger.debug('No stored Euler events found for processing');
      return;
    }

    const aggregates = new Map<string, { shareDelta: bigint; lastBlock: number }>();

    for (const record of records) {
      const shareDelta = this.toBigInt(record.shares_delta);
      if (shareDelta === 0n) {
        continue;
      }

      const normalizedAddress = this.normalizeAddress(record.address as string);
      const normalizedCounterparty = record.counterparty_address
        ? this.normalizeAddress(record.counterparty_address as string)
        : null;
      const eventType = record.event_type?.toLowerCase();

      if (record.protocol_name === 'euler_finance' && eventType === 'transfer') {
        this.applyShareDelta(aggregates, normalizedAddress, shareDelta, record.block_number ?? 0);
        if (normalizedCounterparty) {
          this.applyShareDelta(aggregates, normalizedCounterparty, -shareDelta, record.block_number ?? 0);
        }
        continue;
      }

      this.applyShareDelta(aggregates, normalizedAddress, shareDelta, record.block_number ?? 0);
    }

    if (aggregates.size === 0) {
      logger.debug('No Euler balance changes derived from stored events');
      return;
    }

    for (const [address, aggregate] of aggregates.entries()) {
      await this.updateUserBalance(address, aggregate.shareDelta, aggregate.lastBlock, eventDate);
    }

    logger.info(`Applied Euler balance updates for ${aggregates.size} address(es)`);
  }

  /**
   * Fetches vault events from the Euler vault contract
   */
  private async fetchVaultEvents(
    fromBlock: number,
    toBlock: number,
    eventDate: string
  ): Promise<EulerEvent[]> {
    const events: EulerEvent[] = [];

    try {
      const sonicAlchemy = this.alchemyService.getAlchemyInstance(CONSTANTS.CHAIN_IDS.SONIC);
      const logs = await withAlchemyRetry(async () => {
        return await sonicAlchemy.core.getLogs({
          address: this.EULER_VAULT_ADDRESS,
          fromBlock,
          toBlock,
        });
      }, `Euler Finance getLogs (blocks ${fromBlock}-${toBlock})`);

      for (const log of logs) {
        try {
          const event = await this.decodeLogToEvent(log, eventDate);
          if (event) {
            events.push(event);
          }
        } catch (decodeError) {
          // Silently skip logs we can't decode (expected for unrelated events)
        }
      }

      logger.debug(`Fetched ${events.length} events from Euler vault ${this.EULER_VAULT_ADDRESS}`);
      return events;
    } catch (error) {
      logger.error(`Failed to fetch events from Euler vault ${this.EULER_VAULT_ADDRESS}:`, error);
      return [];
    }
  }

  /**
   * Decodes a blockchain log into an EulerEvent object
   */
  private async decodeLogToEvent(log: any, eventDate: string): Promise<EulerEvent | null> {
    try {
      const decodedLog = decodeEventLog({
        abi: EULER_VAULT_ABI,
        data: log.data,
        topics: log.topics,
      });

      const timestamp = this.getEventTimestamp(eventDate);

      switch ((decodedLog as any).eventName) {
        case 'Deposit': {
          const { sender, owner, assets, shares } = decodedLog.args as any;
          const ownerAddress = getAddress(owner as string);
          const senderAddress = getAddress(sender as string);
          return {
            chainId: CONSTANTS.CHAIN_IDS.SONIC,
            contractAddress: getAddress(this.EULER_VAULT_ADDRESS),
            protocolName: 'euler_finance',
            protocolType: 'vault',
            eventType: 'deposit',
            userAddress: ownerAddress,
            fromAddress: senderAddress,
            amount: assets.toString(),
            shares: shares.toString(),
            assets: assets.toString(),
            blockNumber: log.blockNumber,
            timestamp,
            txHash: log.transactionHash,
            logIndex: log.logIndex,
            ownerAddress,
            rawData: decodedLog,
          };
        }

        case 'Withdraw': {
          const { sender, receiver, owner, assets, shares } = decodedLog.args as any;
          const ownerAddress = getAddress(owner as string);
          const senderAddress = getAddress(sender as string);
          const receiverAddress = getAddress(receiver as string);
          return {
            chainId: CONSTANTS.CHAIN_IDS.SONIC,
            contractAddress: getAddress(this.EULER_VAULT_ADDRESS),
            protocolName: 'euler_finance',
            protocolType: 'vault',
            eventType: 'withdraw',
            userAddress: ownerAddress,
            fromAddress: senderAddress,
            toAddress: receiverAddress,
            amount: assets.toString(),
            shares: shares.toString(),
            assets: assets.toString(),
            blockNumber: log.blockNumber,
            timestamp,
            txHash: log.transactionHash,
            logIndex: log.logIndex,
            ownerAddress,
            rawData: decodedLog,
          };
        }

        case 'Transfer': {
          const { from, to, value } = decodedLog.args as any;
          
          const { checkZeroAddress } = require('../../config/contracts');
          if (checkZeroAddress(from) || checkZeroAddress(to)) {
            return null;
          }

          return {
            chainId: CONSTANTS.CHAIN_IDS.SONIC,
            contractAddress: getAddress(this.EULER_VAULT_ADDRESS),
            protocolName: 'euler_finance',
            protocolType: 'vault',
            eventType: 'transfer',
            userAddress: getAddress(to as string),
            amount: value.toString(),
            shares: value.toString(),
            fromAddress: getAddress(from as string),
            toAddress: getAddress(to as string),
            blockNumber: log.blockNumber,
            timestamp,
            txHash: log.transactionHash,
            logIndex: log.logIndex,
            rawData: decodedLog,
          };
        }

        default:
          return null;
      }
    } catch (error) {
      logger.error('Failed to decode log to event:', error);
      return null;
    }
    
    return null;
  }

  /**
   * Retrieves the current price per share from the Euler vault at a specific block
   */
  async getCurrentPricePerShare(blockNumber: number): Promise<bigint> {
    try {
      const sonicViemClient = this.alchemyService.getViemClient(CONSTANTS.CHAIN_IDS.SONIC);
      
      const pricePerShare = await withAlchemyRetry(async () => {
        return await sonicViemClient.readContract({
          address: this.EULER_VAULT_ADDRESS as `0x${string}`,
          abi: EULER_VAULT_ABI,
          functionName: 'convertToAssets',
          args: [BigInt(1e18)],
          blockNumber: BigInt(blockNumber)
        }) as bigint;
      }, `Euler Finance price per share at block ${blockNumber}`);
      
      if (pricePerShare <= 0n) {
        throw new Error(`Invalid price per share returned: ${pricePerShare}`);
      }
      
      logger.debug(`Euler vault price per share at block ${blockNumber}: ${Number(pricePerShare) / 1e18}`);
      return pricePerShare;
      
    } catch (error) {
      const errorMessage = (error as Error).message;
      
      if (errorMessage.includes('returned no data ("0x")') || 
          errorMessage.includes('contract does not have the function') ||
          errorMessage.includes('address is not a contract')) {
        logger.warn(`Euler vault not deployed at block ${blockNumber}, skipping price per share calculation`);
        throw new Error(`Contract not deployed: ${errorMessage}`);
      }
      
      logger.error(`Failed to get price per share from Euler vault at block ${blockNumber}:`, error);
      throw new Error(`Unable to get Euler vault price per share: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Updates all Euler vault balances using the current price per share
   */
  async updateBalancesWithPricePerShare(blockNumber: number): Promise<void> {
    logger.info(`Updating Euler balances with price per share at block ${blockNumber}`);
    
    try {
      const pricePerShare = await this.getCurrentPricePerShare(blockNumber);
      
      const positions = await this.db('integration_balances')
        .where({
          protocol_name: 'euler_finance',
          chain_id: CONSTANTS.CHAIN_IDS.SONIC,
          contract_address: this.EULER_VAULT_ADDRESS.toLowerCase(),
        })
        .where('position_shares', '>', '0');

      let updatedPositions = 0;

      for (const position of positions) {
        const shares = BigInt(position.position_shares);
        const newUnderlyingAssets = (shares * pricePerShare) / (10n ** 18n);
        
        const currentUnderlying = BigInt(position.underlying_assets || '0');
        const changeThreshold = currentUnderlying / 1000n;

        if (newUnderlyingAssets > currentUnderlying + changeThreshold || 
            newUnderlyingAssets < currentUnderlying - changeThreshold) {
          
          await this.db('integration_balances')
            .where({ id: position.id })
            .update({
              underlying_assets: newUnderlyingAssets.toString(),
              last_updated: new Date(),
            });

          updatedPositions++;
        }
      }

      logger.info(`Updated ${updatedPositions} Euler positions with PPS: ${Number(pricePerShare) / 1e18}`);
    } catch (error) {
      const errorMessage = (error as Error).message;
      
      if (errorMessage.includes('Contract not deployed:')) {
        logger.warn(`Euler vault not deployed at block ${blockNumber}, skipping balance updates`);
        return;
      }
      
      logger.error('Failed to update Euler balances with price per share:', error);
      throw error;
    }
  }

  /**
   * Stores Euler vault events in the daily_integration_events table
   */
  private async storeEvents(events: EulerEvent[], eventDate: string): Promise<void> {
    if (events.length === 0) return;
    
    const filteredEvents = events.filter(event => {
      if (event.eventType !== 'transfer') {
        return true;
      }

      if (!event.fromAddress || !event.toAddress) {
        return true;
      }

      try {
        return getAddress(event.fromAddress) !== getAddress(event.toAddress);
      } catch {
        return event.fromAddress.toLowerCase() !== event.toAddress.toLowerCase();
      }
    });

    const eventRecords = filteredEvents.map(event => {
      const storageAddress = this.getStorageAddressForEvent(event);
      const counterpartyAddress = this.getCounterpartyAddressForEvent(event, storageAddress);

      return {
        address: storageAddress,
        asset: 'xUSD',
        chain_id: event.chainId,
        protocol_name: event.protocolName,
        protocol_type: event.protocolType,
        contract_address: event.contractAddress.toLowerCase(),
        event_date: eventDate,
        event_type: event.eventType,
        amount_delta: event.eventType === 'deposit' ? (event.assets || '0') :
                      event.eventType === 'withdraw' ? `-${event.assets || '0'}` :
                      event.eventType === 'transfer' ? (event.shares || '0') : '0',
        shares_delta: event.eventType === 'deposit' ? (event.shares || '0') :
                      event.eventType === 'withdraw' ? `-${event.shares || '0'}` :
                      event.eventType === 'transfer' ? (event.shares || '0') : '0',
        block_number: event.blockNumber,
        timestamp: event.timestamp,
        tx_hash: event.txHash,
        log_index: event.logIndex,
        counterparty_address: counterpartyAddress,
      };
    });

    if (eventRecords.length === 0) {
      logger.debug('No Euler events to store after filtering');
      return;
    }

    const nonZeroEventRecords = eventRecords.filter((record) => {
      try {
        return BigInt(record.amount_delta) !== 0n;
      } catch {
        return true;
      }
    });

    if (nonZeroEventRecords.length === 0) {
      logger.debug('Skipped Euler events due to zero amount_delta');
      return;
    }

    const droppedCount = eventRecords.length - nonZeroEventRecords.length;
    if (droppedCount > 0) {
      logger.debug(`Dropped ${droppedCount} Euler events with zero amount_delta`);
    }

    await this.db('daily_integration_events')
      .insert(nonZeroEventRecords);
      
    logger.debug(`Stored ${nonZeroEventRecords.length} Euler events`);
  }

  /**
   * Determines the address to use for storing an event based on event type
   */
  private getStorageAddressForEvent(event: EulerEvent): string {
    const normalizedUser = this.normalizeAddress(event.userAddress);

    if (event.protocolName === 'euler_finance') {
      if (event.eventType === 'deposit' && event.fromAddress) {
        return this.normalizeAddress(event.fromAddress);
      }

      if (event.eventType === 'withdraw' && event.toAddress) {
        return this.normalizeAddress(event.toAddress);
      }
    }

    return normalizedUser;
  }

  /**
   * Determines the counterparty address for an event for auditing purposes
   */
  private getCounterpartyAddressForEvent(event: EulerEvent, storageAddress: string): string | null {
    if (event.protocolName === 'euler_finance') {
      if (event.eventType === 'deposit') {
        const normalizedOwner = this.normalizeAddress(event.ownerAddress ?? event.userAddress);
        return normalizedOwner !== storageAddress ? normalizedOwner : null;
      }

      if (event.eventType === 'withdraw') {
        const normalizedOwner = this.normalizeAddress(event.ownerAddress ?? event.userAddress);
        return normalizedOwner !== storageAddress ? normalizedOwner : null;
      }

      if (event.eventType === 'transfer') {
        return event.fromAddress ? this.normalizeAddress(event.fromAddress) : null;
      }
    }

    if (event.fromAddress) {
      const normalizedFrom = this.normalizeAddress(event.fromAddress);
      return normalizedFrom !== storageAddress ? normalizedFrom : null;
    }

    return null;
  }

  /**
   * Normalizes an address to checksummed lowercase format
   */
  private normalizeAddress(value: string): string {
    try {
      return getAddress(value).toLowerCase();
    } catch {
      return value.toLowerCase();
    }
  }

  /**
   * Applies a share delta to an address in the aggregates map
   */
  private applyShareDelta(
    aggregates: Map<string, { shareDelta: bigint; lastBlock: number }>,
    address: string | null,
    delta: bigint,
    blockNumber: number
  ): void {
    if (!address || delta === 0n) {
      return;
    }

    const existing = aggregates.get(address);
    if (existing) {
      aggregates.set(address, {
        shareDelta: existing.shareDelta + delta,
        lastBlock: Math.max(existing.lastBlock, blockNumber),
      });
    } else {
      aggregates.set(address, {
        shareDelta: delta,
        lastBlock: blockNumber,
      });
    }
  }

  /**
   * Updates a user's balance in the database based on share changes
   */
  private async updateUserBalance(userAddress: string, shareChange: bigint, blockNumber: number, eventDate: string): Promise<void> {
    const currentBalance = await this.db('integration_balances')
      .where({
        address: userAddress,
        chain_id: CONSTANTS.CHAIN_IDS.SONIC,
        contract_address: this.EULER_VAULT_ADDRESS.toLowerCase(),
        protocol_name: 'euler_finance',
      })
      .first();

    const currentShares = currentBalance ? BigInt(currentBalance.position_shares) : 0n;
    const newShares = currentShares + shareChange;

    if (newShares < 0n) {
      logger.warn(`Negative balance detected for ${userAddress}: ${newShares}`);
    }

    const underlyingAssets = newShares;

    if (currentBalance) {
      await this.db('integration_balances')
        .where({ id: currentBalance.id })
        .update({
          position_shares: newShares.toString(),
          underlying_assets: underlyingAssets.toString(),
          last_update_block: blockNumber,
          last_updated: new Date(),
          last_updated_date: eventDate,
        });
    } else {
      await this.db('integration_balances')
        .insert({
          address: userAddress,
          asset: 'xUSD',
          chain_id: CONSTANTS.CHAIN_IDS.SONIC,
          protocol_name: 'euler_finance',
          contract_address: this.EULER_VAULT_ADDRESS.toLowerCase(),
          position_shares: newShares.toString(),
          underlying_assets: underlyingAssets.toString(),
          last_update_block: blockNumber,
          last_updated: new Date(),
          last_updated_date: eventDate,
        });
    }
  }

  /**
   * Converts a value to a BigInt with safe error handling
   */
  private toBigInt(value: any): bigint {
    if (value === null || value === undefined) {
      return 0n;
    }

    if (typeof value === 'bigint') {
      return value;
    }

    const str = String(value);
    if (str.trim().length === 0) {
      return 0n;
    }

    try {
      return BigInt(str);
    } catch (error) {
      logger.warn(`Failed to convert value to BigInt: ${value}`, error);
      return 0n;
    }
  }

}
