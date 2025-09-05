/**
 * Chain Balance Tracker
 * Maintains the chain_share_balances table with current balances per chain
 * Processes events from unified_share_events to keep balances up to date
 */

import { getDb } from '../db/connection';
import { createLogger } from '../utils/logger';
import { CONSTANTS } from '../config/constants';

const logger = createLogger('ChainBalanceTracker');

interface ShareEvent {
  chain_id: number;
  address: string;
  asset: string;
  event_type: string;
  shares_delta: string;
  block_number: number;
  timestamp: Date;
  tx_hash: string;
  log_index: number;
}

export class ChainBalanceTracker {
  private db = getDb();
  private processing = false;

  /**
   * Process new events and update balances
   */
  async processNewEvents(): Promise<void> {
    if (this.processing) {
      logger.debug('Already processing events');
      return;
    }

    this.processing = true;

    try {
      // Get the last processed event for each chain
      const lastProcessed = await this.getLastProcessedEvents();

      // Process events for each chain
      for (const chainId of Object.values(CONSTANTS.CHAIN_IDS)) {
        await this.processChainEvents(chainId, lastProcessed[chainId]);
      }
    } catch (error) {
      logger.error('Error processing events:', error);
    } finally {
      this.processing = false;
    }
  }

  /**
   * Process events for a specific chain
   */
  private async processChainEvents(chainId: number, lastProcessed?: any): Promise<void> {
    // Build query for new events
    let query = this.db('unified_share_events')
      .where('chain_id', chainId)
      .orderBy('block_number', 'asc')
      .orderBy('log_index', 'asc');

    if (lastProcessed) {
      query = query.where((builder) => {
        builder
          .where('block_number', '>', lastProcessed.block_number)
          .orWhere((subBuilder) => {
            subBuilder
              .where('block_number', lastProcessed.block_number)
              .where('log_index', '>', lastProcessed.log_index);
          });
      });
    }

    const events = await query;

    if (events.length === 0) {
      return;
    }

    logger.info(`Processing ${events.length} events for chain ${chainId}`);

    // Group events by address and asset for batch processing
    const balanceChanges = new Map<string, bigint>();

    for (const event of events) {
      const key = `${event.address}-${event.asset}-${chainId}`;
      const currentBalance = balanceChanges.get(key) || 0n;
      const delta = BigInt(event.shares_delta);

      // Calculate new balance
      let newBalance = currentBalance + delta;

      // Handle different event types
      switch (event.event_type) {
        case 'transfer':
          // Transfer events need special handling
          // From address loses shares, to address gains shares
          // This should be handled by the indexer splitting into two events
          balanceChanges.set(key, newBalance);
          break;

        case 'stake':
        case 'bridge_in':
          // Increase balance
          balanceChanges.set(key, newBalance);
          break;

        case 'unstake':
        case 'bridge_out':
          // Decrease balance
          balanceChanges.set(key, newBalance);
          break;

        default:
          logger.warn(`Unknown event type: ${event.event_type}`);
      }
    }

    // Apply balance changes to database
    for (const [key, balanceDelta] of balanceChanges) {
      const [address, asset, chain] = key.split('-');
      await this.updateBalance(address, asset, parseInt(chain), balanceDelta, events[events.length - 1]);
    }

    logger.info(`Updated ${balanceChanges.size} balances for chain ${chainId}`);
  }

  /**
   * Update balance for an address/asset/chain combination
   */
  private async updateBalance(
    address: string,
    asset: string,
    chainId: number,
    delta: bigint,
    lastEvent: ShareEvent
  ): Promise<void> {
    // Get current balance
    const current = await this.db('chain_share_balances')
      .where({ address, asset, chain_id: chainId })
      .first();

    const currentBalance = current ? BigInt(current.shares) : 0n;
    const newBalance = currentBalance + delta;

    if (newBalance < 0n) {
      logger.error(`Negative balance detected for ${address} ${asset} on chain ${chainId}: ${newBalance}`);
      return;
    }

    if (newBalance === 0n && !current) {
      // No need to insert zero balance
      return;
    }

    if (current) {
      // Update existing balance
      await this.db('chain_share_balances')
        .where({ address, asset, chain_id: chainId })
        .update({
          shares: newBalance.toString(),
          last_block: lastEvent.block_number,
          last_updated: lastEvent.timestamp,
        });
    } else {
      // Insert new balance
      await this.db('chain_share_balances')
        .insert({
          address,
          asset,
          chain_id: chainId,
          shares: newBalance.toString(),
          last_block: lastEvent.block_number,
          last_updated: lastEvent.timestamp,
        });
    }
  }

