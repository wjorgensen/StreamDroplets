/**
 * Stability Balance Tracker
 * Tracks lending positions in Stability Protocol (AAVE v3 clone) on Sonic
 */

import { decodeEventLog, getAddress } from 'viem';
import { CONSTANTS } from '../../config/constants';
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
  amount?: string; // For supply/withdraw this is the underlying amount; for transfer this is aToken amount
  shares?: string; // For all events, this is the aToken amount (shares)
  assets?: string; // For supply/withdraw, this is the underlying assets amount
  fromAddress?: string; // For transfers
  toAddress?: string; // For transfers
  blockNumber: number;
  timestamp: Date;
  txHash: string;
  logIndex: number;
  rawData: any;
}

export class StabilityBalanceTracker {
  private readonly POOL_ADDRESS = INTEGRATION_CONTRACTS.STABILITY.SONIC.POOL;
  private readonly ATOKEN_ADDRESS = INTEGRATION_CONTRACTS.STABILITY.SONIC.XUSD_ATOKEN;
  private readonly UNDERLYING_ASSET = CONTRACTS.xUSD.sonic; // xUSD token address on Sonic
  private readonly db = getDb();
  private alchemyService: AlchemyService;

  constructor() {
    this.alchemyService = AlchemyService.getInstance();
    logger.info('Initialized Stability Balance Tracker');
  }

  /**
   * Fetch and process all Stability events for a specific block range
   */
  async processStabilityEvents(
    fromBlock: number,
    toBlock: number,
    eventDate: string
  ): Promise<void> {
    logger.info(`Processing Stability events from blocks ${fromBlock} to ${toBlock}`);
    
    try {
      const [poolEvents, aTokenEvents] = await Promise.all([
        this.fetchPoolEvents(fromBlock, toBlock),
        this.fetchATokenEvents(fromBlock, toBlock)
      ]);
      
      const allEvents = [...poolEvents, ...aTokenEvents];
      
      if (allEvents.length === 0) {
        logger.debug('No Stability events found in block range');
        return;
      }
      
      await this.storeEvents(allEvents, eventDate);
      await this.updateUserBalances(allEvents, eventDate);
      
      logger.info(`Processed ${allEvents.length} Stability events (${poolEvents.length} pool, ${aTokenEvents.length} aToken)`);
    } catch (error) {
      logger.error('Failed to process Stability events:', error);
      throw error;
    }
  }

  /**
   * Fetch events from the Stability pool contract (Supply/Withdraw)
   */
  private async fetchPoolEvents(
    fromBlock: number,
    toBlock: number
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
          const event = await this.decodePoolLogToEvent(log);
          if (event) {
            events.push(event);
          }
        } catch (decodeError) {
          logger.warn(`Failed to decode pool log at ${log.transactionHash}:${log.logIndex}:`, decodeError);
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
   * Fetch events from the aToken contract (Transfer)
   */
  private async fetchATokenEvents(
    fromBlock: number,
    toBlock: number
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
          const event = await this.decodeATokenLogToEvent(log);
          if (event) {
            events.push(event);
          }
        } catch (decodeError) {
          logger.warn(`Failed to decode aToken log at ${log.transactionHash}:${log.logIndex}:`, decodeError);
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
   * Decode a pool log to a StabilityEvent
   */
  private async decodePoolLogToEvent(log: any): Promise<StabilityEvent | null> {
    try {
      const decodedLog = decodeEventLog({
        abi: STABILITY_POOL_ABI,
        data: log.data,
        topics: log.topics,
      });

      const timestamp = new Date();

      switch ((decodedLog as any).eventName) {
        case 'Supply': {
          const { reserve, onBehalfOf, amount } = decodedLog.args as any;
          
          // Only track xUSD supply events
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
          
          // Only track xUSD withdraw events
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
          // Ignore other events
          return null;
      }
    } catch (error) {
      logger.error('Failed to decode pool log to event:', error);
      return null;
    }
  }

  /**
   * Decode an aToken log to a StabilityEvent
   */
  private async decodeATokenLogToEvent(log: any): Promise<StabilityEvent | null> {
    try {
      const decodedLog = decodeEventLog({
        abi: STABILITY_ATOKEN_ABI,
        data: log.data,
        topics: log.topics,
      });

      const timestamp = new Date();

      switch ((decodedLog as any).eventName) {
        case 'Transfer': {
          const { from, to, value } = decodedLog.args as any;
          
          // Skip mint/burn operations (to/from zero address)
          const { checkZeroAddress } = require('../../config/contracts');
          if (checkZeroAddress(from) || checkZeroAddress(to)) {
            return null;
          }

          // For now, we'll track the transfer to the recipient
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
          // Ignore other aToken events for now
          return null;
      }
    } catch (error) {
      logger.error('Failed to decode aToken log to event:', error);
      return null;
    }
  }

  async getCurrentLiquidityIndex(blockNumber: number): Promise<bigint> {
    try {
      // Validate block number
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
      
      // Check if this is a contract not deployed error
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
        // AAVE uses 1e27 scaling for liquidity index
        const newUnderlyingAssets = (shares * liquidityIndex) / (10n ** 27n);
        
        const currentUnderlying = BigInt(position.underlying_assets || '0');
        const changeThreshold = currentUnderlying / 1000n; // 0.1% threshold

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
      
      // Check if this is a contract not deployed error
      if (errorMessage.includes('Contract not deployed:')) {
        logger.warn(`Stability pool not deployed at block ${blockNumber}, skipping balance updates`);
        return;
      }
      
      logger.error('Failed to update Stability balances with liquidity index:', error);
      throw error;
    }
  }

  /**
   * Store events in the daily_integration_events table
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

    await this.db('daily_integration_events')
      .insert(eventRecords)
      .onConflict(['chain_id', 'tx_hash', 'log_index'])
      .ignore();
      
    logger.debug(`Stored ${eventRecords.length} Stability events`);
  }

  /**
   * Update user balances based on events
   */
  private async updateUserBalances(events: StabilityEvent[], eventDate: string): Promise<void> {
    const userEvents = new Map<string, StabilityEvent[]>();
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
        const delta = event.eventType === 'supply' ? BigInt(event.shares || '0') :
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
        contract_address: this.ATOKEN_ADDRESS.toLowerCase(),
        protocol_name: 'stability',
      })
      .first();

    const currentShares = currentBalance ? BigInt(currentBalance.position_shares) : 0n;
    const newShares = currentShares + shareChange;

    if (newShares < 0n) {
      logger.warn(`Negative balance detected for ${userAddress}: ${newShares}`);
    }

    // Initial 1:1 mapping - will be updated by liquidity index
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
}
