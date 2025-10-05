/**
 * Royco Protocol Balance Tracker
 * Tracks user deposits in Royco protocol using weiroll wallets on Sonic
 * Uses Royco API for deposits and daily_events table for withdrawals
 */

import { getAddress } from 'viem';
import { CONSTANTS } from '../../config/constants';
import { createLogger } from '../../utils/logger';
import { getDb } from '../../db/connection';
import { withRoycoRetry } from '../../utils/retryUtils';

const logger = createLogger('RoycoBalanceTracker');

export interface RoycoDeposit {
  id: string;
  weirollWallet: string;
  accountAddress: string;
  blockNumber: string;
  blockTimestamp: string;
  inputToken: {
    rawAmount: string;
    tokenAmount: number;
  };
}

export interface RoycoEvent {
  chainId: number;
  contractAddress: string;
  protocolName: 'royco';
  protocolType: 'vault';
  eventType: 'deposit' | 'withdraw';
  userAddress: string;
  amount: string;
  shares: string;
  blockNumber: number;
  timestamp: Date;
  txHash: string;
  logIndex: number;
  rawData: any;
}

export class RoycoBalanceTracker {
  private readonly ROYCO_API_KEY = process.env.ROYCO_API_KEY;
  private readonly ROYCO_API_URL = CONSTANTS.ROYCO.SONIC.API_BASE_URL;
  private readonly MARKET_REF_ID = CONSTANTS.ROYCO.SONIC.MARKET_REF_ID;
  private readonly db = getDb();

  constructor() {
    if (!this.ROYCO_API_KEY) {
      throw new Error('ROYCO_API_KEY environment variable is required');
    }
    logger.info('Initialized Royco Balance Tracker');
  }

  /**
   * Syncs Royco deposits from the API using full or incremental sync strategy
   */
  async syncRoycoDeposits(): Promise<void> {
    try {
      const existingCount = await this.db('royco_deposits').count('* as count').first();
      const hasExistingData = Number(existingCount?.count || 0) > 0;
      
      if (hasExistingData) {
        logger.info('Starting incremental sync of Royco deposits');
        await this.performIncrementalSync();
      } else {
        logger.info('Starting full sync of Royco deposits (empty table)');
        await this.performFullSync();
      }
    } catch (error) {
      logger.error('Failed to sync Royco deposits from API:', error);
      throw error;
    }
  }

  /**
   * Performs a full sync of all Royco deposits without checking for duplicates
   */
  private async performFullSync(): Promise<void> {
    let page = 1;
    let totalSynced = 0;
    const pageSize = 500;

    while (true) {
      const deposits = await this.fetchDepositsFromAPI(page, pageSize);
      
      if (!deposits || deposits.length === 0) {
        break;
      }

      await this.storeDepositsInDatabase(deposits, false);
      totalSynced += deposits.length;
      
      if (deposits.length < pageSize) {
        break;
      }
      
      page++;
    }

    logger.info(`Completed full sync: ${totalSynced} total deposits synced`);
  }

  /**
   * Performs an incremental sync that only adds new deposits
   */
  private async performIncrementalSync(): Promise<void> {
    const existingIds = new Set(await this.db('royco_deposits').pluck('royco_id'));
    let page = 1;
    let totalSynced = 0;
    let newDeposits = 0;
    const pageSize = 500;

    while (true) {
      const deposits = await this.fetchDepositsFromAPI(page, pageSize);
      
      if (!deposits || deposits.length === 0) {
        break;
      }

      const newDepositsOnly = deposits.filter(d => !existingIds.has(d.id));
      
      if (newDepositsOnly.length > 0) {
        await this.storeDepositsInDatabase(newDepositsOnly, true);
        newDeposits += newDepositsOnly.length;
      }
      
      totalSynced += deposits.length;
      
      if (deposits.length < pageSize) {
        break;
      }
      
      page++;
    }

    logger.info(`Completed incremental sync: ${newDeposits} new deposits out of ${totalSynced} total`);
  }

