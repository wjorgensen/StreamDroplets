/**
 * Stability Balance Tracker
 * Tracks lending positions in Stability Protocol (AAVE v3 clone) on Sonic
 */

import { decodeEventLog, getAddress } from 'viem';
import { CONSTANTS, BlockRange } from '../../config/constants';
import { INTEGRATION_CONTRACTS, CONTRACTS } from '../../config/contracts';
import { STABILITY_POOL_ABI } from '../../config/abis/stabilityPool';
import { STABILITY_ATOKEN_ABI } from '../../config/abis/stabilityAToken';
import { createLogger } from '../../utils/logger';
import { getDb } from '../../db/connection';
import { AlchemyService } from '../../utils/AlchemyService';
import { withAlchemyRetry } from '../../utils/retryUtils';

const logger = createLogger('StabilityBalanceTracker');

export interface StabilityEvent {
  chainId: number;
  contractAddress: string;
  protocolName: 'stability';
  protocolType: 'lending';
  eventType: 'supply' | 'withdraw' | 'transfer';
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

export class StabilityBalanceTracker {
  private readonly POOL_ADDRESS = INTEGRATION_CONTRACTS.STABILITY.SONIC.POOL;
  private readonly ATOKEN_ADDRESS = INTEGRATION_CONTRACTS.STABILITY.SONIC.XUSD_ATOKEN;
  private readonly UNDERLYING_ASSET = CONTRACTS.xUSD.sonic; 
  private readonly db = getDb();
  private alchemyService: AlchemyService;

  constructor() {
    this.alchemyService = AlchemyService.getInstance();
    logger.info('Initialized Stability Balance Tracker');
  }

  /**
   * Converts an event date string to a Date object with UTC midnight timestamp
   */
  private getEventTimestamp(eventDate: string): Date {
    return new Date(`${eventDate}T00:00:00.000Z`);
  }

  /**
   * Fetches and stores Stability events for a block range
   */
  async fetchEventsForRange(
    fromBlock: number,
    toBlock: number,
    eventDate: string
  ): Promise<void> {
    logger.info(`Fetching Stability events from blocks ${fromBlock} to ${toBlock}`);
    
    try {
      const [poolEvents, aTokenEvents] = await Promise.all([
        this.fetchPoolEvents(fromBlock, toBlock, eventDate),
        this.fetchATokenEvents(fromBlock, toBlock, eventDate)
      ]);
      
      const allEvents = [...poolEvents, ...aTokenEvents];
      
      if (allEvents.length === 0) {
        logger.debug('No Stability events found in block range');
        return;
      }
      
      await this.storeEvents(allEvents, eventDate);
      
      logger.info(`Stored ${allEvents.length} Stability events (${poolEvents.length} pool, ${aTokenEvents.length} aToken)`);
    } catch (error) {
      logger.error('Failed to fetch Stability events:', error);
      throw error;
    }
  }

  /**
   * Processes stored Stability events to update user balances
   */
  async processEventsForRange(range: BlockRange, eventDate: string): Promise<void> {
    if (range.chainId !== CONSTANTS.CHAIN_IDS.SONIC) {
      logger.warn(`Stability Protocol not supported on chain ${range.chainId}`);
      return;
    }

    logger.info(`Processing stored Stability events for blocks ${range.fromBlock} to ${range.toBlock}`);

    const records = await this.db('daily_integration_events')
      .where({
        event_date: eventDate,
        protocol_name: 'stability',
        chain_id: range.chainId,
      })
      .whereBetween('block_number', [range.fromBlock, range.toBlock])
      .orderBy('block_number')
      .orderBy('tx_hash')
      .orderBy('log_index');

    if (records.length === 0) {
      logger.debug('No stored Stability events found for processing');
      return;
    }

    const aggregates = new Map<string, { shareDelta: bigint; lastBlock: number }>();

    for (const record of records) {
      const shareDelta = this.toBigInt(record.shares_delta);
      if (shareDelta === 0n) {
        continue;
      }

      const address = record.address as string;
      const existing = aggregates.get(address);
      if (existing) {
        aggregates.set(address, {
          shareDelta: existing.shareDelta + shareDelta,
          lastBlock: Math.max(existing.lastBlock, record.block_number ?? 0),
        });
      } else {
        aggregates.set(address, {
          shareDelta,
          lastBlock: record.block_number ?? 0,
        });
      }
    }

    if (aggregates.size === 0) {
      logger.debug('No Stability balance changes derived from stored events');
      return;
    }

    for (const [address, aggregate] of aggregates.entries()) {
      await this.updateUserBalance(address, aggregate.shareDelta, aggregate.lastBlock, eventDate);
    }

    logger.info(`Applied Stability balance updates for ${aggregates.size} address(es)`);
  }

