import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { createLogger } from '../../utils/logger';
import { getDb } from '../../db/connection';

const logger = createLogger('API:Points');

const paramsSchema = z.object({
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
});

export const pointsRoutes: FastifyPluginAsync = async (fastify) => {
  const db = getDb();
  
  /**
   * GET /points/:address
   * Returns current droplets balance for an address
   */
  fastify.get('/:address', async (request, reply) => {
    try {
      const { address } = paramsSchema.parse(request.params);
      
      logger.info(`Getting droplets for ${address}`);
      
      // Get droplets from the pre-calculated leaderboard
      const leaderboardEntry = await db('leaderboard')
        .where('address', address.toLowerCase())
        .first();
      
      if (!leaderboardEntry) {
        // Check if address has any historical activity
        const hasActivity = await db('daily_snapshots')
          .where('address', address.toLowerCase())
          .first();
        
        if (!hasActivity) {
          return reply.status(404).send({
            error: 'Address not found',
          });
        }
        
        // Has activity but no droplets
        return reply.send({
          address,
          droplets: '0',
          lastUpdated: new Date(),
          breakdown: {
            total: '0',
          },
        });
      }
      
      // Get the latest snapshot for breakdown details
      const latestSnapshot = await db('daily_snapshots')
        .where('address', address.toLowerCase())
        .orderBy('snapshot_date', 'desc')
        .first();
      
      const breakdown: any = {
        total: leaderboardEntry.total_droplets,
      };
      
      if (latestSnapshot) {
        breakdown.xETH = latestSnapshot.xeth_usd_value || '0';
        breakdown.xBTC = latestSnapshot.xbtc_usd_value || '0';
        breakdown.xUSD = latestSnapshot.xusd_usd_value || '0';
        breakdown.xEUR = latestSnapshot.xeur_usd_value || '0';
        breakdown.integrations = latestSnapshot.integration_usd_value || '0';
        breakdown.lastSnapshotDate = latestSnapshot.snapshot_date;
        breakdown.lastDayEarned = latestSnapshot.droplets_earned || '0';
      }
      
      return reply.send({
        address,
        droplets: leaderboardEntry.total_droplets,
        lastUpdated: leaderboardEntry.last_updated || new Date(),
        breakdown,
        metadata: {
          daysParticipated: leaderboardEntry.days_participated || 0,
          averageUsdPerDay: leaderboardEntry.average_daily_usd || '0',
          firstSeen: leaderboardEntry.first_seen,
        }
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({
          error: 'Invalid address format',
        });
      }
      
      logger.error('Error fetching droplets:', error);
      return reply.status(500).send({
        error: 'Failed to fetch droplets',
      });
    }
  });
};