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

      // Return the daily snapshot data verbatim with parsed JSON fields
      const protocolStats = {
        id: snapshotRecord.id,
        snapshotDate: snapshotRecord.snapshot_date,
        totalProtocolUsd: snapshotRecord.total_protocol_usd,
        totalXethShares: snapshotRecord.total_xeth_shares,
        totalXethUsd: snapshotRecord.total_xeth_usd,
        totalXbtcShares: snapshotRecord.total_xbtc_shares,
        totalXbtcUsd: snapshotRecord.total_xbtc_usd,
        totalXusdShares: snapshotRecord.total_xusd_shares,
        totalXusdUsd: snapshotRecord.total_xusd_usd,
        totalXeurShares: snapshotRecord.total_xeur_shares,
        totalXeurUsd: snapshotRecord.total_xeur_usd,
        totalIntegrationBreakdown,
        totalUsers: snapshotRecord.total_users,
        dailyProtocolDroplets: snapshotRecord.daily_protocol_droplets,
        totalProtocolDroplets: snapshotRecord.total_protocol_droplets,
        ethUsdPrice: snapshotRecord.eth_usd_price,
        btcUsdPrice: snapshotRecord.btc_usd_price,
        eurUsdPrice: snapshotRecord.eur_usd_price,
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