  /**
   * Fetches supply and withdraw events from the Stability pool contract
   */
  private async fetchPoolEvents(
    fromBlock: number,
    toBlock: number,
    eventDate: string
  ): Promise<StabilityEvent[]> {
    const events: StabilityEvent[] = [];

    try {
      const sonicAlchemy = this.alchemyService.getAlchemyInstance(CONSTANTS.CHAIN_IDS.SONIC);
      const logs = await withAlchemyRetry(async () => {
        return await sonicAlchemy.core.getLogs({
          address: this.POOL_ADDRESS,
          fromBlock,
          toBlock,
        });
      }, `Stability Pool getLogs (blocks ${fromBlock}-${toBlock})`);

      for (const log of logs) {
        try {
          const event = await this.decodePoolLogToEvent(log, eventDate);
          if (event) {
            events.push(event);
          }
        } catch (decodeError) {
          // Silently skip logs we can't decode (expected for unrelated events)
        }
      }

      logger.debug(`Fetched ${events.length} events from Stability pool ${this.POOL_ADDRESS}`);
      return events;
    } catch (error) {
      logger.error(`Failed to fetch events from Stability pool ${this.POOL_ADDRESS}:`, error);
      return [];
    }
  }

  /**
   * Fetches transfer events from the aToken contract
   */
  private async fetchATokenEvents(
    fromBlock: number,
    toBlock: number,
    eventDate: string
  ): Promise<StabilityEvent[]> {
    const events: StabilityEvent[] = [];

    try {
      const sonicAlchemy = this.alchemyService.getAlchemyInstance(CONSTANTS.CHAIN_IDS.SONIC);
      const logs = await withAlchemyRetry(async () => {
        return await sonicAlchemy.core.getLogs({
          address: this.ATOKEN_ADDRESS,
          fromBlock,
          toBlock,
        });
      }, `Stability AToken getLogs (blocks ${fromBlock}-${toBlock})`);

      for (const log of logs) {
        try {
          const event = await this.decodeATokenLogToEvent(log, eventDate);
          if (event) {
            events.push(event);
          }
        } catch (decodeError) {
          // Silently skip logs we can't decode (expected for unrelated events)
        }
      }

      logger.debug(`Fetched ${events.length} events from Stability aToken ${this.ATOKEN_ADDRESS}`);
      return events;
    } catch (error) {
      logger.error(`Failed to fetch events from Stability aToken ${this.ATOKEN_ADDRESS}:`, error);
      return [];
    }
  }

