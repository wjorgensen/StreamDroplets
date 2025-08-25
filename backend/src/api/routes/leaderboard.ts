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
      
      // Use AccrualEngine to get proper leaderboard with exclusions
      const leaderboardData = await accrualEngine.getLeaderboard(limit);
      
      // If no data from AccrualEngine, fall back to filtered current_balances
      if (leaderboardData.length === 0) {
        const db = getDb();
        
        // Get excluded addresses
        const excludedAddresses = await db('excluded_addresses').pluck('address');
        
        const results = await db('current_balances')
          .select('address')
          .sum('shares as total_shares')
          .whereNotIn('address', excludedAddresses)
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
      }
      
      // Format the AccrualEngine data
      const formattedLeaderboard = await Promise.all(
        leaderboardData.map(async (item) => {
          const dropletData = await accrualEngine.calculateDroplets(item.address);
          return {
            rank: item.rank,
            address: item.address,
            droplets: item.droplets,
            breakdown: dropletData.breakdown,
          };
        })
      );
      
      return reply.send({
        data: formattedLeaderboard,
        pagination: {
          limit,
          offset,
          total: formattedLeaderboard.length,
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