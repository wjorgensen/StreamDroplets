import { getDb } from '../db/connection';
import { config } from '../config';
import { CONSTANTS, AssetType } from '../config/constants';
import { createLogger } from '../utils/logger';
import { DropletsResult, Round, BalanceSnapshot } from '../types';
import { ChainlinkService } from '../oracle/ChainlinkService';
// import { BalanceTracker } from '../indexer/BalanceTracker';

const logger = createLogger('AccrualEngine');

export class AccrualEngine {
  private db = getDb();
  private oracleService: ChainlinkService;
  // private balanceTracker: BalanceTracker;
  private ratePerUsdPerRound: bigint;
  
  constructor() {
    this.oracleService = new ChainlinkService();
    // this.balanceTracker = new BalanceTracker();
    this.ratePerUsdPerRound = BigInt(config.droplets.ratePerUsdPerRound);
  }
  
  /**
   * Calculates total droplets for an address across all assets
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
   * Calculates droplets for a specific asset using round-based logic
   */
  async calculateDropletsForAsset(address: string, asset: AssetType): Promise<bigint> {
    // Check cache first
    const cached = await this.getCache(address, asset);
    const currentRound = await this.getCurrentRound(asset);
    
    if (cached && cached.last_round_calculated >= currentRound - 1) {
      return BigInt(cached.droplets_total);
    }
    
    // Get all completed rounds for this asset
    const rounds = await this.getRounds(asset);
    let totalDroplets = 0n;
    
    for (const round of rounds) {
      // Skip future/current round (not yet completed)
      if (round.round_id >= currentRound) continue;
      
      // Calculate droplets for this round
      const dropletsThisRound = await this.calculateRoundDroplets(address, asset, round);
      totalDroplets += dropletsThisRound;
      
      if (dropletsThisRound > 0n) {
        logger.debug(`Round ${round.round_id} droplets for ${address} ${asset}: ${dropletsThisRound}`);
      }
    }
    
    // Update cache
    await this.updateCache(address, asset, totalDroplets, new Date(), currentRound - 1);
    
    return totalDroplets;
  }
  
  /**
   * Calculates droplets for a specific round
   * Core logic: User earns IFF they held shares at round start AND didn't unstake during round
   */
  private async calculateRoundDroplets(
    address: string,
    asset: AssetType,
    round: Round
  ): Promise<bigint> {
    // Get balance snapshot for this round
    const snapshot = await this.getSnapshot(address, asset, round.round_id);
    
    // No shares at round start = no earnings
    if (!snapshot || BigInt(snapshot.shares_at_start) === 0n) {
      return 0n;
    }
    
    // Unstaked during round = no earnings (withdraw round exclusion)
    if (snapshot.had_unstake_in_round) {
      logger.debug(`Address ${address} unstaked during round ${round.round_id}, no droplets earned`);
      return 0n;
    }
    
    // Calculate USD exposure
    const sharesAtStart = BigInt(snapshot.shares_at_start);
    const pps = BigInt(round.pps);
    const ppsScale = 10n ** CONSTANTS.PPS_SCALE;
    
    // Calculate underlying assets
    const assets = (sharesAtStart * pps) / ppsScale;
    
    // Get USD price at round start
    const priceUsd = await this.oracleService.fetchPriceAtRoundStart(asset, round);
    
    // Calculate USD value (assets * price / price_scale)
    const assetDecimals = CONSTANTS.ASSET_DECIMALS[asset];
    const assetScale = 10n ** assetDecimals;
    const oracleScale = 10n ** CONSTANTS.ORACLE_SCALE;
    
    // USD value = assets * price / oracle_scale
    // We keep asset decimals for precision
    const usdValue = (assets * priceUsd) / oracleScale;
    
    // Calculate droplets for this round
    // droplets = usd_value * rate_per_usd_per_round
    const dropletsThisRound = (usdValue * this.ratePerUsdPerRound) / assetScale;
    
    return dropletsThisRound;
  }
  
  /**
   * Gets all rounds for an asset
   */
  private async getRounds(asset: AssetType): Promise<Round[]> {
    return await this.db('rounds')
      .where({ asset, chain_id: CONSTANTS.CHAIN_IDS.ETHEREUM }) // Use Ethereum as canonical
      .orderBy('round_id', 'asc');
  }
  
  /**
   * Gets the current round number
   */
  private async getCurrentRound(asset: AssetType): Promise<number> {
    const latestRound = await this.db('rounds')
      .where({ asset, chain_id: CONSTANTS.CHAIN_IDS.ETHEREUM })
      .orderBy('round_id', 'desc')
      .first();
    
    return latestRound ? latestRound.round_id + 1 : 1;
  }
  
  /**
   * Gets balance snapshot for a round
   */
  private async getSnapshot(
    address: string,
    asset: AssetType,
    roundId: number
  ): Promise<BalanceSnapshot | null> {
    return await this.db('balance_snapshots')
      .where({ address, asset, round_id: roundId })
      .first();
  }
  
  /**
   * Gets cached droplets
   */
  private async getCache(address: string, asset: AssetType) {
    return await this.db('droplets_cache')
      .where({ address, asset })
      .first();
  }
  
  /**
   * Updates droplets cache
   */
  private async updateCache(
    address: string,
    asset: AssetType,
    droplets: bigint,
    updatedAt: Date,
    lastRoundCalculated?: number
  ): Promise<void> {
    const existing = await this.getCache(address, asset);
    
    if (existing) {
      await this.db('droplets_cache')
        .where({ address, asset })
        .update({
          droplets_total: droplets.toString(),
          last_round_calculated: lastRoundCalculated || existing.last_round_calculated,
          updated_at: updatedAt,
        });
    } else {
      await this.db('droplets_cache').insert({
        address,
        asset,
        droplets_total: droplets.toString(),
        last_round_calculated: lastRoundCalculated || 0,
        updated_at: updatedAt,
      });
    }
  }
  
  /**
   * Gets leaderboard of top addresses by droplets
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
   * Recalculates droplets for all addresses (for validation)
   */
  async recalculateAll(): Promise<void> {
    logger.info('Starting full recalculation of all droplets');
    
    // Get all unique addresses
    const addresses = await this.db('balance_snapshots')
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
}