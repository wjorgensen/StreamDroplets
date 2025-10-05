/**
 * Silo Finance Balance Tracker
 * Tracks ERC-4626 vault positions in Silo lending markets
 * Supports multiple vaults across Sonic and Avalanche chains
 */

import { decodeEventLog, getAddress } from 'viem';
import { CONSTANTS, BlockRange } from '../../config/constants';
import { INTEGRATION_CONTRACTS } from '../../config/contracts';
import { SILO_VAULT_ABI } from '../../config/abis/siloVault';
import { createLogger } from '../../utils/logger';
import { getDb } from '../../db/connection';
import { AlchemyService } from '../../utils/AlchemyService';
import { withAlchemyRetry } from '../../utils/retryUtils';

const logger = createLogger('SiloBalanceTracker');

export interface SiloEvent {
  chainId: number;
  contractAddress: string;
  protocolName: 'silo_finance';
  protocolType: 'vault';
  eventType: 'deposit' | 'withdraw' | 'transfer' | 'deposit_protected' | 'withdraw_protected';
  userAddress: string;
  amount?: string; 
  shares?: string; 
  assets?: string; 
  fromAddress?: string; 
  toAddress?: string; 
  blockNumber: number;
  timestamp: Date;
  txHash: string;
  logIndex: number;
  rawData: any;
}

export class SiloBalanceTracker {
  private readonly SILO_VAULT_ADDRESSES: Record<number, string[]> = {
    [CONSTANTS.CHAIN_IDS.SONIC]: [
      INTEGRATION_CONTRACTS.SILO_FINANCE.SONIC.XUSD_VAULT_1,
      INTEGRATION_CONTRACTS.SILO_FINANCE.SONIC.XUSD_VAULT_2,
    ],
    [CONSTANTS.CHAIN_IDS.AVALANCHE]: [
      INTEGRATION_CONTRACTS.SILO_FINANCE.AVALANCHE.XUSD_VAULT,
    ],
  };

  
  private readonly db = getDb();
  private alchemyService: AlchemyService;

  constructor() {
    this.alchemyService = AlchemyService.getInstance();
    logger.info('Initialized Silo Balance Tracker');
  }

  /**
   * Converts an event date string to a Date object with UTC midnight timestamp
   */
  private getEventTimestamp(eventDate: string): Date {
    return new Date(`${eventDate}T00:00:00.000Z`);
  }

  /**
   * Fetches and stores Silo vault events for a block range
   */
  async fetchEventsForRange(
    chainId: number,
    fromBlock: number,
    toBlock: number,
    eventDate: string
  ): Promise<void> {
    const vaultAddresses = this.SILO_VAULT_ADDRESSES[chainId];
    if (!vaultAddresses || vaultAddresses.length === 0) {
      logger.warn(`No Silo vaults configured for chain ${chainId}`);
      return;
    }

    logger.info(`Fetching Silo vault events from blocks ${fromBlock} to ${toBlock} on chain ${chainId}`);
    
    try {
      const allEvents: SiloEvent[] = [];
      
      for (const vaultAddress of vaultAddresses) {
        const events = await this.fetchVaultEvents(chainId, vaultAddress, fromBlock, toBlock, eventDate);
        allEvents.push(...events);
      }
      
      if (allEvents.length === 0) {
        logger.debug(`No Silo vault events found in block range for chain ${chainId}`);
        return;
      }
      
      await this.storeEvents(allEvents, eventDate);
      
      logger.info(`Stored ${allEvents.length} Silo vault events on chain ${chainId}`);
    } catch (error) {
      logger.error(`Failed to process Silo vault events on chain ${chainId}:`, error);
      throw error;
    }
  }

