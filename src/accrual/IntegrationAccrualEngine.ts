/**
 * Integration Accrual Engine
 * Calculates droplets for user positions in integrated protocols
 * Works alongside the main AccrualEngine to provide complete droplet calculations
 */

import { getDb } from '../db/connection';
import { config } from '../config';
import { createLogger } from '../utils/logger';

const logger = createLogger('IntegrationAccrualEngine');

interface IntegrationDropletsResult {
  address: string;
  totalDroplets: string;
  breakdown: {
    protocolId: number;
    protocolName: string;
    droplets: string;
    usdValue: string;
  }[];
  lastUpdated: Date;
}

export class IntegrationAccrualEngine {
  private db = getDb();
  private ratePerUsdPerRound: bigint;

  constructor() {
    this.ratePerUsdPerRound = BigInt(config.droplets.ratePerUsdPerRound);
  }

  /**
   * Calculate total droplets from all integration positions for an address
   */
  async calculateIntegrationDroplets(address: string): Promise<IntegrationDropletsResult> {
    const normalizedAddress = address.toLowerCase();
    
    // Get all active integration positions for this address
    const positions = await this.db('integration_positions as ip')
      .join('integration_protocols as p', 'ip.protocol_id', 'p.id')
      .where('ip.user_address', normalizedAddress)
      .where('p.is_active', true)
      .select(
        'ip.*',
        'p.protocol_name',
        'p.integration_type',
        'p.chain_id',
        'p.underlying_asset'
      );

    const breakdown = [];
    let totalDroplets = 0n;

    for (const position of positions) {
      const dropletsForPosition = await this.calculatePositionDroplets(position);
      
      breakdown.push({
        protocolId: position.protocol_id,
        protocolName: position.protocol_name,
        droplets: dropletsForPosition.toString(),
        usdValue: position.usd_value,
      });

      totalDroplets += dropletsForPosition;
    }

    return {
      address,
      totalDroplets: totalDroplets.toString(),
      breakdown,
      lastUpdated: new Date(),
    };
  }

  /**
   * Calculate droplets for a specific integration position
   */
  private async calculatePositionDroplets(position: any): Promise<bigint> {
    // Check cache first
    const cached = await this.getCache(position.user_address, position.protocol_id);
    const currentRound = await this.getCurrentRound();

    if (cached && cached.last_round_calculated >= currentRound - 1) {
      return BigInt(cached.droplets_total);
    }

    // Get all rounds where this position was active
    const rounds = await this.getRoundsForPosition(position);
    let totalDroplets = 0n;

    for (const round of rounds) {
      // Skip future/current round
      if (round.round_id >= currentRound) continue;

      // Calculate droplets for this round
      const dropletsThisRound = await this.calculateRoundDroplets(position, round);
      totalDroplets += dropletsThisRound;

      if (dropletsThisRound > 0n) {
        logger.debug(`Round ${round.round_id} droplets for ${position.user_address} in ${position.protocol_name}: ${dropletsThisRound}`);
      }
    }

    // Update cache
    await this.updateCache(position.user_address, position.protocol_id, totalDroplets, currentRound - 1);

    return totalDroplets;
  }

  /**
   * Calculate droplets for a position in a specific round
   */
  private async calculateRoundDroplets(position: any, round: any): Promise<bigint> {
    // Get the position's USD value at the round timestamp
    const positionAtRound = await this.getPositionAtTimestamp(
      position.protocol_id,
      position.user_address,
      round.start_ts,
      round.end_ts
    );

    if (!positionAtRound || BigInt(positionAtRound.usd_value) === 0n) {
      return 0n;
    }

    // Check if user maintained position throughout the round
    const hasWithdrawn = await this.hasWithdrawnDuringRound(
      position.protocol_id,
      position.user_address,
      round.start_ts,
      round.end_ts
    );

    if (hasWithdrawn) {
      logger.debug(`User ${position.user_address} withdrew from ${position.protocol_name} during round ${round.round_id}, no droplets awarded`);
      return 0n;
    }

    // Calculate droplets: 1 droplet per USD per round
    const usdValue = BigInt(positionAtRound.usd_value);
    const droplets = (usdValue * this.ratePerUsdPerRound) / (10n ** 6n); // Assuming USD has 6 decimals like USDC

    return droplets;
  }

