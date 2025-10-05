import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { createLogger } from '../../utils/logger';
import { getDb } from '../../db/connection';

const logger = createLogger('API:Leaderboard');

const querySchema = z.object({
  limit: z.string().optional().transform(val => val ? parseInt(val) : 100),
  offset: z.string().optional().transform(val => val ? parseInt(val) : 0),
});

export const leaderboardRoutes: FastifyPluginAsync = async (fastify) => {
  const db = getDb();
  
  /**
   * GET /leaderboard
   * Returns top addresses by droplets with pagination
   */
  fastify.get('/', async (request, reply) => {
    try {
      const { limit, offset } = querySchema.parse(request.query);
      
      if (limit > 1000) {
        return reply.status(400).send({
          error: 'Limit cannot exceed 1000',
        });
      }
      
      // Get each unique address with their latest snapshot (most recent date they appear)
      // This includes users who may have withdrawn all money but earned droplets in the past
      const latestSnapshotsSubquery = db('user_daily_snapshots as uds1')
        .select('address')
        .max('snapshot_date as latest_date')
        .groupBy('address');
      
      // Get the full snapshot data for each address's latest date
      const leaderboardData = await db('user_daily_snapshots as uds2')
        .select([
          'uds2.address',
          'uds2.total_droplets',
          'uds2.snapshot_date as last_active',
          'uds2.total_usd_value',
          'uds2.xeth_shares_total',
          'uds2.xeth_usd_value',
          'uds2.xbtc_shares_total', 
          'uds2.xbtc_usd_value',
          'uds2.xusd_shares_total',
          'uds2.xusd_usd_value',
          'uds2.xeur_shares_total',
          'uds2.xeur_usd_value',
          'uds2.integration_breakdown'
        ])
        .joinRaw('INNER JOIN (?) as latest ON uds2.address = latest.address AND uds2.snapshot_date = latest.latest_date', [latestSnapshotsSubquery])
        .orderBy('uds2.total_droplets', 'desc')
        .limit(limit)
        .offset(offset);
      
      // Get total count for pagination
      const [{ count }] = await db('user_daily_snapshots as uds1')
        .countDistinct('address as count');
      
      // Format the leaderboard data
      // USD values are stored with 6 implied decimals, so divide by 1,000,000
      const formattedLeaderboard = leaderboardData.map((entry, index) => {
        let integrationBreakdown = {};
        try {
          integrationBreakdown = JSON.parse(entry.integration_breakdown || '{}');
        } catch (e) {
          logger.warn(`Failed to parse integration breakdown for ${entry.address}: ${e}`);
        }

        return {
          rank: offset + index + 1,
          address: entry.address,
          totalDroplets: entry.total_droplets,
          lastActive: entry.last_active,
          totalUsdValue: (parseFloat(entry.total_usd_value) / 1_000_000).toFixed(6),
          balances: {
            xeth: {
              shares: entry.xeth_shares_total,
              usdValue: (parseFloat(entry.xeth_usd_value) / 1_000_000).toFixed(6),
            },
            xbtc: {
              shares: entry.xbtc_shares_total,
              usdValue: (parseFloat(entry.xbtc_usd_value) / 1_000_000).toFixed(6),
            },
            xusd: {
              shares: entry.xusd_shares_total,
              usdValue: (parseFloat(entry.xusd_usd_value) / 1_000_000).toFixed(6),
            },
            xeur: {
              shares: entry.xeur_shares_total,
              usdValue: (parseFloat(entry.xeur_usd_value) / 1_000_000).toFixed(6),
            },
          },
          integrationBreakdown,
        };
      });
      
      return reply.send({
        data: formattedLeaderboard,
        pagination: {
          limit,
          offset,
          total: Number(count),
          hasMore: offset + limit < Number(count),
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({
          error: 'Invalid query parameters',
          details: error.errors,
        });
      }
      
      logger.error('Error fetching leaderboard:', error);
      return reply.status(500).send({
        error: 'Failed to fetch leaderboard',
      });
    }
  });
};