  /**
   * Processes Royco deposits and withdrawals for a block range
   */
  async processRoycoEvents(
    fromBlock: number,
    toBlock: number,
    eventDate: string
  ): Promise<void> {
    logger.info(`Processing Royco events from blocks ${fromBlock} to ${toBlock} for ${eventDate}`);
    
    try {
      await this.processRoycoDeposits(fromBlock, toBlock, eventDate);
      await this.processRoycoWithdrawals(fromBlock, toBlock, eventDate);
      await this.cleanupShareBalancesForWeirollWallets();
      
      logger.info(`Completed processing Royco events for ${eventDate}`);
    } catch (error) {
      logger.error('Failed to process Royco events:', error);
      throw error;
    }
  }

  /**
   * Processes Royco deposit events for a block range
   */
  private async processRoycoDeposits(
    fromBlock: number,
    toBlock: number,
    eventDate: string
  ): Promise<void> {
    try {
      const deposits = await this.getDepositsForBlockRange(fromBlock, toBlock);
      
      if (deposits.length === 0) {
        return;
      }

      const events = deposits.map(deposit => this.convertDepositToEvent(deposit, eventDate));
      
      await this.storeEvents(events, eventDate);
      await this.updateUserBalances(events, eventDate);
      await this.markVaultTransfersForDeposits(deposits, eventDate);
      
      const depositIds = deposits.map(d => d.id);
      await this.db('royco_deposits')
        .whereIn('id', depositIds)
        .update({ active: true, updated_at: new Date() });
      
      logger.info(`Processed ${events.length} Royco deposit events`);
    } catch (error) {
      logger.error('Failed to process Royco deposit events:', error);
      throw error;
    }
  }

  /**
   * Processes Royco withdrawal events using the daily_events table
   */
  private async processRoycoWithdrawals(
    _fromBlock: number,
    _toBlock: number,
    eventDate: string
  ): Promise<void> {
    try {
      const activeWallets = await this.getActiveWeirollWallets();
      
      if (activeWallets.length === 0) {
        return;
      }

      const withdrawalTransfers = await this.db('daily_events')
        .where('event_date', eventDate)
        .where('event_type', 'transfer')
        .where('asset', 'xUSD')
        .where('chain_id', CONSTANTS.CHAIN_IDS.SONIC)
        .where('isIntegrationAddress', 'from')
        .whereIn('from_address', activeWallets);

      const withdrawalEvents: RoycoEvent[] = [];
      
      for (const transfer of withdrawalTransfers) {
        const deposit = await this.db('royco_deposits')
          .where('weiroll_wallet', transfer.from_address.toLowerCase())
          .where('account_address', transfer.to_address.toLowerCase())
          .where('active', true)
          .first();

        if (!deposit) {
          throw new Error(
            `Data consistency error: Found withdrawal transfer from weiroll wallet ${transfer.from_address} to user ${transfer.to_address} ` +
            `in daily_events (tx: ${transfer.tx_hash}) but no matching active deposit found in royco_deposits. ` +
            `This indicates either incomplete Royco API sync or incorrect Alchemy data.`
          );
        }

        const withdrawalEvent: RoycoEvent = {
          chainId: CONSTANTS.CHAIN_IDS.SONIC,
          contractAddress: deposit.weiroll_wallet,
          protocolName: 'royco',
          protocolType: 'vault',
          eventType: 'withdraw',
          userAddress: getAddress(deposit.account_address),
          amount: deposit.token_amount,
          shares: deposit.token_amount,
          blockNumber: transfer.block_number,
          timestamp: transfer.timestamp,
          txHash: transfer.tx_hash,
          logIndex: transfer.log_index,
          rawData: { transfer, deposit },
        };

        withdrawalEvents.push(withdrawalEvent);

        await this.db('royco_deposits')
          .where('id', deposit.id)
          .update({
            active: false,
            updated_at: new Date(),
          });
      }

      if (withdrawalEvents.length > 0) {
        await this.storeEvents(withdrawalEvents, eventDate);
        await this.updateUserBalances(withdrawalEvents, eventDate);
        
        logger.info(`Processed ${withdrawalEvents.length} Royco withdrawal events`);
      }
    } catch (error) {
      logger.error('Failed to process Royco withdrawal events:', error);
      throw error;
    }
  }

