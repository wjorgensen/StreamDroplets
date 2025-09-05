/**
 * Simplified Accrual Engine
 * Reads pre-calculated droplets from the database
 * No complex calculations - just queries the results
 */

import { getDb } from '../db/connection';
// import { createLogger } from '../utils/logger';
import { DropletsResult } from '../types';

// const logger = createLogger('SimplifiedAccrualEngine');

export class SimplifiedAccrualEngine {
  private db = getDb();

  /**
   * Get total droplets for an address
   * Simply reads from the pre-calculated leaderboard table
   */
  async calculateDroplets(address: string): Promise<DropletsResult> {
    const normalizedAddress = address.toLowerCase();

    // Get from leaderboard (already calculated)
    const leaderboardEntry = await this.db('droplets_leaderboard')
      .where('address', normalizedAddress)
      .first();

    if (!leaderboardEntry) {
      return {
        address,
        droplets: '0',
        lastUpdated: new Date(),
        breakdown: {
          total: '0',
        },
      };
    }

    // Get the latest round snapshot for breakdown
    const latestSnapshot = await this.db('user_usd_snapshots')
      .where('address', normalizedAddress)
      .orderBy('round_id', 'desc')
      .first();

    const breakdown: any = {
      integrations: leaderboardEntry.total_droplets, // Using integrations field for total
    };

    if (latestSnapshot) {
      breakdown.lastRoundUSD = latestSnapshot.total_usd_value;
      breakdown.lastRoundDroplets = latestSnapshot.droplets_earned;
      breakdown.xETH_USD = latestSnapshot.xeth_usd_value;
      breakdown.xBTC_USD = latestSnapshot.xbtc_usd_value;
      breakdown.xUSD_USD = latestSnapshot.xusd_usd_value;
      breakdown.xEUR_USD = latestSnapshot.xeur_usd_value;
    }

    return {
      address,
      droplets: leaderboardEntry.total_droplets,
      lastUpdated: leaderboardEntry.last_updated,
      breakdown,
    };
  }

  /**
   * Get leaderboard
   */
  async getLeaderboard(limit: number = 100): Promise<any[]> {
    const results = await this.db('droplets_leaderboard')
      .orderBy('total_droplets', 'desc')
      .limit(limit)
      .select(
        'address',
        'total_droplets as droplets',
        'rounds_participated',
        'average_usd_per_round',
        'last_updated'
      );

    return results.map((row, index) => ({
      rank: index + 1,
      ...row,
    }));
  }

  /**
   * Get user's historical snapshots
   */
  async getUserHistory(address: string, limit: number = 10): Promise<any[]> {
    return await this.db('user_usd_snapshots')
      .where('address', address.toLowerCase())
      .orderBy('round_id', 'desc')
      .limit(limit)
      .select(
        'round_id',
        'total_usd_value',
        'droplets_earned',
        'snapshot_time',
        'had_unstake',
        'is_excluded'
      );
  }

  /**
   * Get round statistics
   */
  async getRoundStats(roundId: number): Promise<any> {
    const job = await this.db('round_snapshot_jobs')
      .where('round_id', roundId)
      .first();

    if (!job) {
      return null;
    }

    const topEarners = await this.db('user_usd_snapshots')
      .where('round_id', roundId)
      .where('droplets_earned', '>', 0)
      .orderBy('droplets_earned', 'desc')
      .limit(10)
      .select('address', 'droplets_earned', 'total_usd_value');

    return {
      round_id: roundId,
      status: job.status,
      users_processed: job.users_processed,
      total_droplets_awarded: job.total_droplets_awarded,
      round_start: job.round_start,
      round_end: job.round_end,
      top_earners: topEarners,
    };
  }

  /**
   * Check if a round needs processing
   */
  async checkPendingRounds(): Promise<number[]> {
    // Get all rounds from Ethereum that have ended
    const completedRounds = await this.db('rounds')
      .where('chain_id', 1)
      .whereNotNull('end_ts')
      .pluck('round_id');

    // Get all rounds we've already processed
    const processedRounds = await this.db('round_snapshot_jobs')
      .whereIn('status', ['completed', 'processing'])
      .pluck('round_id');

    // Find rounds that need processing
    const pendingRounds = completedRounds.filter(
      roundId => !processedRounds.includes(roundId)
    );

    return pendingRounds;
  }
}