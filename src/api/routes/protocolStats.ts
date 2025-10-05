import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { createLogger } from '../../utils/logger';
import { getDb } from '../../db/connection';

const logger = createLogger('API:ProtocolStats');

const querySchema = z.object({
  timestamp: z.string().optional().transform(val => val ? new Date(val) : undefined),
});

export const protocolStatsRoutes: FastifyPluginAsync = async (fastify) => {
  const db = getDb();
  
  /**
   * GET /protocolStats
   * Returns latest or historical daily snapshots data
   * Optional timestamp parameter to get historical data (returns snapshot for day before timestamp)
   */
  fastify.get('/', async (request, reply) => {
    try {
      const { timestamp } = querySchema.parse(request.query);
      
      logger.info(`Getting protocol stats${timestamp ? ` for timestamp ${timestamp}` : ' (latest)'}`);
      
      let query = db('daily_snapshots');
      
      if (timestamp) {
        // Get snapshot for the date before the provided timestamp
        const targetDate = new Date(timestamp);
        targetDate.setDate(targetDate.getDate() - 1); // Previous day
        const targetDateString = targetDate.toISOString().split('T')[0]; // YYYY-MM-DD format
        
        query = query
          .where('snapshot_date', '<=', targetDateString)
          .orderBy('snapshot_date', 'desc')
          .first();
      } else {
        // Get the latest snapshot
        query = query
          .orderBy('snapshot_date', 'desc')
          .first();
      }
      
      const snapshot = await query;
      
      if (!snapshot) {
        return reply.status(404).send({
          error: timestamp 
            ? 'No protocol stats found for the specified timestamp' 
            : 'No protocol stats available',
        });
      }

      // Type assertion to fix TypeScript inference issue with Knex first()
      const snapshotRecord = snapshot as any;

      // Parse total integration breakdown JSON
      let totalIntegrationBreakdown = {};
      try {
        totalIntegrationBreakdown = JSON.parse(snapshotRecord.total_integration_breakdown || '{}');
      } catch (e) {
        logger.warn(`Failed to parse total integration breakdown: ${e}`);
      }

      // Return the daily snapshot data with parsed JSON fields
      // USD values are stored with 6 implied decimals, so divide by 1,000,000
      const protocolStats = {
        id: snapshotRecord.id,
        snapshotDate: snapshotRecord.snapshot_date,
        totalProtocolUsd: (parseFloat(snapshotRecord.total_protocol_usd) / 1_000_000).toFixed(6),
        totalXethShares: snapshotRecord.total_xeth_shares,
        totalXethUsd: (parseFloat(snapshotRecord.total_xeth_usd) / 1_000_000).toFixed(6),
        totalXbtcShares: snapshotRecord.total_xbtc_shares,
        totalXbtcUsd: (parseFloat(snapshotRecord.total_xbtc_usd) / 1_000_000).toFixed(6),
        totalXusdShares: snapshotRecord.total_xusd_shares,
        totalXusdUsd: (parseFloat(snapshotRecord.total_xusd_usd) / 1_000_000).toFixed(6),
        totalXeurShares: snapshotRecord.total_xeur_shares,
        totalXeurUsd: (parseFloat(snapshotRecord.total_xeur_usd) / 1_000_000).toFixed(6),
        totalIntegrationBreakdown,
        totalUsers: snapshotRecord.total_users,
        dailyProtocolDroplets: snapshotRecord.daily_protocol_droplets,
        totalProtocolDroplets: snapshotRecord.total_protocol_droplets,
        ethUsdPrice: snapshotRecord.eth_usd_price ? (parseFloat(snapshotRecord.eth_usd_price) / 1_000_000).toFixed(6) : null,
        btcUsdPrice: snapshotRecord.btc_usd_price ? (parseFloat(snapshotRecord.btc_usd_price) / 1_000_000).toFixed(6) : null,
        eurUsdPrice: snapshotRecord.eur_usd_price ? (parseFloat(snapshotRecord.eur_usd_price) / 1_000_000).toFixed(6) : null,
        snapshotTimestamp: snapshotRecord.snapshot_timestamp,
        createdAt: snapshotRecord.created_at,
      };

      return reply.send(protocolStats);
      
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({
          error: 'Invalid query parameters',
          details: error.errors,
        });
      }
      
      logger.error('Error fetching protocol stats:', error);
      return reply.status(500).send({
        error: 'Failed to fetch protocol stats',
      });
    }
  });
};
