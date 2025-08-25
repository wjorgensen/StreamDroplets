import { getDb } from '../db/connection';
import { AssetType } from '../config/constants';
import { createLogger } from '../utils/logger';
import { TimelineIndexer } from '../indexer/TimelineIndexer';
// import { TimelineOracleService } from '../oracle/TimelineOracleService';
import { DropletsResult } from '../types';

const logger = createLogger('TimelineAccrualEngine');

export interface DropletsIntegration {
  id?: number;
  address: string;
  asset: AssetType;
  interval_id: number;
  start_time: Date;
  end_time: Date;
  droplets_earned: string;
  rate_used: string;
  calculated_at?: Date;
}

export class TimelineAccrualEngine {
  private db = getDb();
  private timelineIndexer: TimelineIndexer;
  // private oracleService: TimelineOracleService;
  
  constructor() {
    this.timelineIndexer = new TimelineIndexer();
    // this.oracleService = new TimelineOracleService();
  }
  
  /**
   * Calculate total droplets for an address across all assets
   */
  async calculateDroplets(address: string): Promise<DropletsResult> {
    const assets: AssetType[] = ['xETH', 'xBTC', 'xUSD', 'xEUR'];
    const breakdown: Record<string, string> = {};
    let totalDroplets = 0n;
    
    for (const asset of assets) {
      const assetDroplets = await this.calculateDropletsForAsset(address, asset);
      breakdown[asset] = assetDroplets.toString();
      totalDroplets += assetDroplets;
    }
    
    // Update cache
    const lastUpdated = new Date();
    for (const asset of assets) {
      await this.updateCache(address, asset, BigInt(breakdown[asset]), lastUpdated);
    }
    
    return {
      address,
      droplets: totalDroplets.toString(),
      lastUpdated,
      breakdown,
    };
  }
  
  /**
   * Calculate droplets for a specific asset using timeline integration
   */
  async calculateDropletsForAsset(
    address: string,
    asset: AssetType,
    startTime?: Date,
    endTime?: Date
  ): Promise<bigint> {
    // Check cache first
    const cached = await this.getCache(address, asset);
    const cacheEndTime = cached?.last_calculated_end || new Date(0);
    const calculationStart = startTime || cacheEndTime;
    const calculationEnd = endTime || new Date();
    
    if (cached && calculationStart >= calculationEnd) {
      return BigInt(cached.droplets_total);
    }
    
    // Calculate new droplets from timeline
    const newDroplets = await this.timelineIndexer.calculateDropletsForRange(
      address,
      asset,
      calculationStart,
      calculationEnd
    );
    
    // Add to cached total
    const totalDroplets = cached 
      ? BigInt(cached.droplets_total) + newDroplets
      : newDroplets;
    
    // Update cache
    await this.updateCache(address, asset, totalDroplets, calculationEnd);
    
    return totalDroplets;
  }
  
  /**
   * Calculate droplets for a specific time range
   */
  async calculateDropletsForRange(
    address: string,
    asset: AssetType,
    startTime: Date,
    endTime: Date
  ): Promise<bigint> {
    return this.timelineIndexer.calculateDropletsForRange(address, asset, startTime, endTime);
  }
  
  /**
   * Process timeline intervals and calculate droplets for each
   */
  async processIntervals(
    address: string,
    asset: AssetType,
    startTime?: Date,
    endTime?: Date
  ): Promise<void> {
    const query = this.db('timeline_intervals')
      .where({ address, asset })
      .whereNotNull('end_time');
    
    if (startTime) {
      query.where('start_time', '>=', startTime);
    }
    if (endTime) {
      query.where('end_time', '<=', endTime);
    }
    
    const intervals = await query.orderBy('start_time');
    
    for (const interval of intervals) {
      // Check if already calculated
      const existing = await this.db('droplets_integration')
        .where({
          address,
          asset,
          interval_id: interval.id
        })
        .first();
      
      if (existing) continue;
      
      // Calculate droplets for this interval
      const droplets = await this.calculateIntervalDroplets(interval);
      
      // Get rate at this time
      const rate = await this.getRateAtTime(interval.start_time);
      
      // Store integration result
      const integration: DropletsIntegration = {
        address,
        asset,
        interval_id: interval.id!,
        start_time: interval.start_time,
        end_time: interval.end_time!,
        droplets_earned: droplets.toString(),
        rate_used: rate.toString(),
        calculated_at: new Date()
      };
      
      await this.db('droplets_integration').insert(integration);
    }
  }
  
