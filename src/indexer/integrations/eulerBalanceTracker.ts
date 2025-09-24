/**
 * Euler Finance Balance Tracker
 * Tracks ERC-4626 vault positions in Euler EVault on Sonic
 */

import { decodeEventLog, getAddress } from 'viem';
import { CONSTANTS } from '../../config/constants';
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
   * Fetch and process all Euler vault events for a specific block range
   */
  async processEulerEvents(
    fromBlock: number,
    toBlock: number,
    eventDate: string
  ): Promise<void> {
    logger.info(`Processing Euler vault events from blocks ${fromBlock} to ${toBlock}`);
    
    try {
      const events = await this.fetchVaultEvents(fromBlock, toBlock);
      
      if (events.length === 0) {
        logger.debug('No Euler vault events found in block range');
        return;
      }
      
      await this.storeEvents(events, eventDate);
      await this.updateUserBalances(events, eventDate);
      
      logger.info(`Processed ${events.length} Euler vault events`);
    } catch (error) {
      logger.error('Failed to process Euler vault events:', error);
      throw error;
    }
  }

  /**
   * Fetch events from the Euler vault contract
   */
  private async fetchVaultEvents(
    fromBlock: number,
    toBlock: number
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
          const event = await this.decodeLogToEvent(log);
          if (event) {
            events.push(event);
          }
        } catch (decodeError) {
          logger.warn(`Failed to decode log at ${log.transactionHash}:${log.logIndex}:`, decodeError);
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
   * Decode a log to an EulerEvent
   */
  private async decodeLogToEvent(log: any): Promise<EulerEvent | null> {
    try {
      const decodedLog = decodeEventLog({
        abi: EULER_VAULT_ABI,
        data: log.data,
        topics: log.topics,
      });

      const timestamp = new Date();

      switch ((decodedLog as any).eventName) {
        case 'Deposit': {
          const { owner, assets, shares } = decodedLog.args as any;
          return {
            chainId: CONSTANTS.CHAIN_IDS.SONIC,
            contractAddress: getAddress(this.EULER_VAULT_ADDRESS),
            protocolName: 'euler_finance',
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

        case 'Withdraw': {
          const { owner, assets, shares } = decodedLog.args as any;
          return {
            chainId: CONSTANTS.CHAIN_IDS.SONIC,
            contractAddress: getAddress(this.EULER_VAULT_ADDRESS),
            protocolName: 'euler_finance',
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
          logger.warn(`Unknown event type: ${(decodedLog as any).eventName}`);
          return null;
      }
    } catch (error) {
      logger.error('Failed to decode log to event:', error);
      return null;
    }
    
    return null;
  }

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
      
      // Check if this is a contract not deployed error
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
      
      // Check if this is a contract not deployed error
      if (errorMessage.includes('Contract not deployed:')) {
        logger.warn(`Euler vault not deployed at block ${blockNumber}, skipping balance updates`);
        return;
      }
      
      logger.error('Failed to update Euler balances with price per share:', error);
      throw error;
    }
  }

  /**
   * Store events in the daily_integration_events table
   */
  private async storeEvents(events: EulerEvent[], eventDate: string): Promise<void> {
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
      counterparty_address: event.fromAddress?.toLowerCase() || null,
    }));

    await this.db('daily_integration_events')
      .insert(eventRecords)
      .onConflict(['chain_id', 'tx_hash', 'log_index'])
      .ignore();
      
    logger.debug(`Stored ${eventRecords.length} Euler events`);
  }

  /**
   * Update user balances based on events
   */
  private async updateUserBalances(events: EulerEvent[], eventDate: string): Promise<void> {
    const userEvents = new Map<string, EulerEvent[]>();
    for (const event of events) {
      const userKey = event.userAddress.toLowerCase();
      if (!userEvents.has(userKey)) {
        userEvents.set(userKey, []);
      }
      userEvents.get(userKey)!.push(event);
    }

    for (const [userAddress, userEventList] of userEvents) {
      let netShareChange = 0n;
      
      for (const event of userEventList) {
        const delta = event.eventType === 'deposit' ? BigInt(event.shares || '0') :
                      event.eventType === 'withdraw' ? -BigInt(event.shares || '0') :
                      event.eventType === 'transfer' ? BigInt(event.shares || '0') : 0n;
        netShareChange += delta;
      }

      if (netShareChange !== 0n) {
        await this.updateUserBalance(userAddress, netShareChange, userEventList[0].blockNumber, eventDate);
      }
    }
  }

  /**
   * Update a single user's balance
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

}
