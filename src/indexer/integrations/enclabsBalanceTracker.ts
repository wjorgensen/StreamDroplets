/**
 * Enclabs Balance Tracker
 * Tracks VToken positions in Enclabs lending pool on Sonic
 */

import { decodeEventLog, getAddress } from 'viem';
import { CONSTANTS } from '../../config/constants';
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
  amount?: string; // For transfer, this is vTokens; for mint/redeem this is underlying assets
  vTokens?: string; // For mint/redeem, this is the vToken amount
  underlyingAmount?: string; // For mint/redeem, this is the underlying assets amount
  fromAddress?: string; // For transfers
  toAddress?: string; // For transfers
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
   * Fetch and process all Enclabs VToken events for a specific block range
   */
  async processEnclabsEvents(
    fromBlock: number,
    toBlock: number,
    eventDate: string
  ): Promise<void> {
    logger.info(`Processing Enclabs VToken events from blocks ${fromBlock} to ${toBlock}`);
    
    try {
      const events = await this.fetchVTokenEvents(fromBlock, toBlock);
      
      if (events.length === 0) {
        logger.debug('No Enclabs VToken events found in block range');
        return;
      }
      
      await this.storeEvents(events, eventDate);
      await this.updateUserBalances(events, eventDate);
      
      logger.info(`Processed ${events.length} Enclabs VToken events`);
    } catch (error) {
      logger.error('Failed to process Enclabs VToken events:', error);
      throw error;
    }
  }

  /**
   * Fetch events from the Enclabs VToken contract
   */
  private async fetchVTokenEvents(
    fromBlock: number,
    toBlock: number
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
          const event = await this.decodeLogToEvent(log);
          if (event) {
            events.push(event);
          }
        } catch (decodeError) {
          logger.warn(`Failed to decode log at ${log.transactionHash}:${log.logIndex}:`, decodeError);
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
  private async decodeLogToEvent(log: any): Promise<EnclabsEvent | null> {
    try {
      const decodedLog = decodeEventLog({
        abi: ENCLABS_VTOKEN_ABI,
        data: log.data,
        topics: log.topics,
      });

      const timestamp = new Date();

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
          logger.warn(`Unknown event type: ${(decodedLog as any).eventName}`);
          return null;
      }
    } catch (error) {
      logger.error('Failed to decode log to event:', error);
      return null;
    }
    
    return null;
  }

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
      
      // Check if this is a contract not deployed error
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
      
      // Check if this is a contract not deployed error
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

    await this.db('daily_integration_events')
      .insert(eventRecords)
      .onConflict(['chain_id', 'tx_hash', 'log_index'])
      .ignore();
      
    logger.debug(`Stored ${eventRecords.length} Enclabs events`);
  }

  /**
   * Update user balances based on events
   */
  private async updateUserBalances(events: EnclabsEvent[], eventDate: string): Promise<void> {
    const userEvents = new Map<string, EnclabsEvent[]>();
    for (const event of events) {
      const userKey = event.userAddress.toLowerCase();
      if (!userEvents.has(userKey)) {
        userEvents.set(userKey, []);
      }
      userEvents.get(userKey)!.push(event);
    }

    for (const [userAddress, userEventList] of userEvents) {
      let netVTokenChange = 0n;
      
      for (const event of userEventList) {
        const delta = event.eventType === 'mint' ? BigInt(event.vTokens || '0') :
                      event.eventType === 'redeem' ? -BigInt(event.vTokens || '0') :
                      event.eventType === 'transfer' ? BigInt(event.vTokens || '0') : 0n;
        netVTokenChange += delta;
      }

      if (netVTokenChange !== 0n) {
        await this.updateUserBalance(userAddress, netVTokenChange, userEventList[0].blockNumber, eventDate);
      }
    }
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

}