  /**
   * Get position value at a specific timestamp
   */
  private async getPositionAtTimestamp(
    protocolId: number,
    userAddress: string,
    _startTime: Date,
    endTime: Date
  ): Promise<any> {
    // Get the latest position state before or at the round end
    return await this.db('integration_positions')
      .where('protocol_id', protocolId)
      .where('user_address', userAddress.toLowerCase())
      .where('timestamp', '<=', endTime)
      .orderBy('timestamp', 'desc')
      .first();
  }

  /**
   * Check if user withdrew during a round
   */
  private async hasWithdrawnDuringRound(
    protocolId: number,
    userAddress: string,
    _startTime: Date,
    endTime: Date
  ): Promise<boolean> {
    const withdrawalEvents = await this.db('integration_events')
      .where('protocol_id', protocolId)
      .where('user_address', userAddress.toLowerCase())
      .whereIn('event_type', ['withdraw', 'burn', 'redeem'])
      .where('timestamp', '<=', endTime)
      .count('* as count');

    return Number(withdrawalEvents[0].count) > 0;
  }

  /**
   * Get rounds for a position based on when it was active
   */
  private async getRoundsForPosition(position: any): Promise<any[]> {
    // Get rounds for the underlying asset (e.g., xUSD)
    const rounds = await this.db('rounds')
      .where('asset', position.underlying_asset)
      .where('chain_id', 1) // Use Ethereum rounds as canonical
      .whereNotNull('end_ts')
      .orderBy('round_id', 'asc');

    // Filter to only rounds where position existed
    const firstEvent = await this.db('integration_events')
      .where('protocol_id', position.protocol_id)
      .where('user_address', position.user_address.toLowerCase())
      .orderBy('timestamp', 'asc')
      .first();

    if (!firstEvent) {
      return [];
    }

    return rounds.filter(round => round.end_ts >= firstEvent.timestamp);
  }

  /**
   * Get current round number
   */
  private async getCurrentRound(): Promise<number> {
    const latestRound = await this.db('rounds')
      .where('asset', 'xUSD')
      .where('chain_id', 1)
      .orderBy('round_id', 'desc')
      .first();

    return latestRound ? latestRound.round_id : 0;
  }

  /**
   * Get cached droplets calculation
   */
  private async getCache(userAddress: string, protocolId: number): Promise<any> {
    return await this.db('integration_droplets_cache')
      .where('user_address', userAddress.toLowerCase())
      .where('protocol_id', protocolId)
      .first();
  }

  /**
   * Update droplets cache
   */
  private async updateCache(
    userAddress: string,
    protocolId: number,
    droplets: bigint,
    lastRound: number
  ): Promise<void> {
    await this.db('integration_droplets_cache')
      .insert({
        user_address: userAddress.toLowerCase(),
        protocol_id: protocolId,
        droplets_total: droplets.toString(),
        last_round_calculated: lastRound,
        updated_at: new Date(),
      })
      .onConflict(['user_address', 'protocol_id'])
      .merge();
  }

  /**
   * Get leaderboard for integration protocols
   */
  async getIntegrationLeaderboard(limit: number = 100): Promise<any[]> {
    const results = await this.db('integration_droplets_cache as c')
      .join('integration_protocols as p', 'c.protocol_id', 'p.id')
      .select(
        'c.user_address',
        this.db.raw('SUM(CAST(c.droplets_total AS DECIMAL)) as total_droplets')
      )
      .groupBy('c.user_address')
      .orderBy('total_droplets', 'desc')
      .limit(limit);

    return results.map(row => ({
      address: row.user_address,
      droplets: row.total_droplets,
    }));
  }

  /**
   * Get breakdown by protocol for an address
   */
  async getProtocolBreakdown(address: string): Promise<any[]> {
    const results = await this.db('integration_droplets_cache as c')
      .join('integration_protocols as p', 'c.protocol_id', 'p.id')
      .where('c.user_address', address.toLowerCase())
      .select(
        'p.protocol_name',
        'p.integration_type',
        'p.chain_id',
        'c.droplets_total',
        'c.last_round_calculated',
        'c.updated_at'
      );

    return results;
  }
}