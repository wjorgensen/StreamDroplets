/**
 * Enclabs Balance Tracker
 * Tracks VToken positions in Enclabs lending pool on Sonic
 */

import { decodeEventLog, getAddress } from 'viem';
import { CONSTANTS, BlockRange } from '../../config/constants';
import { INTEGRATION_CONTRACTS } from '../../config/contracts';
import { ENCLABS_VTOKEN_ABI } from '../../config/abis/enclabsVToken';
import { createLogger } from '../../utils/logger';
import { getDb } from '../../db/connection';
import { AlchemyService } from '../../utils/AlchemyService';
import { withAlchemyRetry } from '../../utils/retryUtils';

const logger = createLogger('EnclabsBalanceTracker');

export interface EnclabsEvent {
  chainId: number;
  contractAddress: string;
  protocolName: 'enclabs';
  protocolType: 'lending';
  eventType: 'mint' | 'redeem' | 'transfer';
  userAddress: string;
  amount?: string;
  vTokens?: string;
  underlyingAmount?: string;
  fromAddress?: string;
  toAddress?: string;
  blockNumber: number;
  timestamp: Date;
  txHash: string;
  logIndex: number;
  rawData: any;
}

export class EnclabsBalanceTracker {
  private readonly ENCLABS_VTOKEN_ADDRESS = INTEGRATION_CONTRACTS.ENCLABS.SONIC.XUSD_VTOKEN;
  private readonly db = getDb();
  private alchemyService: AlchemyService;

  constructor() {
    this.alchemyService = AlchemyService.getInstance();
    logger.info('Initialized Enclabs Balance Tracker');
  }

  /**
   * Converts event date string to timestamp for database storage
   */
  private getEventTimestamp(eventDate: string): Date {
    return new Date(`${eventDate}T00:00:00.000Z`);
  }

  /**
   * Fetch and process all Enclabs VToken events for a specific block range
   */
  async fetchEventsForRange(
    fromBlock: number,
    toBlock: number,
    eventDate: string
  ): Promise<void> {
    logger.info(`Fetching Enclabs VToken events from blocks ${fromBlock} to ${toBlock}`);
    
    try {
      const events = await this.fetchVTokenEvents(fromBlock, toBlock, eventDate);
      
      if (events.length === 0) {
        logger.debug('No Enclabs VToken events found in block range');
        return;
      }
      
      await this.storeEvents(events, eventDate);
      
      logger.info(`Stored ${events.length} Enclabs VToken events`);
    } catch (error) {
      logger.error('Failed to fetch Enclabs VToken events:', error);
      throw error;
    }
  }

  /**
   * Process stored Enclabs events and update balances
   */
  async processEventsForRange(range: BlockRange, eventDate: string): Promise<void> {
    if (range.chainId !== CONSTANTS.CHAIN_IDS.SONIC) {
      logger.warn(`Enclabs not supported on chain ${range.chainId}`);
      return;
    }

    logger.info(`Processing stored Enclabs events for blocks ${range.fromBlock} to ${range.toBlock}`);

    const records = await this.db('daily_integration_events')
      .where({
        event_date: eventDate,
        protocol_name: 'enclabs',
        chain_id: range.chainId,
      })
      .whereBetween('block_number', [range.fromBlock, range.toBlock])
      .orderBy('block_number')
      .orderBy('tx_hash')
      .orderBy('log_index');

    if (records.length === 0) {
      logger.debug('No stored Enclabs events found for processing');
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
      logger.debug('No Enclabs balance changes derived from stored events');
      return;
    }

    for (const [address, aggregate] of aggregates.entries()) {
      await this.updateUserBalance(address, aggregate.shareDelta, aggregate.lastBlock, eventDate);
    }

    logger.info(`Applied Enclabs balance updates for ${aggregates.size} address(es)`);
  }