  /**
   * Processes stored Silo events to update user balances
   */
  async processEventsForRange(range: BlockRange, eventDate: string): Promise<void> {
    const vaultAddresses = this.SILO_VAULT_ADDRESSES[range.chainId];
    if (!vaultAddresses || vaultAddresses.length === 0) {
      logger.warn(`No Silo vaults configured for chain ${range.chainId}`);
      return;
    }

    await this.verifyPendingTransfers(range, eventDate);

    logger.info(`Processing stored Silo events for blocks ${range.fromBlock} to ${range.toBlock} on chain ${range.chainId}`);

    const records = await this.db('daily_integration_events')
      .where({
        event_date: eventDate,
        protocol_name: 'silo_finance',
        chain_id: range.chainId,
      })
      .whereBetween('block_number', [range.fromBlock, range.toBlock])
      .orderBy('block_number')
      .orderBy('tx_hash')
      .orderBy('log_index');

    if (records.length === 0) {
      logger.debug('No stored Silo events found for processing');
      return;
    }

    const aggregates = new Map<string, { shareDelta: bigint; lastBlock: number }>();

    for (const record of records) {
      const shareDelta = this.toBigInt(record.shares_delta);
      if (shareDelta === 0n) {
        continue;
      }

      const key = `${(record.address as string).toLowerCase()}_${(record.contract_address as string).toLowerCase()}`;
      const existing = aggregates.get(key);
      if (existing) {
        aggregates.set(key, {
          shareDelta: existing.shareDelta + shareDelta,
          lastBlock: Math.max(existing.lastBlock, record.block_number ?? 0),
        });
      } else {
        aggregates.set(key, {
          shareDelta,
          lastBlock: record.block_number ?? 0,
        });
      }
    }

    if (aggregates.size === 0) {
      logger.debug('No Silo balance changes derived from stored events');
      return;
    }

    for (const [key, aggregate] of aggregates.entries()) {
      if (aggregate.shareDelta === 0n) {
        continue;
      }

      const [address, contractAddress] = key.split('_');
      await this.updateUserBalance(
        address,
        contractAddress,
        range.chainId,
        aggregate.shareDelta,
        aggregate.lastBlock,
        eventDate
      );
    }

    logger.info(`Applied Silo balance updates for ${aggregates.size} address(es)`);
  }

  /**
   * Fetches events from a specific Silo vault contract
   */
  private async fetchVaultEvents(
    chainId: number,
    vaultAddress: string,
    fromBlock: number,
    toBlock: number,
    eventDate: string
  ): Promise<SiloEvent[]> {
    const events: SiloEvent[] = [];

    try {
      const alchemyInstance = this.alchemyService.getAlchemyInstance(chainId);
      const logs = await withAlchemyRetry(async () => {
        return await alchemyInstance.core.getLogs({
          address: vaultAddress,
          fromBlock,
          toBlock,
        });
      }, `Silo Finance getLogs for vault ${vaultAddress} (blocks ${fromBlock}-${toBlock})`);

      for (const log of logs) {
        try {
          const event = await this.decodeLogToEvent(log, chainId, vaultAddress, eventDate);
          if (event) {
            events.push(event);
          }
        } catch (decodeError) {
          // Silently skip logs we can't decode (expected for unrelated events)
        }
      }

      logger.debug(`Fetched ${events.length} events from Silo vault ${vaultAddress} on chain ${chainId}`);
      return events;
    } catch (error) {
      logger.error(`Failed to fetch events from Silo vault ${vaultAddress}:`, error);
      return [];
    }
  }

