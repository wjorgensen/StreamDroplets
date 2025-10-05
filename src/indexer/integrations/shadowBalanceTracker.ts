/**
 * Shadow Exchange Balance Tracker
 * Tracks liquidity positions in Shadow Exchange pools on Sonic
 */

import { decodeEventLog, getAddress } from 'viem';
import { INTEGRATION_CONTRACTS, getTokenPosition } from '../../config/contracts';
import { SHADOW_PAIR_ABI } from '../../config/abis/shadowPair';
import { CONSTANTS, BlockRange } from '../../config/constants';
import { createLogger } from '../../utils/logger';
import { getDb } from '../../db/connection';
import { AlchemyService } from '../../utils/AlchemyService';
import { withAlchemyRetry } from '../../utils/retryUtils';

const logger = createLogger('ShadowBalanceTracker');

export interface ShadowEvent {
  chainId: number;
  contractAddress: string;
  protocolName: 'shadow_exchange';
  protocolType: 'lp';
  eventType: 'mint' | 'burn' | 'transfer';
  userAddress: string;
  amount?: string;
  token0Amount?: string;
  token1Amount?: string;
  fromAddress?: string;
  toAddress?: string;
  blockNumber: number;
  timestamp: Date;
  txHash: string;
  logIndex: number;
  rawData: any;
}


export class ShadowBalanceTracker {
  private readonly SHADOW_POOLS = [
    INTEGRATION_CONTRACTS.SHADOW_EXCHANGE.SONIC.XUSD_HLP0_POOL,
    INTEGRATION_CONTRACTS.SHADOW_EXCHANGE.SONIC.XUSD_ASONUSDC_POOL
  ].filter(pool => pool && pool.length > 0); // Filter out empty addresses
  private readonly db = getDb();
  private alchemyService: AlchemyService;

  constructor() {
    this.alchemyService = AlchemyService.getInstance();
    logger.info('Initialized Shadow Balance Tracker');
  }

  /**
   * Converts an event date string to a Date object with UTC midnight timestamp
   */
  private getEventTimestamp(eventDate: string): Date {
    return new Date(`${eventDate}T00:00:00.000Z`);
  }
  