  /**
   * Decodes a pool log into a StabilityEvent object
   */
  private async decodePoolLogToEvent(log: any, eventDate: string): Promise<StabilityEvent | null> {
    try {
      const decodedLog = decodeEventLog({
        abi: STABILITY_POOL_ABI,
        data: log.data,
        topics: log.topics,
      });

      const timestamp = this.getEventTimestamp(eventDate);

      switch ((decodedLog as any).eventName) {
        case 'Supply': {
          const { reserve, onBehalfOf, amount } = decodedLog.args as any;
          
          if (getAddress(reserve as string) !== getAddress(this.UNDERLYING_ASSET)) {
            return null;
          }

          return {
            chainId: CONSTANTS.CHAIN_IDS.SONIC,
            contractAddress: getAddress(this.POOL_ADDRESS),
            protocolName: 'stability',
            protocolType: 'lending',
            eventType: 'supply',
            userAddress: getAddress(onBehalfOf as string),
            amount: amount.toString(),
            shares: amount.toString(), 
            assets: amount.toString(),
            blockNumber: log.blockNumber,
            timestamp,
            txHash: log.transactionHash,
            logIndex: log.logIndex,
            rawData: decodedLog,
          };
        }

        case 'Withdraw': {
          const { reserve, to, amount } = decodedLog.args as any;
          
          if (getAddress(reserve as string) !== getAddress(this.UNDERLYING_ASSET)) {
            return null;
          }

          return {
            chainId: CONSTANTS.CHAIN_IDS.SONIC,
            contractAddress: getAddress(this.POOL_ADDRESS),
            protocolName: 'stability',
            protocolType: 'lending',
            eventType: 'withdraw',
            userAddress: getAddress(to as string),
            amount: amount.toString(),
            shares: amount.toString(), 
            assets: amount.toString(),
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
      logger.error('Failed to decode pool log to event:', error);
      return null;
    }
  }

  /**
   * Decodes an aToken log into a StabilityEvent object
   */
  private async decodeATokenLogToEvent(log: any, eventDate: string): Promise<StabilityEvent | null> {
    try {
      const decodedLog = decodeEventLog({
        abi: STABILITY_ATOKEN_ABI,
        data: log.data,
        topics: log.topics,
      });

      const timestamp = this.getEventTimestamp(eventDate);

      switch ((decodedLog as any).eventName) {
        case 'Transfer': {
          const { from, to, value } = decodedLog.args as any;
          
          const { checkZeroAddress } = require('../../config/contracts');
          if (checkZeroAddress(from) || checkZeroAddress(to)) {
            return null;
          }

          return {
            chainId: CONSTANTS.CHAIN_IDS.SONIC,
            contractAddress: getAddress(this.ATOKEN_ADDRESS),
            protocolName: 'stability',
            protocolType: 'lending',
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
      logger.error('Failed to decode aToken log to event:', error);
      return null;
    }
  }

  /**
   * Retrieves the current liquidity index from the Stability pool at a specific block
   */
  async getCurrentLiquidityIndex(blockNumber: number): Promise<bigint> {
    try {
      if (typeof blockNumber !== 'number' || !Number.isInteger(blockNumber) || blockNumber < 0) {
        throw new Error(`Invalid block number: ${blockNumber}. Must be a non-negative integer.`);
      }
      
      const sonicViemClient = this.alchemyService.getViemClient(CONSTANTS.CHAIN_IDS.SONIC);
      
      const liquidityIndex = await withAlchemyRetry(async () => {
        return await sonicViemClient.readContract({
          address: this.POOL_ADDRESS as `0x${string}`,
          abi: STABILITY_POOL_ABI,
          functionName: 'getReserveNormalizedIncome',
          args: [this.UNDERLYING_ASSET as `0x${string}`],
          blockNumber: BigInt(blockNumber)
        }) as bigint;
      }, `Stability liquidity index at block ${blockNumber}`);
      
      if (liquidityIndex <= 0n) {
        throw new Error(`Invalid liquidity index returned: ${liquidityIndex}`);
      }
      
      logger.debug(`Stability liquidity index at block ${blockNumber}: ${Number(liquidityIndex) / 1e27}`);
      return liquidityIndex;
      
    } catch (error) {
      const errorMessage = (error as Error).message;
      
      if (errorMessage.includes('returned no data ("0x")') || 
          errorMessage.includes('contract does not have the function') ||
          errorMessage.includes('address is not a contract')) {
        logger.warn(`Stability pool not deployed at block ${blockNumber}, skipping liquidity index calculation`);
        throw new Error(`Contract not deployed: ${errorMessage}`);
      }
      
      logger.error(`Failed to get liquidity index from Stability pool at block ${blockNumber}:`, error);
      throw new Error(`Unable to get Stability liquidity index: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Updates all Stability balances using the current liquidity index
   */
  async updateBalancesWithLiquidityIndex(blockNumber: number): Promise<void> {
    logger.info(`Updating Stability balances with liquidity index at block ${blockNumber}`);
    
    try {
      const liquidityIndex = await this.getCurrentLiquidityIndex(blockNumber);
      
      const positions = await this.db('integration_balances')
        .where({
          protocol_name: 'stability',
          chain_id: CONSTANTS.CHAIN_IDS.SONIC,
          contract_address: this.ATOKEN_ADDRESS.toLowerCase(),
        })
        .where('position_shares', '>', '0');

      let updatedPositions = 0;

      for (const position of positions) {
        const shares = BigInt(position.position_shares);
        const newUnderlyingAssets = (shares * liquidityIndex) / (10n ** 27n);
        
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

      logger.info(`Updated ${updatedPositions} Stability positions with liquidity index: ${Number(liquidityIndex) / 1e27}`);
    } catch (error) {
      const errorMessage = (error as Error).message;
      
      if (errorMessage.includes('Contract not deployed:')) {
        logger.warn(`Stability pool not deployed at block ${blockNumber}, skipping balance updates`);
        return;
      }
      
      logger.error('Failed to update Stability balances with liquidity index:', error);
      throw error;
    }
  }

  /**
   * Stores Stability events in the daily_integration_events table
   */
  private async storeEvents(events: StabilityEvent[], eventDate: string): Promise<void> {
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
      amount_delta: event.eventType === 'supply' ? (event.assets || '0') :
                    event.eventType === 'withdraw' ? `-${event.assets || '0'}` :
                    event.eventType === 'transfer' ? (event.shares || '0') : '0',
      shares_delta: event.eventType === 'supply' ? (event.shares || '0') :
                    event.eventType === 'withdraw' ? `-${event.shares || '0'}` :
                    event.eventType === 'transfer' ? (event.shares || '0') : '0',
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
      logger.debug('Skipping Stability events due to zero amount_delta');
      return;
    }

    const droppedCount = eventRecords.length - nonZeroEventRecords.length;
    if (droppedCount > 0) {
      logger.debug(`Dropped ${droppedCount} Stability events with zero amount_delta`);
    }

    await this.db('daily_integration_events')
      .insert(nonZeroEventRecords);
      
    logger.debug(`Stored ${nonZeroEventRecords.length} Stability events`);
  }

  /**
   * Updates a user's balance in the database based on share changes
   */
  private async updateUserBalance(userAddress: string, shareChange: bigint, blockNumber: number, eventDate: string): Promise<void> {
    const currentBalance = await this.db('integration_balances')
      .where({
        address: userAddress,
        chain_id: CONSTANTS.CHAIN_IDS.SONIC,
        contract_address: this.ATOKEN_ADDRESS.toLowerCase(),
        protocol_name: 'stability',
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
          protocol_name: 'stability',
          contract_address: this.ATOKEN_ADDRESS.toLowerCase(),
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