  /**
   * Fetch events from the Enclabs VToken contract
   */
  private async fetchVTokenEvents(
    fromBlock: number,
    toBlock: number,
    eventDate: string
  ): Promise<EnclabsEvent[]> {
    const events: EnclabsEvent[] = [];

    try {
      const sonicAlchemy = this.alchemyService.getAlchemyInstance(CONSTANTS.CHAIN_IDS.SONIC);
      const logs = await withAlchemyRetry(async () => {
        return await sonicAlchemy.core.getLogs({
          address: this.ENCLABS_VTOKEN_ADDRESS,
          fromBlock,
          toBlock,
        });
      }, `Enclabs getLogs (blocks ${fromBlock}-${toBlock})`);

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

      logger.debug(`Fetched ${events.length} events from Enclabs VToken ${this.ENCLABS_VTOKEN_ADDRESS}`);
      return events;
    } catch (error) {
      logger.error(`Failed to fetch events from Enclabs VToken ${this.ENCLABS_VTOKEN_ADDRESS}:`, error);
      return [];
    }
  }

  /**
   * Decode a log to an EnclabsEvent
   */
  private async decodeLogToEvent(log: any, eventDate: string): Promise<EnclabsEvent | null> {
    try {
      const decodedLog = decodeEventLog({
        abi: ENCLABS_VTOKEN_ABI,
        data: log.data,
        topics: log.topics,
      });

      const timestamp = this.getEventTimestamp(eventDate);

      switch ((decodedLog as any).eventName) {
        case 'Mint': {
          const { minter, mintAmount, mintTokens } = decodedLog.args as any;
          return {
            chainId: CONSTANTS.CHAIN_IDS.SONIC,
            contractAddress: getAddress(this.ENCLABS_VTOKEN_ADDRESS),
            protocolName: 'enclabs',
            protocolType: 'lending',
            eventType: 'mint',
            userAddress: getAddress(minter as string),
            amount: mintAmount.toString(),
            vTokens: mintTokens.toString(),
            underlyingAmount: mintAmount.toString(),
            blockNumber: log.blockNumber,
            timestamp,
            txHash: log.transactionHash,
            logIndex: log.logIndex,
            rawData: decodedLog,
          };
        }

        case 'Redeem': {
          const { redeemer, redeemAmount, redeemTokens } = decodedLog.args as any;
          return {
            chainId: CONSTANTS.CHAIN_IDS.SONIC,
            contractAddress: getAddress(this.ENCLABS_VTOKEN_ADDRESS),
            protocolName: 'enclabs',
            protocolType: 'lending',
            eventType: 'redeem',
            userAddress: getAddress(redeemer as string),
            amount: redeemAmount.toString(),
            vTokens: redeemTokens.toString(),
            underlyingAmount: redeemAmount.toString(),
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
            contractAddress: getAddress(this.ENCLABS_VTOKEN_ADDRESS),
            protocolName: 'enclabs',
            protocolType: 'lending',
            eventType: 'transfer',
            userAddress: getAddress(to as string),
            amount: value.toString(),
            vTokens: value.toString(),
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
   * Get current exchange rate from vault contract at specific block
   */
  async getCurrentExchangeRate(blockNumber: number): Promise<bigint> {
    try {
      const sonicViemClient = this.alchemyService.getViemClient(CONSTANTS.CHAIN_IDS.SONIC);
      
      const exchangeRate = await withAlchemyRetry(async () => {
        return await sonicViemClient.readContract({
          address: this.ENCLABS_VTOKEN_ADDRESS as `0x${string}`,
          abi: ENCLABS_VTOKEN_ABI,
          functionName: 'exchangeRateStored',
          blockNumber: BigInt(blockNumber)
        }) as bigint;
      }, `Enclabs exchange rate at block ${blockNumber}`);
      
      if (exchangeRate <= 0n) {
        throw new Error(`Invalid exchange rate returned: ${exchangeRate}`);
      }
      
      logger.debug(`Enclabs VToken exchange rate at block ${blockNumber}: ${Number(exchangeRate) / 1e18}`);
      return exchangeRate;
      
    } catch (error) {
      const errorMessage = (error as Error).message;
      
      if (errorMessage.includes('returned no data ("0x")') || 
          errorMessage.includes('contract does not have the function') ||
          errorMessage.includes('address is not a contract')) {
        logger.warn(`Enclabs VToken not deployed at block ${blockNumber}, skipping exchange rate calculation`);
        throw new Error(`Contract not deployed: ${errorMessage}`);
      }
      
      logger.error(`Failed to get exchange rate from Enclabs VToken at block ${blockNumber}:`, error);
      throw new Error(`Unable to get Enclabs VToken exchange rate: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Update balances with exchange rate at specific block
   */
  async updateBalancesWithExchangeRate(blockNumber: number): Promise<void> {
    logger.info(`Updating Enclabs balances with exchange rate at block ${blockNumber}`);
    
    try {
      const exchangeRate = await this.getCurrentExchangeRate(blockNumber);
      
      const positions = await this.db('integration_balances')
        .where({
          protocol_name: 'enclabs',
          chain_id: CONSTANTS.CHAIN_IDS.SONIC,
          contract_address: this.ENCLABS_VTOKEN_ADDRESS.toLowerCase(),
        })
        .where('position_shares', '>', '0');

      let updatedPositions = 0;

      for (const position of positions) {
        const vTokens = BigInt(position.position_shares);
        const newUnderlyingAssets = (vTokens * exchangeRate) / (10n ** 18n);
        
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

      logger.info(`Updated ${updatedPositions} Enclabs positions with exchange rate: ${Number(exchangeRate) / 1e18}`);
    } catch (error) {
      const errorMessage = (error as Error).message;
      
      if (errorMessage.includes('Contract not deployed:')) {
        logger.warn(`Enclabs VToken not deployed at block ${blockNumber}, skipping balance updates`);
        return;
      }
      
      logger.error('Failed to update Enclabs balances with exchange rate:', error);
      throw error;
    }
  }

  /**
   * Store events in the daily_integration_events table
   */
  private async storeEvents(events: EnclabsEvent[], eventDate: string): Promise<void> {
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
      amount_delta: event.eventType === 'mint' ? (event.underlyingAmount || '0') :
                    event.eventType === 'redeem' ? `-${event.underlyingAmount || '0'}` :
                    event.eventType === 'transfer' ? (event.vTokens || '0') : '0',
      shares_delta: event.eventType === 'mint' ? (event.vTokens || '0') :
                    event.eventType === 'redeem' ? `-${event.vTokens || '0'}` :
                    event.eventType === 'transfer' ? (event.vTokens || '0') : '0',
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
      logger.debug('Skipping Enclabs events due to zero amount_delta');
      return;
    }

    const droppedCount = eventRecords.length - nonZeroEventRecords.length;
    if (droppedCount > 0) {
      logger.debug(`Dropped ${droppedCount} Enclabs events with zero amount_delta`);
    }

    await this.db('daily_integration_events')
      .insert(nonZeroEventRecords);
      
    logger.debug(`Stored ${nonZeroEventRecords.length} Enclabs events`);
  }

  /**
   * Update a single user's balance
   */
  private async updateUserBalance(userAddress: string, vTokenChange: bigint, blockNumber: number, eventDate: string): Promise<void> {
    const currentBalance = await this.db('integration_balances')
      .where({
        address: userAddress,
        chain_id: CONSTANTS.CHAIN_IDS.SONIC,
        contract_address: this.ENCLABS_VTOKEN_ADDRESS.toLowerCase(),
        protocol_name: 'enclabs',
      })
      .first();

    const currentVTokens = currentBalance ? BigInt(currentBalance.position_shares) : 0n;
    const newVTokens = currentVTokens + vTokenChange;

    if (newVTokens < 0n) {
      logger.warn(`Negative balance detected for ${userAddress}: ${newVTokens}`);
    }

    const underlyingAssets = newVTokens;

    if (currentBalance) {
      await this.db('integration_balances')
        .where({ id: currentBalance.id })
        .update({
          position_shares: newVTokens.toString(),
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
          protocol_name: 'enclabs',
          contract_address: this.ENCLABS_VTOKEN_ADDRESS.toLowerCase(),
          position_shares: newVTokens.toString(),
          underlying_assets: underlyingAssets.toString(),
          last_update_block: blockNumber,
          last_updated: new Date(),
          last_updated_date: eventDate,
        });
    }
  }

  /**
   * Convert value to BigInt with error handling
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
