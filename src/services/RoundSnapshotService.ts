/**
 * Round Snapshot Service
 * Calculates a single USD balance per user every 24 hours (when rounds roll)
 * Aggregates shares across all chains and all assets into one USD value
 */

import { getDb } from '../db/connection';
import { createLogger } from '../utils/logger';
import { ChainlinkService } from '../oracle/ChainlinkService';
import { CONSTANTS, AssetType } from '../config/constants';

const logger = createLogger('RoundSnapshotService');

interface RoundSnapshot {
  round_id: number;
  round_start: Date;
  round_end?: Date;
  xeth_pps: string;
  xbtc_pps: string;
  xusd_pps: string;
  xeur_pps: string;
  eth_usd_price: string;
  btc_usd_price: string;
  usd_usd_price: string;
  eur_usd_price: string;
}

export class RoundSnapshotService {
  private db = getDb();
  // private oracleService: ChainlinkService;
  private isProcessing = false;

  constructor() {
    // this.oracleService = new ChainlinkService();
  }

  /**
   * Process a round when it completes
   * This is triggered by RoundRolled event on Ethereum
   */
  async processRoundSnapshot(roundId: number): Promise<void> {
    if (this.isProcessing) {
      logger.warn(`Already processing a round snapshot, skipping round ${roundId}`);
      return;
    }

    this.isProcessing = true;
    const startTime = Date.now();

    try {
      logger.info(`Starting snapshot for round ${roundId}`);

      // 1. Get round data from Ethereum (PPS and timing)
      const roundData = await this.getRoundData(roundId);
      if (!roundData) {
        throw new Error(`Round ${roundId} not found`);
      }

      // 2. Create or update snapshot job
      await this.db('round_snapshot_jobs')
        .insert({
          round_id: roundId,
          status: 'processing',
          round_start: roundData.round_start,
          round_end: roundData.round_end,
          xeth_pps: roundData.xeth_pps,
          xbtc_pps: roundData.xbtc_pps,
          xusd_pps: roundData.xusd_pps,
          xeur_pps: roundData.xeur_pps,
          eth_usd_price: roundData.eth_usd_price,
          btc_usd_price: roundData.btc_usd_price,
          usd_usd_price: roundData.usd_usd_price,
          eur_usd_price: roundData.eur_usd_price,
          started_at: new Date(),
        })
        .onConflict('round_id')
        .merge();

      // 3. Get all unique addresses that had any activity
      const addresses = await this.getActiveAddresses(roundId);
      logger.info(`Processing ${addresses.length} addresses for round ${roundId}`);

      let processed = 0;
      let totalDropletsAwarded = 0n;

      // 4. Process each address
      for (const address of addresses) {
        try {
          const dropletsEarned = await this.processUserSnapshot(address, roundId, roundData);
          totalDropletsAwarded += dropletsEarned;
          processed++;

          if (processed % 100 === 0) {
            logger.info(`Processed ${processed}/${addresses.length} addresses`);
          }
        } catch (error) {
          logger.error(`Failed to process address ${address}:`, error);
        }
      }

      // 5. Mark job as completed
      await this.db('round_snapshot_jobs')
        .where('round_id', roundId)
        .update({
          status: 'completed',
          users_processed: processed,
          total_droplets_awarded: totalDropletsAwarded.toString(),
          completed_at: new Date(),
        });

      const duration = (Date.now() - startTime) / 1000;
      logger.info(`Round ${roundId} snapshot completed in ${duration}s. Processed ${processed} users, awarded ${totalDropletsAwarded} droplets`);

    } catch (error) {
      logger.error(`Failed to process round ${roundId}:`, error);
      
      await this.db('round_snapshot_jobs')
        .where('round_id', roundId)
        .update({
          status: 'failed',
          error_message: error instanceof Error ? error.message : String(error),
        });

      throw error;
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Process a single user's snapshot for a round
   * Returns droplets earned
   */
  private async processUserSnapshot(
    address: string, 
    roundId: number, 
    roundData: RoundSnapshot
  ): Promise<bigint> {
    // 1. Check if user is excluded
    const isExcluded = await this.isExcludedAddress(address);
    if (isExcluded) {
      await this.saveUserSnapshot(address, roundId, 0n, 0n, true, false);
      return 0n;
    }

    // 2. Check if user unstaked during this round on Ethereum
    const hadUnstake = await this.hadUnstakeDuringRound(address, roundId);
    if (hadUnstake) {
      logger.debug(`User ${address} unstaked during round ${roundId}, no droplets earned`);
      await this.saveUserSnapshot(address, roundId, 0n, 0n, false, true);
      return 0n;
    }

    // 3. Calculate total USD value across all chains and assets
    const totalUsdValue = await this.calculateTotalUsdValue(address, roundId, roundData);

    // 4. Calculate droplets (1 per USD per round)
    const dropletsEarned = totalUsdValue / (10n ** 6n); // Assuming USD has 6 decimals like USDC

    // 5. Save the snapshot
    await this.saveUserSnapshot(address, roundId, totalUsdValue, dropletsEarned, false, false);

    // 6. Update leaderboard
    await this.updateLeaderboard(address, dropletsEarned, roundId, totalUsdValue);

    return dropletsEarned;
  }

  /**
   * Calculate total USD value for a user across all chains and assets
   */
  private async calculateTotalUsdValue(
    address: string,
    roundId: number,
    roundData: RoundSnapshot
  ): Promise<bigint> {
    const assets: AssetType[] = ['xETH', 'xBTC', 'xUSD', 'xEUR'];
    let totalUsd = 0n;
    const breakdown: Record<string, { shares: bigint, usd: bigint }> = {};

    for (const asset of assets) {
      // Get total shares across all chains at round start
      const totalShares = await this.getTotalSharesAtRoundStart(address, asset, roundData.round_start);
      
      if (totalShares === 0n) {
        breakdown[asset] = { shares: 0n, usd: 0n };
        continue;
      }

      // Get PPS and price for this asset
      const pps = BigInt(roundData[`${asset.toLowerCase()}_pps` as keyof RoundSnapshot] as string);
      const usdPrice = BigInt(roundData[`${asset.toLowerCase().replace('x', '')}_usd_price` as keyof RoundSnapshot] as string);

      // Calculate underlying assets
      const ppsScale = 10n ** CONSTANTS.PPS_SCALE;
      const underlyingAssets = (totalShares * pps) / ppsScale;

      // Calculate USD value
      const oracleScale = 10n ** CONSTANTS.ORACLE_SCALE;
      // const assetDecimals = CONSTANTS.ASSET_DECIMALS[asset];
      const usdValue = (underlyingAssets * usdPrice) / oracleScale;

      breakdown[asset] = { shares: totalShares, usd: usdValue };
      totalUsd += usdValue;

      logger.debug(`User ${address} ${asset}: ${totalShares} shares = ${usdValue} USD`);
    }

    // Store breakdown in the snapshot
    await this.db('user_usd_snapshots')
      .where({ address, round_id: roundId })
      .update({
        xeth_shares_total: breakdown.xETH?.shares.toString() || '0',
        xeth_usd_value: breakdown.xETH?.usd.toString() || '0',
        xbtc_shares_total: breakdown.xBTC?.shares.toString() || '0',
        xbtc_usd_value: breakdown.xBTC?.usd.toString() || '0',
        xusd_shares_total: breakdown.xUSD?.shares.toString() || '0',
        xusd_usd_value: breakdown.xUSD?.usd.toString() || '0',
        xeur_shares_total: breakdown.xEUR?.shares.toString() || '0',
        xeur_usd_value: breakdown.xEUR?.usd.toString() || '0',
      });

    return totalUsd;
  }

  /**
   * Get total shares for an asset across all chains at round start
   */
  private async getTotalSharesAtRoundStart(
    address: string,
    asset: AssetType,
    roundStart: Date
  ): Promise<bigint> {
    // Get the balance from each chain at the round start time
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
   * Save user snapshot to database
   */
  private async saveUserSnapshot(
    address: string,
    roundId: number,
    totalUsdValue: bigint,
    dropletsEarned: bigint,
    isExcluded: boolean,
    hadUnstake: boolean
  ): Promise<void> {
    await this.db('user_usd_snapshots')
      .insert({
        address: address.toLowerCase(),
        round_id: roundId,
        total_usd_value: totalUsdValue.toString(),
        droplets_earned: dropletsEarned.toString(),
        is_excluded: isExcluded,
        had_unstake: hadUnstake,
        snapshot_time: new Date(),
      })
      .onConflict(['address', 'round_id'])
      .merge();
  }

  /**
   * Update the leaderboard with new droplets
   */
  private async updateLeaderboard(
    address: string,
    dropletsEarned: bigint,
    roundId: number,
    usdValue: bigint
  ): Promise<void> {
    const existing = await this.db('droplets_leaderboard')
      .where('address', address.toLowerCase())
      .first();

    if (existing) {
      const totalDroplets = BigInt(existing.total_droplets) + dropletsEarned;
      const roundsParticipated = existing.rounds_participated + (dropletsEarned > 0n ? 1 : 0);
      const avgUsd = totalDroplets > 0n ? usdValue / BigInt(roundsParticipated) : 0n;

      await this.db('droplets_leaderboard')
        .where('address', address.toLowerCase())
        .update({
          total_droplets: totalDroplets.toString(),
          last_round_calculated: roundId,
          rounds_participated: roundsParticipated,
          average_usd_per_round: avgUsd.toString(),
          last_updated: new Date(),
        });
    } else {
      await this.db('droplets_leaderboard')
        .insert({
          address: address.toLowerCase(),
          total_droplets: dropletsEarned.toString(),
          last_round_calculated: roundId,
          rounds_participated: dropletsEarned > 0n ? 1 : 0,
          average_usd_per_round: usdValue.toString(),
          first_seen: new Date(),
          last_updated: new Date(),
        });
    }
  }

  /**
   * Get round data including PPS and oracle prices
   */
  private async getRoundData(roundId: number): Promise<RoundSnapshot | null> {
    // Get round info from database
    const rounds = await this.db('rounds')
      .where('round_id', roundId)
      .where('chain_id', 1) // Ethereum is the source of truth for rounds
      .whereNotNull('end_ts');

    if (rounds.length === 0) {
      return null;
    }

    // Get PPS for each asset from the rounds
    const ppsData: any = {
      xeth_pps: '0',
      xbtc_pps: '0',
      xusd_pps: '0',
      xeur_pps: '0',
    };

    for (const round of rounds) {
      const asset = round.asset.toLowerCase();
      ppsData[`${asset}_pps`] = round.pps;
    }

    // Get oracle prices at round start
    // const roundStart = rounds[0].start_ts;
    // For now, use hardcoded prices until ChainlinkService is updated
    const ethPrice = 3000n * 10n**8n; // $3000 with 8 decimals
    const btcPrice = 60000n * 10n**8n; // $60000 with 8 decimals
    const eurPrice = 11n * 10n**7n; // $1.10 with 8 decimals

    return {
      round_id: roundId,
      round_start: rounds[0].start_ts,
      round_end: rounds[0].end_ts,
      ...ppsData,
      eth_usd_price: ethPrice.toString(),
      btc_usd_price: btcPrice.toString(),
      usd_usd_price: (10n ** 18n).toString(), // 1 USD = 1 USD
      eur_usd_price: eurPrice.toString(),
    };
  }

  /**
   * Get all addresses that had activity before or during this round
   */
  private async getActiveAddresses(roundId: number): Promise<string[]> {
    const addresses = await this.db('unified_share_events')
      .distinct('address')
      .where('round_id', '<=', roundId)
      .pluck('address');

    return addresses;
  }

  /**
   * Check if address is excluded
   */
  private async isExcludedAddress(address: string): Promise<boolean> {
    const excluded = await this.db('excluded_addresses')
      .where('address', address.toLowerCase())
      .first();

    return !!excluded;
  }

  /**
   * Check if user unstaked during the round on Ethereum
   */
  private async hadUnstakeDuringRound(address: string, roundId: number): Promise<boolean> {
    const unstakeEvents = await this.db('unified_share_events')
      .where({
        address: address.toLowerCase(),
        round_id: roundId,
        chain_id: 1, // Only Ethereum has unstaking
        event_type: 'unstake',
      })
      .count('* as count');

    return Number(unstakeEvents[0].count) > 0;
  }

  /**
   * Get leaderboard
   */
  async getLeaderboard(limit: number = 100): Promise<any[]> {
    return await this.db('droplets_leaderboard')
      .orderBy('total_droplets', 'desc')
      .limit(limit);
  }

  /**
   * Get user's droplets
   */
  async getUserDroplets(address: string): Promise<{
    total: string;
    lastRound: number;
    roundsParticipated: number;
  }> {
    const user = await this.db('droplets_leaderboard')
      .where('address', address.toLowerCase())
      .first();

    if (!user) {
      return {
        total: '0',
        lastRound: 0,
        roundsParticipated: 0,
      };
    }

    return {
      total: user.total_droplets,
      lastRound: user.last_round_calculated,
      roundsParticipated: user.rounds_participated,
    };
  }
}