  /**
   * Fetches deposits from the Royco API with retry logic
   */
  private async fetchDepositsFromAPI(page: number = 1, size: number = 500): Promise<RoycoDeposit[]> {
    return await withRoycoRetry(async () => {
      const response = await fetch(`${this.ROYCO_API_URL}/position/recipe`, {
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'x-api-key': this.ROYCO_API_KEY!,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          page: { index: page, size },
          filters: [{
            id: 'rawMarketRefId',
            value: this.MARKET_REF_ID,
          }],
        }),
      });

      if (!response.ok) {
        throw new Error(`Royco API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as { data?: RoycoDeposit[] };
      return data.data || [];
    }, `fetch deposits from API (page ${page})`);
  }

  /**
   * Stores deposits in the database with optional conflict handling
   */
  private async storeDepositsInDatabase(deposits: RoycoDeposit[], isIncremental: boolean): Promise<void> {
    if (deposits.length === 0) return;

    const records = deposits.map(deposit => ({
      royco_id: deposit.id,
      weiroll_wallet: deposit.weirollWallet.toLowerCase(),
      account_address: deposit.accountAddress.toLowerCase(),
      block_number: parseInt(deposit.blockNumber),
      token_amount: deposit.inputToken.rawAmount,
      active: false,
      deposit_timestamp: new Date(parseInt(deposit.blockTimestamp) * 1000),
      created_at: new Date(),
      updated_at: new Date(),
    }));

    if (isIncremental) {
      await this.db('royco_deposits')
        .insert(records)
        .onConflict('royco_id')
        .ignore();
    } else {
      await this.db('royco_deposits').insert(records);
    }

    logger.debug(`Stored ${records.length} Royco deposits in database`);
  }

  /**
   * Retrieves deposits for a specific block range from the database
   */
  private async getDepositsForBlockRange(fromBlock: number, toBlock: number): Promise<any[]> {
    return await this.db('royco_deposits')
      .where('block_number', '>=', fromBlock)
      .where('block_number', '<=', toBlock)
      .orderBy('block_number', 'asc');
  }

  /**
   * Retrieves active weiroll wallet addresses from the database
   */
  private async getActiveWeirollWallets(): Promise<string[]> {
    const wallets = await this.db('royco_deposits')
      .where('active', true)
      .pluck('weiroll_wallet');
    
    return wallets.map((w: string) => w.toLowerCase());
  }

  /**
   * Converts a deposit record to a RoycoEvent object
   */
  private convertDepositToEvent(deposit: any, _eventDate: string): RoycoEvent {
    return {
      chainId: CONSTANTS.CHAIN_IDS.SONIC,
      contractAddress: getAddress(deposit.weiroll_wallet),
      protocolName: 'royco',
      protocolType: 'vault',
      eventType: 'deposit',
      userAddress: getAddress(deposit.account_address),
      amount: deposit.token_amount,
      shares: deposit.token_amount,
      blockNumber: deposit.block_number,
      timestamp: deposit.deposit_timestamp,
      txHash: `0x${'0'.repeat(64)}`,
      logIndex: 0,
      rawData: deposit,
    };
  }

  /**
   * Stores Royco events in the daily_integration_events table
   */
  private async storeEvents(events: RoycoEvent[], eventDate: string): Promise<void> {
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
      amount_delta: event.eventType === 'deposit' ? event.amount :
                    event.eventType === 'withdraw' ? `-${event.amount}` : '0',
      shares_delta: event.eventType === 'deposit' ? event.shares :
                    event.eventType === 'withdraw' ? `-${event.shares}` : '0',
      block_number: event.blockNumber,
      timestamp: event.timestamp,
      tx_hash: event.txHash,
      log_index: event.logIndex,
      counterparty_address: null,
    }));

    const nonZeroEventRecords = eventRecords.filter((record) => {
      try {
        return BigInt(record.amount_delta) !== 0n;
      } catch {
        return true;
      }
    });

    if (nonZeroEventRecords.length === 0) {
      logger.debug('Skipping Royco events due to zero amount_delta');
      return;
    }

    const droppedCount = eventRecords.length - nonZeroEventRecords.length;
    if (droppedCount > 0) {
      logger.debug(`Dropped ${droppedCount} Royco events with zero amount_delta`);
    }

    await this.db('daily_integration_events')
      .insert(nonZeroEventRecords);
      
    logger.debug(`Stored ${nonZeroEventRecords.length} Royco events`);
  }

  /**
   * Updates user balances based on processed events
   */
  private async updateUserBalances(events: RoycoEvent[], eventDate: string): Promise<void> {
    const userEvents = new Map<string, RoycoEvent[]>();
    for (const event of events) {
      const userKey = event.userAddress.toLowerCase();
      if (!userEvents.has(userKey)) {
        userEvents.set(userKey, []);
      }
      userEvents.get(userKey)!.push(event);
    }

    for (const [userAddress, userEventList] of userEvents) {
      let netAmountChange = 0n;
      
      for (const event of userEventList) {
        const delta = event.eventType === 'deposit' ? BigInt(event.amount) :
                      event.eventType === 'withdraw' ? -BigInt(event.amount) : 0n;
        netAmountChange += delta;
      }

      if (netAmountChange !== 0n) {
        await this.updateUserBalance(userAddress, netAmountChange, userEventList[0].blockNumber, eventDate);
      }
    }
  }

  /**
   * Updates a single user's balance in the database
   */
  private async updateUserBalance(userAddress: string, amountChange: bigint, blockNumber: number, eventDate: string): Promise<void> {
    const currentBalance = await this.db('integration_balances')
      .where({
        address: userAddress,
        chain_id: CONSTANTS.CHAIN_IDS.SONIC,
        protocol_name: 'royco',
      })
      .first();

    const currentAmount = currentBalance ? BigInt(currentBalance.position_shares) : 0n;
    const newAmount = currentAmount + amountChange;

    if (newAmount < 0n) {
      logger.warn(`Negative balance detected for ${userAddress}: ${newAmount}`);
    }

    if (currentBalance) {
      await this.db('integration_balances')
        .where({ id: currentBalance.id })
        .update({
          position_shares: newAmount.toString(),
          underlying_assets: newAmount.toString(),
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
          protocol_name: 'royco',
          contract_address: '0x0000000000000000000000000000000000000000',
          position_shares: newAmount.toString(),
          underlying_assets: newAmount.toString(),
          last_update_block: blockNumber,
          last_updated: new Date(),
          last_updated_date: eventDate,
        });
    }
  }

  /**
   * Removes share_balances entries for active weiroll wallets
   */
  private async cleanupShareBalancesForWeirollWallets(): Promise<void> {
    try {
      const activeWallets = await this.getActiveWeirollWallets();
      
      if (activeWallets.length === 0) {
        logger.debug('No active weiroll wallets to clean up');
        return;
      }

      const deleted = await this.db('share_balances')
        .where('asset', 'xUSD')
        .whereIn('address', activeWallets)
        .del();

      if (deleted > 0) {
        logger.info(`Cleaned up ${deleted} share_balance entries for ${activeWallets.length} weiroll wallets`);
      } else {
        logger.debug(`No share_balance entries found for ${activeWallets.length} weiroll wallets`);
      }
    } catch (error) {
      logger.error('Failed to cleanup share balances for weiroll wallets:', error);
      throw error;
    }
  }

  /**
   * Marks vault transfers in daily_events corresponding to Royco deposits
   */
  private async markVaultTransfersForDeposits(deposits: any[], eventDate: string): Promise<void> {
    for (const deposit of deposits) {
      const fromAddress = deposit.account_address.toLowerCase();
      const toAddress = deposit.weiroll_wallet.toLowerCase();
      const amount = deposit.token_amount;

      const updated = await this.db('daily_events')
        .where('event_date', eventDate)
        .where('chain_id', CONSTANTS.CHAIN_IDS.SONIC)
        .where('event_type', 'transfer')
        .where('asset', 'xUSD')
        .whereRaw('lower(from_address) = ?', [fromAddress])
        .whereRaw('lower(to_address) = ?', [toAddress])
        .where('amount_delta', amount)
        .update({ isIntegrationAddress: 'to' });

      if (updated === 0) {
        logger.warn('No matching vault transfer found for Royco deposit', {
          depositId: deposit.id,
          fromAddress,
          toAddress,
          amount,
          eventDate,
        });
      }
    }
  }
}