  /**
   * Verifies Shadow Exchange transfers and classifies them as liquidity operations or swaps
   */
  async verifyShadowTransfers(
    eventDate: string,
    fromBlock: number,
    toBlock: number
  ): Promise<void> {
    logger.info(`Verifying Shadow Exchange transfers for ${eventDate}`);
    
    try {
      const shadowTransfers = await this.db('daily_events')
        .where('event_date', eventDate)
        .where(builder => {
          builder.where('isIntegrationAddress', 'shadow_to')
            .orWhere('isIntegrationAddress', 'shadow_from')
            .orWhere('isIntegrationAddress', 'shadow_pending_to')
            .orWhere('isIntegrationAddress', 'shadow_pending_from');
        })
        .whereBetween('block_number', [fromBlock, toBlock])
        .where('chain_id', CONSTANTS.CHAIN_IDS.SONIC);
      
      if (shadowTransfers.length === 0) {
        logger.debug('No Shadow transfers to verify');
        return;
      }
      
      const liquidityEvents = await this.db('daily_integration_events')
        .where('event_date', eventDate)
        .where('protocol_name', 'shadow_exchange')
        .whereIn('event_type', ['mint', 'burn'])
        .whereBetween('block_number', [fromBlock, toBlock])
        .where('chain_id', CONSTANTS.CHAIN_IDS.SONIC);
      
      const mintTxMap = new Map<string, any>();
      const burnTxMap = new Map<string, any>();
      
      for (const event of liquidityEvents) {
        const txKey = `${event.tx_hash}_${event.address.toLowerCase()}_${this.normalizeAmount(event.amount_delta)}`;
        
        if (event.event_type === 'mint') {
          mintTxMap.set(txKey, event);
        } else if (event.event_type === 'burn') {
          burnTxMap.set(txKey, event);
        }
      }
      
      for (const transfer of shadowTransfers) {
        const normalizedAmount = this.normalizeAmount(transfer.amount_delta);
        
        if (transfer.isIntegrationAddress === 'shadow_pending_to') {
          const userAddress = transfer.from_address.toLowerCase();
          const txKey = `${transfer.tx_hash}_${userAddress}_${normalizedAmount}`;
          
          if (mintTxMap.has(txKey)) {
            await this.db('daily_events')
              .where('id', transfer.id)
              .update({ isIntegrationAddress: 'to' });
            
            logger.debug(`Marked router transfer ${transfer.tx_hash} as liquidity addition`);
          } else {
            await this.db('daily_events')
              .where('id', transfer.id)
              .update({ isIntegrationAddress: null });
            
            logger.debug(`Marked router transfer ${transfer.tx_hash} as swap input`);
          }
        } else if (transfer.isIntegrationAddress === 'shadow_pending_from') {
          const userAddress = transfer.to_address.toLowerCase();
          const txKey = `${transfer.tx_hash}_${userAddress}_${normalizedAmount}`;
          
          if (burnTxMap.has(txKey)) {
            await this.db('daily_events')
              .where('id', transfer.id)
              .update({ isIntegrationAddress: 'from' });
            
            logger.debug(`Marked router transfer ${transfer.tx_hash} as liquidity withdrawal`);
          } else {
            await this.db('daily_events')
              .where('id', transfer.id)
              .update({ isIntegrationAddress: null });
            
            logger.debug(`Marked router transfer ${transfer.tx_hash} as swap output`);
          }
        } else if (transfer.isIntegrationAddress === 'shadow_to') {
          const userAddress = transfer.from_address.toLowerCase();
          const txKey = `${transfer.tx_hash}_${userAddress}_${normalizedAmount}`;
          
          if (mintTxMap.has(txKey)) {
            await this.db('daily_events')
              .where('id', transfer.id)
              .update({ isIntegrationAddress: 'to' });
            
            logger.debug(`Marked direct pool transfer ${transfer.tx_hash} as liquidity addition`);
          } else {
            await this.db('daily_events')
              .where('id', transfer.id)
              .update({ isIntegrationAddress: null });
            
            logger.debug(`Marked direct pool transfer ${transfer.tx_hash} as DEX swap`);
          }
        } else if (transfer.isIntegrationAddress === 'shadow_from') {
          logger.debug(`Keeping direct pool transfer ${transfer.tx_hash} as shadow withdrawal`);
        }
      }
      
      logger.info(`Verified ${shadowTransfers.length} Shadow transfers`);
      
    } catch (error) {
      logger.error('Failed to verify Shadow transfers:', error);
      throw error;
    }
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
   * Fetches and stores Shadow Exchange events for a block range
   */
  async fetchEventsForRange(
    fromBlock: number,
    toBlock: number,
    eventDate: string
  ): Promise<void> {
    logger.info(`Fetching Shadow Exchange events from blocks ${fromBlock} to ${toBlock}`);
    
    try {
      const events = await this.fetchPoolEvents(fromBlock, toBlock, eventDate);
      
      if (events.length === 0) {
        logger.debug('No Shadow Exchange events found in block range');
        return;
      }
      
      await this.storeEvents(events, eventDate);
      
      logger.info(`Stored ${events.length} Shadow Exchange events`);
    } catch (error) {
      logger.error('Failed to fetch Shadow Exchange events:', error);
      throw error;
    }
  }

  /**
   * Processes stored Shadow Exchange events to update user balances
   */
  async processEventsForRange(range: BlockRange, eventDate: string): Promise<void> {
    if (range.chainId !== CONSTANTS.CHAIN_IDS.SONIC) {
      logger.warn(`Shadow Exchange not supported on chain ${range.chainId}`);
      return;
    }

    logger.info(`Processing stored Shadow events for blocks ${range.fromBlock} to ${range.toBlock}`);

    const records = await this.db('daily_integration_events')
      .where({
        event_date: eventDate,
        protocol_name: 'shadow_exchange',
        chain_id: range.chainId,
      })
      .whereBetween('block_number', [range.fromBlock, range.toBlock])
      .orderBy('block_number')
      .orderBy('tx_hash')
      .orderBy('log_index');

    if (records.length === 0) {
      logger.debug('No stored Shadow events found for processing');
      return;
    }

    const aggregates = new Map<string, {
      shareDelta: bigint;
      assetDelta: bigint;
      lastBlock: number;
    }>();

    for (const record of records) {
      const key = `${record.address}_${record.contract_address}`;
      const shareDelta = this.toBigInt(record.shares_delta);
      const eventType = record.event_type as string;
      const assetDelta = (eventType === 'mint' || eventType === 'burn')
        ? this.toBigInt(record.amount_delta)
        : 0n;

      if (shareDelta === 0n && assetDelta === 0n) {
        continue;
      }

      const existing = aggregates.get(key);
      if (existing) {
        aggregates.set(key, {
          shareDelta: existing.shareDelta + shareDelta,
          assetDelta: existing.assetDelta + assetDelta,
          lastBlock: Math.max(existing.lastBlock, record.block_number ?? 0),
        });
      } else {
        aggregates.set(key, {
          shareDelta,
          assetDelta,
          lastBlock: record.block_number ?? 0,
        });
      }
    }

    if (aggregates.size === 0) {
      logger.debug('No balance changes derived from stored Shadow events');
      return;
    }

    for (const [key, aggregate] of aggregates.entries()) {
      if (aggregate.shareDelta === 0n && aggregate.assetDelta === 0n) {
        continue;
      }

      const [address, contractAddress] = key.split('_');
      await this.updateUserBalance(
        address,
        contractAddress,
        aggregate.shareDelta,
        aggregate.assetDelta,
        aggregate.lastBlock,
        eventDate
      );
    }

    await this.verifyShadowTransfers(eventDate, range.fromBlock, range.toBlock);

    logger.info(`Applied Shadow balance updates for ${aggregates.size} address(es)`);
  }

  /**
   * Fetches events from all Shadow Exchange pools in parallel
   */
  private async fetchPoolEvents(
    fromBlock: number,
    toBlock: number,
    eventDate: string
  ): Promise<ShadowEvent[]> {
    const allEvents: ShadowEvent[] = [];

    try {
      const poolPromises = this.SHADOW_POOLS.map(poolAddress => 
        this.fetchSinglePoolEvents(poolAddress, fromBlock, toBlock, eventDate)
      );
      
      const poolResults = await Promise.all(poolPromises);
      
      for (const events of poolResults) {
        allEvents.push(...events);
      }

      logger.debug(`Fetched ${allEvents.length} total events from Shadow pools`);
      return allEvents;
    } catch (error) {
      logger.error('Failed to fetch events from Shadow pools:', error);
      return [];
    }
  }

  /**
   * Fetches events from a single Shadow Exchange pool
   */
  private async fetchSinglePoolEvents(
    poolAddress: string,
    fromBlock: number,
    toBlock: number,
    eventDate: string
  ): Promise<ShadowEvent[]> {
    const events: ShadowEvent[] = [];

    try {
      const sonicAlchemy = this.alchemyService.getAlchemyInstance(CONSTANTS.CHAIN_IDS.SONIC);
      const logs = await withAlchemyRetry(async () => {
        return await sonicAlchemy.core.getLogs({
          address: poolAddress,
          fromBlock,
          toBlock,
        });
      }, `Shadow Exchange getLogs for pool ${poolAddress} (blocks ${fromBlock}-${toBlock})`);

      for (const log of logs) {
        try {
          const event = await this.decodeLogToEvent(log, poolAddress, eventDate);
          if (event) {
            events.push(event);
          }
        } catch (decodeError) {
          // Silently skip logs we can't decode (expected for unrelated events)
        }
      }

      logger.debug(`Fetched ${events.length} events from pool ${poolAddress}`);
      return events;
    } catch (error) {
      logger.error(`Failed to fetch events from pool ${poolAddress}:`, error);
      return [];
    }
  }

  /**
   * Decodes a blockchain log into a ShadowEvent object
   */
  private async decodeLogToEvent(log: any, poolAddress: string, eventDate: string): Promise<ShadowEvent | null> {
    try {
      const decodedLog = decodeEventLog({
        abi: SHADOW_PAIR_ABI,
        data: log.data,
        topics: log.topics,
      });

      switch ((decodedLog as any).eventName) {
        case 'Mint': {
          const { sender, amount0, amount1 } = decodedLog.args as any;
          const timestamp = this.getEventTimestamp(eventDate);
          
          return {
            chainId: CONSTANTS.CHAIN_IDS.SONIC,
            contractAddress: getAddress(poolAddress),
            protocolName: 'shadow_exchange',
            protocolType: 'lp',
            eventType: 'mint',
            userAddress: getAddress(sender as string),
            token0Amount: amount0.toString(),
            token1Amount: amount1.toString(),
            blockNumber: log.blockNumber,
            timestamp,
            txHash: log.transactionHash,
            logIndex: log.logIndex,
            rawData: decodedLog,
          };
        }

        case 'Burn': {
          const { amount0, amount1, to } = decodedLog.args as any;
          const timestamp = this.getEventTimestamp(eventDate);
          
          return {
            chainId: CONSTANTS.CHAIN_IDS.SONIC,
            contractAddress: getAddress(poolAddress),
            protocolName: 'shadow_exchange',
            protocolType: 'lp',
            eventType: 'burn',
            userAddress: getAddress(to as string),
            token0Amount: amount0.toString(),
            token1Amount: amount1.toString(),
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
          const isFromZero = checkZeroAddress(from);
          const isToZero = checkZeroAddress(to);
          const timestamp = this.getEventTimestamp(eventDate);
          
          if (isFromZero) {
            return {
              chainId: CONSTANTS.CHAIN_IDS.SONIC,
              contractAddress: getAddress(poolAddress),
              protocolName: 'shadow_exchange',
              protocolType: 'lp',
              eventType: 'mint',
              userAddress: getAddress(to as string),
              amount: value.toString(),
              blockNumber: log.blockNumber,
              timestamp,
              txHash: log.transactionHash,
              logIndex: log.logIndex,
              rawData: decodedLog,
            };
          } else if (isToZero) {
            return {
              chainId: CONSTANTS.CHAIN_IDS.SONIC,
              contractAddress: getAddress(poolAddress),
              protocolName: 'shadow_exchange',
              protocolType: 'lp',
              eventType: 'burn',
              userAddress: getAddress(from as string),
              amount: value.toString(),
              blockNumber: log.blockNumber,
              timestamp,
              txHash: log.transactionHash,
              logIndex: log.logIndex,
              rawData: decodedLog,
            };
          } else {
            const fromAddress = getAddress(from as string);
            const toAddress = getAddress(to as string);
            const fromIsShadowPool = this.SHADOW_POOLS.some(pool => getAddress(pool) === fromAddress);
            const toIsShadowPool = this.SHADOW_POOLS.some(pool => getAddress(pool) === toAddress);
            
            if (fromIsShadowPool && toIsShadowPool) {
              logger.debug('Skipping LP transfer between Shadow pools', {
                from: fromAddress,
                to: toAddress,
                txHash: log.transactionHash,
                logIndex: log.logIndex,
              });
              return null;
            }
            
            return {
              chainId: CONSTANTS.CHAIN_IDS.SONIC,
              contractAddress: getAddress(poolAddress),
              protocolName: 'shadow_exchange',
              protocolType: 'lp',
              eventType: 'transfer',
              userAddress: getAddress(to as string),
              amount: value.toString(),
              fromAddress: fromAddress,
              toAddress: toAddress,
              blockNumber: log.blockNumber,
              timestamp,
              txHash: log.transactionHash,
              logIndex: log.logIndex,
              rawData: decodedLog,
            };
          }
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
   * Calculates the xUSD value of LP tokens based on pool reserves
   */
  async getLPTokenValue(poolAddress: string, lpTokenAmount: bigint): Promise<bigint> {
    try {
      const sonicViemClient = this.alchemyService.getViemClient(CONSTANTS.CHAIN_IDS.SONIC);
      
      const totalSupply = await withAlchemyRetry(async () => {
        return await sonicViemClient.readContract({
          address: poolAddress as `0x${string}`,
          abi: SHADOW_PAIR_ABI,
          functionName: 'totalSupply'
        }) as bigint;
      }, `Shadow Exchange totalSupply for pool ${poolAddress}`);
      
      if (totalSupply === 0n) {
        return 0n;
      }
      
      const xusdAddress = process.env.XUSD_TOKEN_ADDRESS_SONIC;
      if (!xusdAddress) {
        throw new Error('XUSD_TOKEN_ADDRESS_SONIC not configured in environment');
      }
      
      const xusdBalanceAtPair = await withAlchemyRetry(async () => {
        return await sonicViemClient.readContract({
          address: xusdAddress as `0x${string}`,
          abi: [{ type: 'function', name: 'balanceOf', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] }],
          functionName: 'balanceOf',
          args: [poolAddress]
        }) as bigint;
      }, `xUSD balance for Shadow Exchange pool ${poolAddress}`);
      
      const xusdAmount = (xusdBalanceAtPair * lpTokenAmount) / totalSupply;
      
      return xusdAmount;
      
    } catch (error) {
      const errorMessage = (error as Error).message;
      
      if (errorMessage.includes('returned no data ("0x")') || 
          errorMessage.includes('contract does not have the function') ||
          errorMessage.includes('address is not a contract')) {
        logger.warn(`Shadow Exchange pool ${poolAddress} not deployed, skipping LP token value calculation`);
        throw new Error(`Contract not deployed: ${errorMessage}`);
      }
      
      logger.error(`Failed to get LP token value for pool ${poolAddress}:`, error);
      throw new Error(`Unable to calculate LP token value: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Resolves actual user addresses from daily_events for router-mediated transactions
   */
  private async resolveUserAddresses(
    eventRecords: any[],
    eventDate: string
  ): Promise<any[]> {
    const routerAddress = INTEGRATION_CONTRACTS.SHADOW_EXCHANGE.SONIC.ROUTER.toLowerCase();
    const needsResolution = eventRecords.filter(
      record => record.address === routerAddress && (record.event_type === 'mint' || record.event_type === 'burn')
    );

    if (needsResolution.length === 0) {
      return eventRecords;
    }

    const pendingTransfers = await this.db('daily_events')
      .where('event_date', eventDate)
      .where(builder => {
        builder.where('isIntegrationAddress', 'shadow_pending_to')
          .orWhere('isIntegrationAddress', 'shadow_pending_from');
      })
      .where('chain_id', CONSTANTS.CHAIN_IDS.SONIC)
      .select('tx_hash', 'from_address', 'to_address', 'amount_delta', 'isIntegrationAddress');

    const pendingToMap = new Map<string, any>();
    const pendingFromMap = new Map<string, any>();

    for (const transfer of pendingTransfers) {
      const normalizedAmount = this.normalizeAmount(transfer.amount_delta);
      const key = `${transfer.tx_hash}_${normalizedAmount}`;

      if (transfer.isIntegrationAddress === 'shadow_pending_to') {
        pendingToMap.set(key, transfer);
      } else if (transfer.isIntegrationAddress === 'shadow_pending_from') {
        pendingFromMap.set(key, transfer);
      }
    }

    const resolvedRecords = eventRecords.map(record => {
      if (record.address !== routerAddress) {
        return record;
      }

      const normalizedAmount = this.normalizeAmount(record.amount_delta);
      const key = `${record.tx_hash}_${normalizedAmount}`;

      if (record.event_type === 'mint') {
        const pendingTransfer = pendingToMap.get(key);
        if (pendingTransfer) {
          logger.debug(`Resolved mint user address from router to ${pendingTransfer.from_address}`, {
            tx_hash: record.tx_hash,
            amount: normalizedAmount
          });
          return {
            ...record,
            address: pendingTransfer.from_address.toLowerCase(),
          };
        } else {
          logger.warn(`Could not resolve user address for mint event`, {
            tx_hash: record.tx_hash,
            amount: normalizedAmount,
            router_address: routerAddress
          });
        }
      } else if (record.event_type === 'burn') {
        const pendingTransfer = pendingFromMap.get(key);
        if (pendingTransfer) {
          logger.debug(`Resolved burn user address from router to ${pendingTransfer.to_address}`, {
            tx_hash: record.tx_hash,
            amount: normalizedAmount
          });
          return {
            ...record,
            address: pendingTransfer.to_address.toLowerCase(),
          };
        } else {
          logger.warn(`Could not resolve user address for burn event`, {
            tx_hash: record.tx_hash,
            amount: normalizedAmount,
            router_address: routerAddress
          });
        }
      }

      return record;
    });

    return resolvedRecords;
  }

  /**
   * Stores Shadow Exchange events in the daily_integration_events table
   */
  private async storeEvents(events: ShadowEvent[], eventDate: string): Promise<void> {
    if (events.length === 0) return;
    
    const eventRecords = events.map(event => {
      let amountDelta = '0';
      
      if (event.eventType === 'mint' || event.eventType === 'burn') {
        const xusdTokenPosition = getTokenPosition(event.contractAddress);
        if (event.token0Amount && event.token1Amount && xusdTokenPosition !== undefined) {
          const xusdAmount = xusdTokenPosition === 0 ? BigInt(event.token0Amount) : BigInt(event.token1Amount);
          amountDelta = event.eventType === 'mint' ? xusdAmount.toString() : `-${xusdAmount.toString()}`;
        }
      }
      
      return {
        address: event.userAddress.toLowerCase(),
        asset: 'xUSD',
        chain_id: event.chainId,
        protocol_name: event.protocolName,
        protocol_type: event.protocolType,
        contract_address: event.contractAddress.toLowerCase(),
        event_date: eventDate,
        event_type: event.eventType,
        amount_delta: amountDelta,
        shares_delta: event.eventType === 'mint' ? (event.amount || '0') :
                      event.eventType === 'burn' ? `-${event.amount || '0'}` :
                      event.eventType === 'transfer' ? (event.amount || '0') : '0',
        block_number: event.blockNumber,
        timestamp: event.timestamp,
        tx_hash: event.txHash,
        log_index: event.logIndex,
        counterparty_address: event.fromAddress?.toLowerCase() || null,
      };
    });

    const nonZeroEventRecords = eventRecords.filter((record) => {
      try {
        return BigInt(record.amount_delta) !== 0n;
      } catch {
        logger.warn('Failed to parse amount_delta, excluding record', { 
          amount_delta: record.amount_delta,
          tx_hash: record.tx_hash 
        });
        return false;
      }
    });

    if (nonZeroEventRecords.length === 0) {
      logger.debug('Skipping Shadow events due to zero amount_delta');
      return;
    }

    const droppedCount = eventRecords.length - nonZeroEventRecords.length;
    if (droppedCount > 0) {
      logger.debug(`Dropped ${droppedCount} Shadow events with zero amount_delta`);
    }

    const resolvedRecords = await this.resolveUserAddresses(nonZeroEventRecords, eventDate);

    await this.db('daily_integration_events')
      .insert(resolvedRecords);
      
    logger.debug(`Stored ${resolvedRecords.length} Shadow events`);
  }

  /**
   * Updates a user's balance in the database based on share and asset changes
   */
  private async updateUserBalance(userAddress: string, poolAddress: string, shareChange: bigint, assetChange: bigint, blockNumber: number, eventDate: string): Promise<void> {
    const currentBalance = await this.db('integration_balances')
      .where({
        address: userAddress,
        chain_id: CONSTANTS.CHAIN_IDS.SONIC,
        contract_address: poolAddress,
        protocol_name: 'shadow_exchange',
      })
      .first();

    const currentShares = currentBalance ? BigInt(currentBalance.position_shares) : 0n;
    const currentAssets = currentBalance ? BigInt(currentBalance.underlying_assets) : 0n;
    
    const newShares = currentShares + shareChange;
    const newAssets = currentAssets + assetChange;

    if (newShares < 0n) {
      logger.warn(`Negative balance detected for ${userAddress}: ${newShares}`);
    }

    if (currentBalance) {
      await this.db('integration_balances')
        .where({ id: currentBalance.id })
        .update({
          position_shares: newShares.toString(),
          underlying_assets: newAssets.toString(),
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
          protocol_name: 'shadow_exchange',
          contract_address: poolAddress,
          position_shares: newShares.toString(),
          underlying_assets: newAssets.toString(),
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
