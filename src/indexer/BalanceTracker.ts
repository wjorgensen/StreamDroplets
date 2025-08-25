import { getDb } from '../db/connection';
import { AssetType, ChainId } from '../config/constants';
import { createLogger } from '../utils/logger';
import { CurrentBalance, BalanceSnapshot } from '../types';

const logger = createLogger('BalanceTracker');

export class BalanceTracker {
  private db = getDb();
  
  /**
   * Updates the current balance for an address
   */
  async updateBalance(
    address: string,
    asset: AssetType,
    chainId: ChainId,
    delta: bigint,
    blockNumber: bigint
  ): Promise<void> {
    try {
      // Get current balance
      const current = await this.db('current_balances')
        .where({ address, asset, chain_id: chainId })
        .first();
      
      if (current) {
        // Update existing balance
        const newBalance = BigInt(current.shares) + delta;
        
        if (newBalance < 0n) {
          logger.error(`Negative balance detected for ${address} ${asset}: ${newBalance}`);
          return;
        }
        
        await this.db('current_balances')
          .where({ address, asset, chain_id: chainId })
          .update({
            shares: newBalance.toString(),
            last_update_block: blockNumber.toString(),
            updated_at: new Date(),
          });
      } else {
        // Insert new balance
        if (delta < 0n) {
          logger.error(`Cannot create negative balance for ${address} ${asset}: ${delta}`);
          return;
        }
        
        await this.db('current_balances').insert({
          address,
          asset,
          chain_id: chainId,
          shares: delta.toString(),
          last_update_block: blockNumber.toString(),
        });
      }
    } catch (error) {
      logger.error(`Error updating balance:`, { error, address, asset, chainId });
      throw error;
    }
  }
  
  /**
   * Gets the current balance for an address
   */
  async getBalance(
    address: string,
    asset: AssetType,
    chainId?: ChainId
  ): Promise<bigint> {
    const query = this.db('current_balances')
      .where({ address, asset });
    
    if (chainId) {
      query.andWhere({ chain_id: chainId });
    }
    
    const balances = await query;
    
    // Sum balances across chains if no specific chain requested
    const totalBalance = balances.reduce((sum, balance) => {
      return sum + BigInt(balance.shares);
    }, 0n);
    
    return totalBalance;
  }
  
  /**
   * Creates balance snapshots for a round
   */
  async snapshotForRound(
    roundId: number,
    asset: AssetType,
    timestamp: bigint
  ): Promise<void> {
    logger.info(`Creating balance snapshots for round ${roundId}, asset ${asset}`);
    
    try {
      // Get all addresses with non-zero balances for this asset
      const balances = await this.db('current_balances')
        .where({ asset })
        .where('shares', '>', '0');
      
      // Create snapshots for each address
      const snapshots: BalanceSnapshot[] = [];
      
      for (const balance of balances) {
        // Check if snapshot already exists
        const existing = await this.db('balance_snapshots')
          .where({
            address: balance.address,
            asset,
            round_id: roundId,
          })
          .first();
        
        if (!existing) {
          snapshots.push({
            address: balance.address,
            asset,
            round_id: roundId,
            shares_at_start: balance.shares,
            had_unstake_in_round: false,
            had_transfer_in_round: false,
            had_bridge_in_round: false,
          });
        }
      }
      
      // Batch insert snapshots
      if (snapshots.length > 0) {
        await this.db('balance_snapshots').insert(snapshots);
        logger.info(`Created ${snapshots.length} snapshots for round ${roundId}`);
      }
      
      // Mark previous round as ended
      await this.markRoundEnded(roundId - 1, asset, timestamp);
      
    } catch (error) {
      logger.error(`Error creating snapshots:`, { error, roundId, asset });
      throw error;
    }
  }
  
  /**
   * Marks a round as ended and processes events within that round
   */
  private async markRoundEnded(
    roundId: number,
    asset: AssetType,
    endTimestamp: bigint
  ): Promise<void> {
    if (roundId <= 0) return;
    
    try {
      // Update round end timestamp
      await this.db('rounds')
        .where({ round_id: roundId, asset })
        .update({
          end_ts: new Date(Number(endTimestamp) * 1000),
        });
      
      // Get round boundaries
      const round = await this.db('rounds')
        .where({ round_id: roundId, asset })
        .first();
      
      if (!round) return;
      
      // Find all events within this round
      const events = await this.db('share_events')
        .where({ asset })
        .whereBetween('timestamp', [round.start_ts, round.end_ts || new Date()]);
      
      // Process events to mark snapshots
      for (const event of events) {
        const updateData: Partial<BalanceSnapshot> = {};
        
        if (event.event_classification === 'unstake_burn') {
          updateData.had_unstake_in_round = true;
        } else if (event.event_classification === 'transfer') {
          updateData.had_transfer_in_round = true;
        } else if (event.event_classification === 'bridge_burn' || 
                   event.event_classification === 'bridge_mint') {
          updateData.had_bridge_in_round = true;
        }
        
        if (Object.keys(updateData).length > 0) {
          await this.db('balance_snapshots')
            .where({
              address: event.address,
              asset,
              round_id: roundId,
            })
            .update(updateData);
        }
      }
      
      logger.info(`Marked round ${roundId} as ended for ${asset}`);
      
    } catch (error) {
      logger.error(`Error marking round ended:`, { error, roundId, asset });
      throw error;
    }
  }
  
  /**
   * Gets the balance at a specific round start
   */
  async getBalanceAtRoundStart(
    address: string,
    asset: AssetType,
    roundId: number
  ): Promise<bigint> {
    const snapshot = await this.db('balance_snapshots')
      .where({ address, asset, round_id: roundId })
      .first();
    
    if (snapshot) {
      return BigInt(snapshot.shares_at_start);
    }
    
    return 0n;
  }
  
  /**
   * Checks if an address unstaked during a round
   */
  async didUnstakeInRound(
    address: string,
    asset: AssetType,
    roundId: number
  ): Promise<boolean> {
    const snapshot = await this.db('balance_snapshots')
      .where({ address, asset, round_id: roundId })
      .first();
    
    return snapshot?.had_unstake_in_round || false;
  }
}