  /**
   * Decodes a blockchain log into a SiloEvent object
   */
  private async decodeLogToEvent(log: any, chainId: number, contractAddress: string, eventDate: string): Promise<SiloEvent | null> {
    try {
      const decodedLog = decodeEventLog({
        abi: SILO_VAULT_ABI,
        data: log.data,
        topics: log.topics,
      });

      const timestamp = this.getEventTimestamp(eventDate);

      switch ((decodedLog as any).eventName) {
        case 'Deposit': {
          const { owner, assets, shares } = decodedLog.args as any;
          return {
            chainId,
            contractAddress: getAddress(contractAddress),
            protocolName: 'silo_finance',
            protocolType: 'vault',
            eventType: 'deposit',
            userAddress: getAddress(owner as string),
            amount: assets.toString(),
            shares: shares.toString(),
            assets: assets.toString(),
            blockNumber: log.blockNumber,
            timestamp,
            txHash: log.transactionHash,
            logIndex: log.logIndex,
            rawData: decodedLog,
          };
        }

        case 'DepositProtected': {
          const { owner, assets, shares } = decodedLog.args as any;
          return {
            chainId,
            contractAddress: getAddress(contractAddress),
            protocolName: 'silo_finance',
            protocolType: 'vault',
            eventType: 'deposit_protected',
            userAddress: getAddress(owner as string),
            amount: assets.toString(),
            shares: shares.toString(),
            assets: assets.toString(),
            blockNumber: log.blockNumber,
            timestamp,
            txHash: log.transactionHash,
            logIndex: log.logIndex,
            rawData: decodedLog,
          };
        }

        case 'Withdraw': {
          const { owner, assets, shares } = decodedLog.args as any;
          return {
            chainId,
            contractAddress: getAddress(contractAddress),
            protocolName: 'silo_finance',
            protocolType: 'vault',
            eventType: 'withdraw',
            userAddress: getAddress(owner as string),
            amount: assets.toString(),
            shares: shares.toString(),
            assets: assets.toString(),
            blockNumber: log.blockNumber,
            timestamp,
            txHash: log.transactionHash,
            logIndex: log.logIndex,
            rawData: decodedLog,
          };
        }

        case 'WithdrawProtected': {
          const { owner, assets, shares } = decodedLog.args as any;
          return {
            chainId,
            contractAddress: getAddress(contractAddress),
            protocolName: 'silo_finance',
            protocolType: 'vault',
            eventType: 'withdraw_protected',
            userAddress: getAddress(owner as string),
            amount: assets.toString(),
            shares: shares.toString(),
            assets: assets.toString(),
            blockNumber: log.blockNumber,
            timestamp,
            txHash: log.transactionHash,
            logIndex: log.logIndex,
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
            chainId,
            contractAddress: getAddress(contractAddress),
            protocolName: 'silo_finance',
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

        case 'Borrow':
        case 'Repay':
          logger.debug(
            {
              txHash: log.transactionHash,
              logIndex: log.logIndex,
              eventName: (decodedLog as any).eventName,
            },
            'Skipping Silo loan activity event'
          );
          return null;

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
   * Retrieves the current price per share from a Silo vault at a specific block
   */
  async getCurrentPricePerShare(chainId: number, vaultAddress: string, blockNumber: number): Promise<bigint> {
    try {
      const viemClient = this.alchemyService.getViemClient(chainId);
      
      const pricePerShare = await withAlchemyRetry(async () => {
        return await viemClient.readContract({
          address: vaultAddress as `0x${string}`,
          abi: SILO_VAULT_ABI,
          functionName: 'convertToAssets',
          args: [BigInt(1e18)],
          blockNumber: BigInt(blockNumber)
        }) as bigint;
      }, `Silo Finance price per share for vault ${vaultAddress} at block ${blockNumber}`);
      
      if (pricePerShare <= 0n) {
        throw new Error(`Invalid price per share returned: ${pricePerShare}`);
      }
      
      logger.debug(`Silo vault ${vaultAddress} price per share at block ${blockNumber}: ${Number(pricePerShare) / 1e18}`);
      return pricePerShare;
      
    } catch (error) {
      const errorMessage = (error as Error).message;
      
      if (errorMessage.includes('returned no data ("0x")') || 
          errorMessage.includes('contract does not have the function') ||
          errorMessage.includes('address is not a contract')) {
        logger.warn(`Silo vault ${vaultAddress} not deployed at block ${blockNumber}, skipping price per share calculation`);
        throw new Error(`Contract not deployed: ${errorMessage}`);
      }
      
      logger.error(`Failed to get price per share from Silo vault ${vaultAddress} at block ${blockNumber}:`, error);
      throw new Error(`Unable to get Silo vault price per share: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Updates all Silo vault balances using the current price per share
   */
  async updateBalancesWithPricePerShare(chainId: number, blockNumber: number): Promise<void> {
    const vaultAddresses = this.SILO_VAULT_ADDRESSES[chainId];
    if (!vaultAddresses || vaultAddresses.length === 0) {
      logger.warn(`No Silo vaults configured for chain ${chainId}`);
      return;
    }

    logger.info(`Updating Silo balances with price per share on chain ${chainId} at block ${blockNumber}`);
    
    try {
      for (const vaultAddress of vaultAddresses) {
        await this.updateVaultBalancesWithPricePerShare(chainId, vaultAddress, blockNumber);
      }
    } catch (error) {
      logger.error(`Failed to update Silo balances with price per share on chain ${chainId}:`, error);
      throw error;
    }
  }

  /**
   * Updates balances for a specific Silo vault using price per share
   */
  private async updateVaultBalancesWithPricePerShare(
    chainId: number,
    vaultAddress: string,
    blockNumber: number
  ): Promise<void> {
    try {
      const pricePerShare = await this.getCurrentPricePerShare(chainId, vaultAddress, blockNumber);
      
      const positions = await this.db('integration_balances')
        .where({
          protocol_name: 'silo_finance',
          chain_id: chainId,
          contract_address: vaultAddress.toLowerCase(),
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

      logger.info(`Updated ${updatedPositions} Silo positions for vault ${vaultAddress} with PPS: ${Number(pricePerShare) / 1e18}`);
    } catch (error) {
      const errorMessage = (error as Error).message;
      
      if (errorMessage.includes('Contract not deployed:')) {
        logger.warn(`Silo vault ${vaultAddress} not deployed at block ${blockNumber}, skipping balance updates`);
        return;
      }
      
      logger.error(`Failed to update balances for Silo vault ${vaultAddress}:`, error);
      throw error;
    }
  }

  /**
   * Stores Silo vault events in the daily_integration_events table
   */
  private async storeEvents(events: SiloEvent[], eventDate: string): Promise<void> {
    if (events.length === 0) return;
    
    const eventRecords = events.map(event => ({
      address: event.userAddress.toLowerCase(),
      asset: 'xUSD',
      chain_id: event.chainId,
      protocol_name: event.protocolName,
      protocol_type: event.protocolType,
      contract_address: event.contractAddress.toLowerCase(),
      event_date: eventDate,
      event_type: event.eventType,
      amount_delta: this.getAmountDelta(event),
      shares_delta: this.getSharesDelta(event),
      block_number: event.blockNumber,
      timestamp: event.timestamp,
      tx_hash: event.txHash,
      log_index: event.logIndex,
      counterparty_address: event.fromAddress?.toLowerCase() || null,
    }));

    const nonZeroEventRecords = eventRecords.filter((record) => {
      try {
        return BigInt(record.amount_delta) !== 0n;
      } catch {
        return true;
      }
    });

    if (nonZeroEventRecords.length === 0) {
      logger.debug('Skipping Silo events due to zero amount_delta');
      return;
    }

    const droppedCount = eventRecords.length - nonZeroEventRecords.length;
    if (droppedCount > 0) {
      logger.debug(`Dropped ${droppedCount} Silo events with zero amount_delta`);
    }

    await this.db('daily_integration_events')
      .insert(nonZeroEventRecords);
      
    logger.debug(`Stored ${nonZeroEventRecords.length} Silo events`);
  }

  /**
   * Verifies pending Silo transfers and classifies them as deposits, withdrawals, or loan activity
   */
  private async verifyPendingTransfers(range: BlockRange, eventDate: string): Promise<void> {
    try {
      const pendingTransfers = await this.db('daily_events')
        .select(
          'id',
          'tx_hash',
          'from_address',
          'to_address',
          'amount_delta',
          'isIntegrationAddress'
        )
        .where('event_date', eventDate)
        .where('chain_id', range.chainId)
        .whereBetween('block_number', [range.fromBlock, range.toBlock])
        .whereIn('isIntegrationAddress', ['silo_pending_to', 'silo_pending_from'])
        .orderBy('block_number')
        .orderBy('log_index');

      if (pendingTransfers.length === 0) {
        logger.debug('No pending Silo transfers to verify');
        return;
      }

      const integrationEvents = await this.db('daily_integration_events')
        .select('id', 'tx_hash', 'event_type', 'address', 'amount_delta')
        .where('event_date', eventDate)
        .where('chain_id', range.chainId)
        .where('protocol_name', 'silo_finance')
        .whereBetween('block_number', [range.fromBlock, range.toBlock]);

      interface IntegrationLookupEntry {
        id: number;
        tx_hash: string;
        address: string | null;
        amount_delta: string;
        normalizedAmount: string;
      }

      const depositLookup = new Map<string, IntegrationLookupEntry[]>();
      const withdrawLookup = new Map<string, IntegrationLookupEntry[]>();

      for (const event of integrationEvents) {
        const eventType = event.event_type?.toLowerCase();
        if (!eventType) {
          continue;
        }

        const normalizedTxHash = event.tx_hash?.toLowerCase();
        const normalizedAddress = this.normalizeAddress(event.address);
        if (!normalizedTxHash || !normalizedAddress) {
          continue;
        }

        const normalizedAmount = this.normalizeAmount(event.amount_delta);
        const key = `${normalizedTxHash}_${normalizedAddress}`;
        const entry: IntegrationLookupEntry = {
          id: event.id,
          tx_hash: normalizedTxHash,
          address: normalizedAddress,
          amount_delta: event.amount_delta,
          normalizedAmount,
        };

        if (eventType === 'deposit' || eventType === 'deposit_protected') {
          if (!depositLookup.has(key)) {
            depositLookup.set(key, []);
          }
          depositLookup.get(key)!.push(entry);
        } else if (eventType === 'withdraw' || eventType === 'withdraw_protected') {
          if (!withdrawLookup.has(key)) {
            withdrawLookup.set(key, []);
          }
          withdrawLookup.get(key)!.push(entry);
        }
      }

      const markDeposits: number[] = [];
      const markWithdraws: number[] = [];
      const clearPending: number[] = [];

      for (const transfer of pendingTransfers) {
        const txHash = transfer.tx_hash?.toLowerCase();
        if (!txHash) {
          clearPending.push(transfer.id);
          continue;
        }

        const normalizedAmount = this.normalizeAmount(transfer.amount_delta);

        if (transfer.isIntegrationAddress === 'silo_pending_to') {
          const userAddress = this.normalizeAddress(transfer.from_address);
          if (!userAddress) {
            clearPending.push(transfer.id);
            continue;
          }

          const key = `${txHash}_${userAddress}`;
          const possibleDeposits = depositLookup.get(key);
          const matchIndex = possibleDeposits?.findIndex((entry) => entry.normalizedAmount === normalizedAmount) ?? -1;

          if (matchIndex >= 0 && possibleDeposits) {
            possibleDeposits.splice(matchIndex, 1);
            markDeposits.push(transfer.id);
          } else {
            clearPending.push(transfer.id);
          }
        } else if (transfer.isIntegrationAddress === 'silo_pending_from') {
          const userAddress = this.normalizeAddress(transfer.to_address);
          if (!userAddress) {
            clearPending.push(transfer.id);
            continue;
          }

          const key = `${txHash}_${userAddress}`;
          const possibleWithdraws = withdrawLookup.get(key);
          const matchIndex = possibleWithdraws?.findIndex((entry) => entry.normalizedAmount === normalizedAmount) ?? -1;

          if (matchIndex >= 0 && possibleWithdraws) {
            possibleWithdraws.splice(matchIndex, 1);
            markWithdraws.push(transfer.id);
          } else {
            clearPending.push(transfer.id);
          }
        }
      }

      if (markDeposits.length > 0) {
        await this.db('daily_events')
          .whereIn('id', markDeposits)
          .update({ isIntegrationAddress: 'to' });
        logger.debug(`Confirmed ${markDeposits.length} Silo deposit transfers`);
      }

      if (markWithdraws.length > 0) {
        await this.db('daily_events')
          .whereIn('id', markWithdraws)
          .update({ isIntegrationAddress: 'from' });
        logger.debug(`Confirmed ${markWithdraws.length} Silo withdrawal transfers`);
      }

      if (clearPending.length > 0) {
        await this.db('daily_events')
          .whereIn('id', clearPending)
          .update({ isIntegrationAddress: null });
        logger.debug(`Cleared ${clearPending.length} Silo loan activity transfers`);
      }
    } catch (error) {
      logger.error('Failed to verify Silo transfers:', error);
      throw error;
    }
  }

  /**
   * Normalizes an address to lowercase format
   */
  private normalizeAddress(value: string | null | undefined): string | null {
    if (!value) {
      return null;
    }
    return value.toLowerCase();
  }

  /**
   * Normalizes an amount value to a positive string representation
   */
  private normalizeAmount(value: string | null | undefined): string {
    if (value === null || value === undefined) {
      return '0';
    }

    const trimmed = value.trim();
    if (trimmed === '') {
      return '0';
    }

    try {
      const bigintValue = BigInt(trimmed);
      return bigintValue < 0n ? (-bigintValue).toString() : bigintValue.toString();
    } catch (error) {
      logger.warn({ value }, 'Failed to normalize amount');
      return '0';
    }
  }

  /**
   * Calculates the amount delta based on event type
   */
  private getAmountDelta(event: SiloEvent): string {
    switch (event.eventType) {
      case 'deposit':
      case 'deposit_protected':
        return event.assets || '0';
      case 'withdraw':
      case 'withdraw_protected':
        return `-${event.assets || '0'}`;
      case 'transfer':
        return event.shares || '0';
      default:
        return '0';
    }
  }

  /**
   * Calculates the shares delta based on event type
   */
  private getSharesDelta(event: SiloEvent): string {
    switch (event.eventType) {
      case 'deposit':
      case 'deposit_protected':
        return event.shares || '0';
      case 'withdraw':
      case 'withdraw_protected':
        return `-${event.shares || '0'}`;
      case 'transfer':
        return event.shares || '0';
      default:
        return '0';
    }
  }

  /**
   * Updates a user's balance for a specific Silo vault
   */
  private async updateUserBalance(
    userAddress: string, 
    contractAddress: string,
    chainId: number,
    shareChange: bigint, 
    blockNumber: number,
    eventDate: string
  ): Promise<void> {
    const currentBalance = await this.db('integration_balances')
      .where({
        address: userAddress,
        chain_id: chainId,
        contract_address: contractAddress.toLowerCase(),
        protocol_name: 'silo_finance',
      })
      .first();

    const currentShares = currentBalance ? BigInt(currentBalance.position_shares) : 0n;
    const newShares = currentShares + shareChange;

    if (newShares < 0n) {
      logger.warn(`Negative balance detected for ${userAddress} in vault ${contractAddress}: ${newShares}`);
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
          chain_id: chainId,
          protocol_name: 'silo_finance',
          contract_address: contractAddress.toLowerCase(),
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