  /**
   * Rebuild all balances from events (for backfill/recovery)
   */
  async rebuildBalancesFromEvents(): Promise<void> {
    logger.info('Rebuilding all balances from events...');
    
    // Clear existing balances
    await this.db('chain_share_balances').truncate();
    
    // Get all events ordered by block and log index
    const events = await this.db('unified_share_events')
      .orderBy(['chain_id', 'block_number', 'log_index']);
    
    logger.info(`Processing ${events.length} events`);
    
    // Track balances in memory for efficiency
    const balances: Record<string, bigint> = {};
    const getKey = (chainId: number, address: string, asset: string) => 
      `${chainId}-${address.toLowerCase()}-${asset}`;
    
    for (const event of events) {
      const key = getKey(event.chain_id, event.address, event.asset);
      const currentBalance = balances[key] || 0n;
      const delta = BigInt(event.shares_delta);
      
      const newBalance = currentBalance + delta;
      if (newBalance >= 0n) {
        balances[key] = newBalance;
      }
    }
    
    // Write all non-zero balances to database
    const entries = [];
    for (const [key, balance] of Object.entries(balances)) {
      if (balance > 0n) {
        const [chainId, address, asset] = key.split('-');
        entries.push({
          chain_id: parseInt(chainId),
          address,
          asset,
          shares: balance.toString(),
          last_block: 0, // Will be updated by next event processing
          last_updated: new Date(),
        });
      }
    }
    
    if (entries.length > 0) {
      // Insert in batches
      const batchSize = 1000;
      for (let i = 0; i < entries.length; i += batchSize) {
        const batch = entries.slice(i, i + batchSize);
        await this.db('chain_share_balances').insert(batch);
      }
    }
    
    logger.info(`Balance rebuild complete. Created ${entries.length} balance entries`);
  }

  /**
   * Get the last processed event for each chain
   */
  private async getLastProcessedEvents(): Promise<Record<number, any>> {
    const results = await this.db('unified_share_events')
      .select('chain_id')
      .max('block_number as block_number')
      .max('log_index as log_index')
      .groupBy('chain_id');

    const lastProcessed: Record<number, any> = {};
    for (const result of results) {
      lastProcessed[result.chain_id] = {
        block_number: result.block_number,
        log_index: result.log_index,
      };
    }

    return lastProcessed;
  }

  /**
   * Rebuild all balances from scratch (for recovery/debugging)
   */
  async rebuildAllBalances(): Promise<void> {
    logger.info('Rebuilding all balances from events...');

    // Clear existing balances
    await this.db('chain_share_balances').truncate();

    // Process all events from the beginning
    await this.processNewEvents();

    logger.info('Balance rebuild complete');
  }

  /**
   * Get total shares for an address across all chains
   */
  async getTotalShares(address: string, asset: string): Promise<bigint> {
    const balances = await this.db('chain_share_balances')
      .where({ address: address.toLowerCase(), asset })
      .select('shares');

    let total = 0n;
    for (const balance of balances) {
      total += BigInt(balance.shares);
    }

    return total;
  }

  /**
   * Get balance breakdown by chain
   */
  async getBalanceBreakdown(address: string): Promise<any> {
    const balances = await this.db('chain_share_balances')
      .where('address', address.toLowerCase())
      .select('asset', 'chain_id', 'shares');

    const breakdown: any = {};

    for (const balance of balances) {
      if (!breakdown[balance.asset]) {
        breakdown[balance.asset] = {};
      }
      breakdown[balance.asset][balance.chain_id] = balance.shares;
    }

    return breakdown;
  }
}