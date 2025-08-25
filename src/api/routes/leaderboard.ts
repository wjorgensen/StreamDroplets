import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AccrualEngine } from '../../accrual/AccrualEngine';
import { createLogger } from '../../utils/logger';
import { getDb } from '../../db/connection';

const logger = createLogger('API:Leaderboard');

const querySchema = z.object({
  limit: z.string().optional().transform(val => val ? parseInt(val) : 100),
  offset: z.string().optional().transform(val => val ? parseInt(val) : 0),
});

export const leaderboardRoutes: FastifyPluginAsync = async (fastify) => {
  const accrualEngine = new AccrualEngine();
  
  /**
   * GET /leaderboard
   * Returns top addresses by droplets
   */
  fastify.get('/', async (request, reply) => {
    try {
      const { limit, offset } = querySchema.parse(request.query);
      
      if (limit > 1000) {
        return reply.status(400).send({
          error: 'Limit cannot exceed 1000',
        });
      }
      
      // For now, get data from current_balances since droplets_cache isn't populated
      const db = getDb();
      const results = await db('current_balances')
        .select('address')
        .sum('shares as total_shares')
        .groupBy('address')
        .orderBy('total_shares', 'desc')
        .limit(limit);
      
      const leaderboard = results.map((row, index) => ({
        rank: index + 1,
        address: row.address,
        droplets: row.total_shares,
        breakdown: {
          xETH: '0',
          xBTC: '0',
          xUSD: '0',
          xEUR: '0',
        }
      }));
      
      return reply.send({
        data: leaderboard,
        pagination: {
          limit,
          offset,
          total: leaderboard.length,
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