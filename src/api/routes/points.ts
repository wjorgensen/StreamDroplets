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
   * Returns current droplets balance for an address from latest user_daily_snapshots
   */
  fastify.get('/:address', async (request, reply) => {
    try {
      const { address } = paramsSchema.parse(request.params);
      
      logger.info(`Getting droplets for ${address}`);
      
      // Get the latest user daily snapshot for this address
      const latestSnapshot = await db('user_daily_snapshots')
        .where('address', address.toLowerCase())
        .orderBy('snapshot_date', 'desc')
        .first();
      
      if (!latestSnapshot) {
        return reply.status(404).send({
          error: 'Address not found or has no snapshots',
        });
      }
      
      return reply.send({
        address: latestSnapshot.address,
        droplets: latestSnapshot.total_droplets,
        lastUpdated: latestSnapshot.snapshot_timestamp,
        snapshotDate: latestSnapshot.snapshot_date,
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