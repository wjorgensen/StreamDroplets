/**
 * Shadow Exchange Balance Tracker
 * Tracks liquidity positions in Shadow Exchange pools on Sonic
 */

import { decodeEventLog, getAddress } from 'viem';
import { INTEGRATION_CONTRACTS, getTokenPosition } from '../../config/contracts';
import { SHADOW_PAIR_ABI } from '../../config/abis/shadowPair';
import { CONSTANTS } from '../../config/constants';
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
   * Verifies Shadow Exchange transfers and updates isIntegrationAddress field based on whether they are liquidity adds or swaps
   */
  async verifyShadowTransfers(
    eventDate: string,
    fromBlock: number,
    toBlock: number
  ): Promise<void> {
    logger.info(`Verifying Shadow Exchange transfers for ${eventDate}`);
    
    try {
      // Get all daily_events marked as 'shadow_to' or 'shadow_from' for this date range
      const shadowTransfers = await this.db('daily_events')
        .where('event_date', eventDate)
        .where(builder => {
          builder.where('isIntegrationAddress', 'shadow_to')
            .orWhere('isIntegrationAddress', 'shadow_from');
        })
        .whereBetween('block_number', [fromBlock, toBlock])
        .where('chain_id', CONSTANTS.CHAIN_IDS.SONIC);
      
      if (shadowTransfers.length === 0) {
        logger.debug('No Shadow transfers to verify');
        return;
      }
      
      // Get all liquidity mints from daily_integration_events for the same period
      const liquidityMints = await this.db('daily_integration_events')
        .where('event_date', eventDate)
        .where('protocol_name', 'shadow_exchange')
        .where('event_type', 'mint')
        .whereBetween('block_number', [fromBlock, toBlock])
        .where('chain_id', CONSTANTS.CHAIN_IDS.SONIC);
      
      // Create a map of mint transactions for quick lookup
      const mintTxMap = new Map<string, any>();
      for (const mint of liquidityMints) {
        const txKey = `${mint.tx_hash}_${mint.address.toLowerCase()}`;
        mintTxMap.set(txKey, mint);
      }
      
      // Process each shadow transfer
      for (const transfer of shadowTransfers) {
        if (transfer.isIntegrationAddress === 'shadow_to') {
          // Shadow contract is receiving tokens - check if it's a liquidity addition
          const txKey = `${transfer.tx_hash}_${transfer.to_address.toLowerCase()}`;
          
          if (mintTxMap.has(txKey)) {
            // This transfer corresponds to a liquidity mint - it's a liquidity addition
            await this.db('daily_events')
              .where('id', transfer.id)
              .update({ isIntegrationAddress: 'to' });
            
            logger.debug(`Marked transfer ${transfer.tx_hash} as liquidity addition`);
          } else {
            // This transfer doesn't have a corresponding mint - it's a DEX swap
            await this.db('daily_events')
              .where('id', transfer.id)
              .update({ isIntegrationAddress: null });
            
            logger.debug(`Marked transfer ${transfer.tx_hash} as DEX swap`);
          }
        } else if (transfer.isIntegrationAddress === 'shadow_from') {
          // Shadow contract is sending tokens - this is likely a liquidity withdrawal
          // Keep the shadow_from designation as this is legitimate shadow interaction
          logger.debug(`Keeping transfer ${transfer.tx_hash} as shadow withdrawal`);
        }
      }
      
      logger.info(`Verified ${shadowTransfers.length} Shadow transfers`);
      
    } catch (error) {
      logger.error('Failed to verify Shadow transfers:', error);
      throw error;
    }
  }

  // Process Shadow Exchange events for a block range
  async processShadowEvents(
    fromBlock: number,
    toBlock: number,
    eventDate: string
  ): Promise<void> {
    logger.info(`Processing Shadow Exchange events from blocks ${fromBlock} to ${toBlock}`);
    
    try {
      const events = await this.fetchPoolEvents(fromBlock, toBlock);
      
      if (events.length === 0) {
        logger.debug('No Shadow Exchange events found in block range');
        return;
      }
      
      await this.storeEvents(events, eventDate);
      await this.updateUserBalances(events, eventDate);
      
      await this.verifyShadowTransfers(eventDate, fromBlock, toBlock);
      
      logger.info(`Processed ${events.length} Shadow Exchange events`);
    } catch (error) {
      logger.error('Failed to process Shadow Exchange events:', error);
      throw error;
    }
  }

  // Fetch events from both Shadow pools in parallel
  private async fetchPoolEvents(
    fromBlock: number,
    toBlock: number
  ): Promise<ShadowEvent[]> {
    const allEvents: ShadowEvent[] = [];

    try {
      const poolPromises = this.SHADOW_POOLS.map(poolAddress => 
        this.fetchSinglePoolEvents(poolAddress, fromBlock, toBlock)
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

  // Fetch events from a single Shadow pool
  private async fetchSinglePoolEvents(
    poolAddress: string,
    fromBlock: number,
    toBlock: number
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
          const event = await this.decodeLogToEvent(log, poolAddress);
          if (event) {
            events.push(event);
          }
        } catch (decodeError) {
          logger.warn(`Failed to decode log at ${log.transactionHash}:${log.logIndex}:`, decodeError);
        }
      }

      logger.debug(`Fetched ${events.length} events from pool ${poolAddress}`);
      return events;
    } catch (error) {
      logger.error(`Failed to fetch events from pool ${poolAddress}:`, error);
      return [];
    }
  }

  // Decode a blockchain log to a ShadowEvent
  private async decodeLogToEvent(log: any, poolAddress: string): Promise<ShadowEvent | null> {
    try {
      const decodedLog = decodeEventLog({
        abi: SHADOW_PAIR_ABI,
        data: log.data,
        topics: log.topics,
      });

      const timestamp = new Date();

      switch ((decodedLog as any).eventName) {
        case 'Mint': {
          const { sender, amount0, amount1 } = decodedLog.args as any;
          
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
            return {
              chainId: CONSTANTS.CHAIN_IDS.SONIC,
              contractAddress: getAddress(poolAddress),
              protocolName: 'shadow_exchange',
              protocolType: 'lp',
              eventType: 'transfer',
              userAddress: getAddress(to as string),
              amount: value.toString(),
              fromAddress: getAddress(from as string),
              toAddress: getAddress(to as string),
              blockNumber: log.blockNumber,
              timestamp,
              txHash: log.transactionHash,
              logIndex: log.logIndex,
              rawData: decodedLog,
            };
          }
        }

        default:
          logger.warn(`Unknown event type: ${decodedLog.eventName}`);
          return null;
      }
    } catch (error) {
      logger.error('Failed to decode log to event:', error);
      return null;
    }
    
    return null;
  }

  // Get xUSD amount represented by LP tokens using actual pair balances
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
      
      // Get xUSD address from environment
      const xusdAddress = process.env.XUSD_TOKEN_ADDRESS_SONIC;
      if (!xusdAddress) {
        throw new Error('XUSD_TOKEN_ADDRESS_SONIC not configured in environment');
      }
      
      // Get xUSD token balance held by the pair
      const xusdBalanceAtPair = await withAlchemyRetry(async () => {
        return await sonicViemClient.readContract({
          address: xusdAddress as `0x${string}`,
          abi: [{ type: 'function', name: 'balanceOf', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] }],
          functionName: 'balanceOf',
          args: [poolAddress]
        }) as bigint;
      }, `xUSD balance for Shadow Exchange pool ${poolAddress}`);
      
      // Calculate pro-rata xUSD amount
      const xusdAmount = (xusdBalanceAtPair * lpTokenAmount) / totalSupply;
      
      return xusdAmount;
      
    } catch (error) {
      const errorMessage = (error as Error).message;
      
      // Check if this is a contract not deployed error
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

  // Store Shadow Exchange events in database
  private async storeEvents(events: ShadowEvent[], eventDate: string): Promise<void> {
    if (events.length === 0) return;
    
    const eventRecords = events.map(event => {
      let amountDelta = '0';
      
      if (event.eventType === 'mint' || event.eventType === 'burn') {
        // Calculate xUSD amount based on token position
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

    await this.db('daily_integration_events')
      .insert(eventRecords)
      .onConflict(['chain_id', 'tx_hash', 'log_index'])
      .ignore();
      
    logger.debug(`Stored ${eventRecords.length} Shadow events`);
  }

  // Update user balances based on processed events
  private async updateUserBalances(events: ShadowEvent[], eventDate: string): Promise<void> {
    const userEvents = new Map<string, ShadowEvent[]>();
    for (const event of events) {
      const userKey = `${event.userAddress.toLowerCase()}_${event.contractAddress.toLowerCase()}`;
      if (!userEvents.has(userKey)) {
        userEvents.set(userKey, []);
      }
      userEvents.get(userKey)!.push(event);
    }

    for (const [userKey, userEventList] of userEvents) {
      const [userAddress, poolAddress] = userKey.split('_');
      let netShareChange = 0n;
      let netAssetChange = 0n;
      
      const processedTxs = new Set<string>();
      
      for (const event of userEventList) {
        const txKey = `${event.txHash}_${event.logIndex}`;
        if (processedTxs.has(txKey)) continue;
        processedTxs.add(txKey);
        
        const delta = event.eventType === 'mint' ? BigInt(event.amount || '0') :
                      event.eventType === 'burn' ? -BigInt(event.amount || '0') :
                      event.eventType === 'transfer' ? BigInt(event.amount || '0') : 0n;
        
        netShareChange += delta;
        
        if (event.eventType === 'mint' && event.token0Amount && event.token1Amount) {
          // Use only xUSD amount based on token position
          const xusdTokenPosition = getTokenPosition(event.contractAddress);
          if (xusdTokenPosition !== undefined) {
            const xusdAmount = xusdTokenPosition === 0 ? BigInt(event.token0Amount) : BigInt(event.token1Amount);
            netAssetChange += xusdAmount;
          }
        } else if (event.eventType === 'burn' && event.token0Amount && event.token1Amount) {
          // Use only xUSD amount based on token position
          const xusdTokenPosition = getTokenPosition(event.contractAddress);
          if (xusdTokenPosition !== undefined) {
            const xusdAmount = xusdTokenPosition === 0 ? BigInt(event.token0Amount) : BigInt(event.token1Amount);
            netAssetChange -= xusdAmount;
          }
        }
      }

      if (netShareChange !== 0n) {
        await this.updateUserBalance(userAddress, poolAddress, netShareChange, netAssetChange, userEventList[0].blockNumber, eventDate);
      }
    }
  }

  // Update a single user's balance in database
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

}