  /**
   * Calculate droplets for a single timeline interval
   */
  private async calculateIntervalDroplets(interval: any): Promise<bigint> {
    const durationSeconds = BigInt(
      Math.floor((interval.end_time.getTime() - interval.start_time.getTime()) / 1000)
    );
    
    if (durationSeconds <= 0n) return 0n;
    
    // Calculate USD exposure
    const shares = BigInt(interval.shares);
    const pps = BigInt(interval.pps);
    const price = BigInt(interval.price_usd);
    
    // USD exposure = shares * PPS * price / (10^18 * 10^8)
    const usdExposure = (shares * pps * price) / (10n ** 18n) / (10n ** 8n);
    
    // Get rate for this time period
    const rate = await this.getRateAtTime(interval.start_time);
    
    // Calculate droplets: usd_exposure * rate * duration
    const droplets = (usdExposure * rate * durationSeconds) / (10n ** 18n);
    
    return droplets;
  }
  
  /**
   * Get the rate at a specific time
   */
  private async getRateAtTime(time: Date): Promise<bigint> {
    const rate = await this.db('rate_configuration')
      .where('effective_from', '<=', time)
      .where(function() {
        this.where('effective_to', '>=', time).orWhereNull('effective_to');
      })
      .where('is_active', true)
      .first();
    
    return rate ? BigInt(rate.rate_per_usd_second) : 1000000000000000000n;
  }
  
  /**
   * Get cached droplets
   */
  private async getCache(address: string, asset: AssetType) {
    return await this.db('droplets_cache')
      .where({ address, asset })
      .first();
  }
  
  /**
   * Update droplets cache
   */
  private async updateCache(
    address: string,
    asset: AssetType,
    droplets: bigint,
    lastCalculatedEnd: Date,
    lastRoundCalculated?: number
  ): Promise<void> {
    const existing = await this.getCache(address, asset);
    
    const updateData = {
      droplets_total: droplets.toString(),
      last_calculated_end: lastCalculatedEnd,
      updated_at: new Date()
    };
    
    if (lastRoundCalculated !== undefined) {
      (updateData as any).last_round_calculated = lastRoundCalculated;
    }
    
    if (existing) {
      await this.db('droplets_cache')
        .where({ address, asset })
        .update(updateData);
    } else {
      await this.db('droplets_cache').insert({
        address,
        asset,
        ...updateData
      });
    }
  }
  
  /**
   * Get leaderboard of top addresses by droplets
   */
  async getLeaderboard(limit: number = 100): Promise<any[]> {
    // Get all cached droplets grouped by address
    const results = await this.db('droplets_cache')
      .select('address')
      .sum('droplets_total as total_droplets')
      .groupBy('address')
      .orderBy('total_droplets', 'desc')
      .limit(limit);
    
    return results.map((row, index) => ({
      rank: index + 1,
      address: row.address,
      droplets: row.total_droplets,
    }));
  }
  
  /**
   * Recalculate droplets for all addresses (for validation)
   */
  async recalculateAll(_startTime?: Date, _endTime?: Date): Promise<void> {
    logger.info('Starting full recalculation of all droplets');
    
    // Get all unique addresses
    const addresses = await this.db('timeline_intervals')
      .distinct('address')
      .pluck('address');
    
    let processed = 0;
    for (const address of addresses) {
      await this.calculateDroplets(address);
      processed++;
      
      if (processed % 100 === 0) {
        logger.info(`Processed ${processed}/${addresses.length} addresses`);
      }
    }
    
    logger.info(`Recalculation complete: ${processed} addresses processed`);
  }
  
  /**
   * Validate timeline calculations
   */
  async validateTimeline(): Promise<boolean> {
    logger.info('Validating timeline calculations');
    
    // Check for gaps in timeline intervals
    const gaps = await this.db.raw(`
      SELECT t1.address, t1.asset, t1.end_time as gap_start, t2.start_time as gap_end
      FROM timeline_intervals t1
      JOIN timeline_intervals t2 ON t1.address = t2.address 
        AND t1.asset = t2.asset 
        AND t1.end_time < t2.start_time
      WHERE NOT EXISTS (
        SELECT 1 FROM timeline_intervals t3
        WHERE t3.address = t1.address 
          AND t3.asset = t1.asset 
          AND t3.start_time <= t1.end_time 
          AND t3.end_time >= t2.start_time
      )
      AND t1.end_time IS NOT NULL
      AND TIMESTAMPDIFF(SECOND, t1.end_time, t2.start_time) > 1
    `);
    
    if (gaps.length > 0) {
      logger.warn(`Found ${gaps.length} timeline gaps`);
      return false;
    }
    
    logger.info('Timeline validation passed');
    return true;
  }
}
