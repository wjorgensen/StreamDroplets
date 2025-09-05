/**
 * Daily Snapshot Service
 * Calculates a single USD balance per user every 24 hours
 * Aggregates shares across all chains and all assets into one USD value
 * Awards droplets at 1 per USD per day
 */

import { getDb } from '../db/connection';
import { createLogger } from '../utils/logger';
import { CONSTANTS, AssetType } from '../config/constants';
import { TimelineOracleService } from '../oracle/TimelineOracleService';

const logger = createLogger('DailySnapshotService');

interface DailySnapshot {
  snapshot_date: string;
  period_start: Date;
  period_end: Date;
  xeth_pps: string;
  xbtc_pps: string;
  xusd_pps: string;
  xeur_pps: string;
  eth_usd_price: string;
  btc_usd_price: string;
  usd_usd_price: string;
  eur_usd_price: string;
}

export class DailySnapshotService {
  private db = getDb();
  private oracleService: TimelineOracleService;
  private isProcessing = false;
  
  constructor() {
    this.oracleService = new TimelineOracleService();
  }
  private pendingBreakdown: Record<string, { shares: bigint, usd: bigint }> = {};

  /**
   * Process daily snapshot - called by scheduler every 24 hours
   */
  async processDailySnapshot(snapshotDate?: Date): Promise<void> {
    if (this.isProcessing) {
      logger.warn('Already processing a daily snapshot, skipping');
      return;
    }

    this.isProcessing = true;
    const startTime = Date.now();

    // Use provided date or current date
    const targetDate = snapshotDate || new Date();
    const dateStr = targetDate.toISOString().split('T')[0];
    
    // Calculate period boundaries (midnight to midnight UTC)
    const periodStart = new Date(dateStr + 'T00:00:00.000Z');
    const periodEnd = new Date(dateStr + 'T23:59:59.999Z');

    try {
      logger.info(`Starting daily snapshot for ${dateStr}`);

      // Check if already processed
      const existing = await this.db('daily_snapshot_jobs')
        .where('snapshot_date', dateStr)
        .first();

      if (existing && existing.status === 'completed') {
        logger.info(`Daily snapshot for ${dateStr} already completed`);
        return;
      }

      // 1. Get current market data (PPS and prices)
      const snapshotData = await this.getSnapshotData(periodEnd);
      if (!snapshotData) {
        throw new Error('Failed to get snapshot data');
      }

      // 2. Create or update snapshot job
      await this.db('daily_snapshot_jobs')
        .insert({
          snapshot_date: dateStr,
          status: 'processing',
          period_start: periodStart,
          period_end: periodEnd,
          xeth_pps: snapshotData.xeth_pps,
          xbtc_pps: snapshotData.xbtc_pps,
          xusd_pps: snapshotData.xusd_pps,
          xeur_pps: snapshotData.xeur_pps,
          eth_usd_price: snapshotData.eth_usd_price,
          btc_usd_price: snapshotData.btc_usd_price,
          usd_usd_price: snapshotData.usd_usd_price,
          eur_usd_price: snapshotData.eur_usd_price,
          started_at: new Date(),
        })
        .onConflict('snapshot_date')
        .merge();

      // 3. Get all addresses with any balance
      const addresses = await this.getActiveAddresses();
      logger.info(`Processing ${addresses.length} addresses for ${dateStr}`);

      let processed = 0;
      let totalDropletsAwarded = 0n;

      // 4. Process each address
      for (const address of addresses) {
        try {
          const dropletsEarned = await this.processUserSnapshot(
            address, 
            dateStr, 
            periodStart,
            periodEnd,
            snapshotData
          );
          totalDropletsAwarded += dropletsEarned;
          processed++;

          if (processed % 100 === 0) {
            logger.info(`Processed ${processed}/${addresses.length} addresses`);
          }
        } catch (error) {
          logger.error(`Failed to process address ${address}:`, error instanceof Error ? error.message : error);
        }
      }

      // 5. Mark job as completed
      await this.db('daily_snapshot_jobs')
        .where('snapshot_date', dateStr)
        .update({
          status: 'completed',
          users_processed: processed,
          total_droplets_awarded: totalDropletsAwarded.toString(),
          completed_at: new Date(),
        });

      // 6. Update system state
      await this.db('system_state')
        .where('key', 'last_snapshot_date')
        .update({
          value: dateStr,
          updated_at: new Date()
        });

      const duration = (Date.now() - startTime) / 1000;
      logger.info(`Daily snapshot for ${dateStr} completed in ${duration}s. Processed ${processed} users, awarded ${totalDropletsAwarded} droplets`);

    } catch (error) {
      logger.error(`Failed to process daily snapshot for ${dateStr}:`, error);
      
      await this.db('daily_snapshot_jobs')
        .where('snapshot_date', dateStr)
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
   * Process a single user's snapshot for a day
   * Returns droplets earned
   */
  private async processUserSnapshot(
    address: string, 
    dateStr: string,
    periodStart: Date,
    periodEnd: Date,
    snapshotData: DailySnapshot
  ): Promise<bigint> {
    // 1. Check if user is excluded
    const isExcluded = await this.isExcludedAddress(address);
    if (isExcluded) {
      await this.saveUserSnapshot(address, dateStr, 0n, 0n, 0n, true, false);
      return 0n;
    }

    // 2. Check if user unstaked during this day on Ethereum
    const hadUnstake = await this.hadUnstakeDuringPeriod(address, periodStart, periodEnd);
    if (hadUnstake) {
      logger.debug(`User ${address} unstaked on ${dateStr}, no droplets earned`);
      await this.saveUserSnapshot(address, dateStr, 0n, 0n, 0n, false, true);
      return 0n;
    }

    // 3. Calculate total USD value across all chains and assets
    const vaultUsdValue = await this.calculateVaultUsdValue(address, snapshotData);
    
    // 4. Calculate integration USD value
    const integrationUsdValue = await this.calculateIntegrationUsdValue(address, periodEnd);
    
    // 5. Total USD value
    const totalUsdValue = vaultUsdValue + integrationUsdValue;

    // 6. Calculate droplets (1 per USD per day)
    // USD values have 18 decimals, so divide by 10^18 for 1:1 ratio
    const dropletsEarned = totalUsdValue / (10n ** 18n);

    // 7. Save the snapshot
    await this.saveUserSnapshot(address, dateStr, vaultUsdValue, integrationUsdValue, dropletsEarned, false, false);

    // 8. Update leaderboard
    await this.updateLeaderboard(address, dropletsEarned, dateStr, totalUsdValue);

    return dropletsEarned;
  }

  /**
   * Calculate total USD value from vaults for a user across all chains and assets
   */
  private async calculateVaultUsdValue(
    address: string,
    snapshotData: DailySnapshot
  ): Promise<bigint> {
    const assets: AssetType[] = ['xETH', 'xBTC', 'xUSD', 'xEUR'];
    let totalUsd = 0n;
    const breakdown: Record<string, { shares: bigint, usd: bigint }> = {};

    for (const asset of assets) {
      // Get total shares across all chains
      const totalShares = await this.getTotalSharesForAsset(address, asset);
      
      if (totalShares === 0n) {
        breakdown[asset] = { shares: 0n, usd: 0n };
        continue;
      }

      // Get PPS and price for this asset
      const pps = BigInt(snapshotData[`${asset.toLowerCase()}_pps` as keyof DailySnapshot] as string);
      const usdPrice = BigInt(snapshotData[`${asset.toLowerCase().replace('x', '')}_usd_price` as keyof DailySnapshot] as string);

      // Calculate underlying assets
      const ppsScale = 10n ** CONSTANTS.PPS_SCALE;
      const underlyingAssets = (totalShares * pps) / ppsScale;

      // Calculate USD value
      const oracleScale = 10n ** CONSTANTS.ORACLE_SCALE;
      const usdValue = (underlyingAssets * usdPrice) / oracleScale;

      breakdown[asset] = { shares: totalShares, usd: usdValue };
      totalUsd += usdValue;

      logger.debug(`User ${address} ${asset}: ${totalShares} shares = ${usdValue} USD`);
    }

    // Store the breakdown temporarily - will be saved with the main snapshot
    this.pendingBreakdown = breakdown;

    return totalUsd;
  }

  /**
   * Calculate integration protocol USD value
   */
  private async calculateIntegrationUsdValue(
    address: string,
    _snapshotTime: Date
  ): Promise<bigint> {
    // Get all integration positions for the user with non-zero shares
    const positions = await this.db('integration_positions')
      .where('user_address', address.toLowerCase())
      .where('position_shares', '>', 0);

    let totalUsd = 0n;

    for (const position of positions) {
      // For now, use the USD value stored in the position
      // In production, this would calculate based on current rates
      totalUsd += BigInt(position.usd_value || 0);
    }

    return totalUsd;
  }

  /**
   * Get total shares for an asset across all chains
   */
  private async getTotalSharesForAsset(
    address: string,
    asset: AssetType
  ): Promise<bigint> {
    const balances = await this.db('chain_share_balances')
      .where({ 
        address: address.toLowerCase(), 
        asset 
      })
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
    dateStr: string,
    vaultUsdValue: bigint,
    integrationUsdValue: bigint,
    dropletsEarned: bigint,
    isExcluded: boolean,
    hadUnstake: boolean
  ): Promise<void> {
    const totalUsdValue = vaultUsdValue + integrationUsdValue;
    const breakdown = this.pendingBreakdown || {};
    
    await this.db('daily_usd_snapshots')
      .insert({
        address: address.toLowerCase(),
        snapshot_date: dateStr,
        total_usd_value: totalUsdValue.toString(),
        integration_usd_value: integrationUsdValue.toString(),
        droplets_earned: dropletsEarned.toString(),
        is_excluded: isExcluded,
        had_unstake: hadUnstake,
        snapshot_timestamp: new Date(),
        // Add breakdown data
        xeth_shares_total: breakdown.xETH?.shares?.toString() || '0',
        xeth_usd_value: breakdown.xETH?.usd?.toString() || '0',
        xbtc_shares_total: breakdown.xBTC?.shares?.toString() || '0',
        xbtc_usd_value: breakdown.xBTC?.usd?.toString() || '0',
        xusd_shares_total: breakdown.xUSD?.shares?.toString() || '0',
        xusd_usd_value: breakdown.xUSD?.usd?.toString() || '0',
        xeur_shares_total: breakdown.xEUR?.shares?.toString() || '0',
        xeur_usd_value: breakdown.xEUR?.usd?.toString() || '0',
      })
      .onConflict(['address', 'snapshot_date'])
      .merge();
    
    // Clear the pending breakdown
    this.pendingBreakdown = {};
  }

  /**
   * Update the leaderboard with new droplets
   */
  private async updateLeaderboard(
    address: string,
    dropletsEarned: bigint,
    dateStr: string,
    usdValue: bigint
  ): Promise<void> {
    const existing = await this.db('droplets_leaderboard')
      .where('address', address.toLowerCase())
      .first();

    if (existing) {
      const totalDroplets = BigInt(existing.total_droplets) + dropletsEarned;
      const daysParticipated = (existing.days_participated || 0) + (dropletsEarned > 0n ? 1 : 0);
      const avgUsd = daysParticipated > 0 ? totalDroplets / BigInt(daysParticipated) : 0n;

      await this.db('droplets_leaderboard')
        .where('address', address.toLowerCase())
        .update({
          total_droplets: totalDroplets.toString(),
          last_snapshot_date: dateStr,
          days_participated: daysParticipated,
          average_daily_usd: avgUsd.toString(),
          last_updated: new Date(),
        });
    } else {
      await this.db('droplets_leaderboard')
        .insert({
          address: address.toLowerCase(),
          total_droplets: dropletsEarned.toString(),
          last_snapshot_date: dateStr,
          days_participated: dropletsEarned > 0n ? 1 : 0,
          average_daily_usd: usdValue.toString(),
          first_seen: new Date(),
          last_updated: new Date(),
        });
    }
  }

  /**
   * Get snapshot data including PPS and oracle prices
   */
  private async getSnapshotData(snapshotTime: Date): Promise<DailySnapshot | null> {
    const dateStr = snapshotTime.toISOString().split('T')[0];
    
    // Get latest PPS for each asset from Ethereum
    const ppsData: any = {
      xeth_pps: '1000000000000000000', // Default 1:1
      xbtc_pps: '1000000000000000000',
      xusd_pps: '1000000000000000000',
      xeur_pps: '1000000000000000000',
    };

    // Get latest PPS from rounds table
    const latestRounds = await this.db('rounds')
      .where('chain_id', 1) // Ethereum
      .select('asset', 'pps')
      .orderBy('round_id', 'desc')
      .limit(4);

    for (const round of latestRounds) {
      const asset = round.asset.toLowerCase();
      if (ppsData[`${asset}_pps`]) {
        ppsData[`${asset}_pps`] = round.pps;
      }
    }

    // Get oracle prices from Chainlink
    const priceTime = new Date(dateStr + 'T12:00:00.000Z'); // Use noon UTC for price snapshot
    
    logger.info(`Fetching oracle prices for ${dateStr} at ${priceTime.toISOString()}`);
    
    const [ethPrice, btcPrice, eurPrice] = await Promise.all([
      this.oracleService.getPriceAtTimestamp('xETH', priceTime),
      this.oracleService.getPriceAtTimestamp('xBTC', priceTime),
      this.oracleService.getPriceAtTimestamp('xEUR', priceTime),
    ]);
    
    logger.info(`Oracle prices for ${dateStr}: ETH=$${Number(ethPrice) / 1e8}, BTC=$${Number(btcPrice) / 1e8}, EUR=$${Number(eurPrice) / 1e8}`);

    return {
      snapshot_date: dateStr,
      period_start: new Date(dateStr + 'T00:00:00.000Z'),
      period_end: new Date(dateStr + 'T23:59:59.999Z'),
      ...ppsData,
      eth_usd_price: ethPrice.toString(),
      btc_usd_price: btcPrice.toString(),
      usd_usd_price: (10n ** 8n).toString(), // 1 USD = 1 USD with 8 decimals (Chainlink format)
      eur_usd_price: eurPrice.toString(),
    };
  }

  /**
   * Get all addresses that have any balance
   */
  private async getActiveAddresses(): Promise<string[]> {
    // Get addresses from chain_share_balances
    const vaultAddresses = await this.db('chain_share_balances')
      .distinct('address')
      .where('shares', '>', 0)
      .pluck('address');

    // Get addresses from integration_positions  
    const integrationAddresses = await this.db('integration_positions')
      .distinct('user_address')
      .where('position_shares', '>', 0)
      .pluck('user_address');

    // Combine and deduplicate
    const allAddresses = new Set([...vaultAddresses, ...integrationAddresses]);
    return Array.from(allAddresses);
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
   * Check if user unstaked during the period on Ethereum
   */
  private async hadUnstakeDuringPeriod(
    address: string, 
    periodStart: Date,
    periodEnd: Date
  ): Promise<boolean> {
    const unstakeEvents = await this.db('unified_share_events')
      .where({
        address: address.toLowerCase(),
        chain_id: 1, // Only Ethereum has unstaking
        event_type: 'unstake',
      })
      .whereBetween('timestamp', [periodStart, periodEnd])
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
    lastSnapshot: string;
    daysParticipated: number;
  }> {
    const user = await this.db('droplets_leaderboard')
      .where('address', address.toLowerCase())
      .first();

    if (!user) {
      return {
        total: '0',
        lastSnapshot: '',
        daysParticipated: 0,
      };
    }

    return {
      total: user.total_droplets,
      lastSnapshot: user.last_snapshot_date || '',
      daysParticipated: user.days_participated || 0,
    };
  }

  /**
   * Run daily snapshots for all missing days
   */
  async backfillDailySnapshots(startDate: Date, endDate: Date): Promise<void> {
    const currentDate = new Date(startDate);
    
    while (currentDate <= endDate) {
      const dateStr = currentDate.toISOString().split('T')[0];
      logger.info(`Processing daily snapshot for ${dateStr}`);
      
      try {
        await this.processDailySnapshot(currentDate);
      } catch (error) {
        logger.error(`Failed to process ${dateStr}:`, error);
      }
      
      // Move to next day
      currentDate.setDate(currentDate.getDate() + 1);
    }
  }
}