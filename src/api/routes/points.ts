import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { TimelineAccrualEngine } from '../../accrual/TimelineAccrualEngine';
import { createLogger } from '../../utils/logger';
import { getDb } from '../../db/connection';

const logger = createLogger('API:Points');

const paramsSchema = z.object({
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
});

export const pointsRoutes: FastifyPluginAsync = async (fastify) => {
  const accrualEngine = new TimelineAccrualEngine();
  
  /**
   * GET /points/:address
   * Returns current droplets balance for an address
   */
  fastify.get('/:address', async (request, reply) => {
    try {
      const { address } = paramsSchema.parse(request.params);
      
      logger.info(`Getting droplets for ${address}`);
      
      // For now, get data from current_balances
      const db = getDb();
      const balances = await db('current_balances')
        .where('address', address.toLowerCase())
        .select('asset', 'shares');
      
      if (balances.length === 0) {
        return reply.status(404).send({
          error: 'Address not found',
        });
      }
      
      const breakdown: any = {
        xETH: '0',
        xBTC: '0',
        xUSD: '0',
        xEUR: '0',
      };
      
      let total = 0n;
      for (const balance of balances) {
        breakdown[balance.asset] = balance.shares;
        total += BigInt(balance.shares);
      }
      
      const result = {
        address: address.toLowerCase(),
        droplets: total.toString(),
        breakdown,
      };
      
      return reply.send(result);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({
          error: 'Invalid address format',
          details: error.errors,
        });
      }
      
      logger.error('Error calculating droplets:', error);
      return reply.status(500).send({
        error: 'Failed to calculate droplets',
      });
    }
  });
  
  /**
   * GET /points/:address/:asset
   * Returns droplets for a specific asset
   */
  fastify.get('/:address/:asset', async (request, reply) => {
    try {
      const address = (request.params as any).address;
      const asset = (request.params as any).asset;
      
      if (!['xETH', 'xBTC', 'xUSD', 'xEUR'].includes(asset)) {
        return reply.status(400).send({
          error: 'Invalid asset. Must be xETH, xBTC, xUSD, or xEUR',
        });
      }
      
      const droplets = await accrualEngine.calculateDropletsForAsset(
        address.toLowerCase(),
        asset as any
      );
      
      return reply.send({
        address,
        asset,
        droplets: droplets.toString(),
        lastUpdated: new Date(),
      });
    } catch (error) {
      logger.error('Error calculating asset droplets:', error);
      return reply.status(500).send({
        error: 'Failed to calculate droplets',
      });
    }
  });
  
  /**
   * GET /points/:address/range
   * Returns droplets for a specific time range
   */
  fastify.get('/:address/range', async (request, reply) => {
    try {
      const address = (request.params as any).address;
      const { startTime, endTime, asset } = request.query as any;
      
      const start = startTime ? new Date(startTime) : undefined;
      const end = endTime ? new Date(endTime) : undefined;
      
      if (asset) {
        if (!['xETH', 'xBTC', 'xUSD', 'xEUR'].includes(asset)) {
          return reply.status(400).send({
            error: 'Invalid asset. Must be xETH, xBTC, xUSD, or xEUR',
          });
        }
        
        const droplets = await accrualEngine.calculateDropletsForRange(
          address.toLowerCase(),
          asset,
          start,
          end
        );
        
        return reply.send({
          address,
          asset,
          droplets: droplets.toString(),
          startTime: start,
          endTime: end,
          lastUpdated: new Date(),
        });
      } else {
        // Calculate for all assets in range
        const result = await accrualEngine.calculateDroplets(address.toLowerCase());
        return reply.send({
          ...result,
          startTime: start,
          endTime: end,
        });
      }
    } catch (error) {
      logger.error('Error calculating range droplets:', error);
      return reply.status(500).send({
        error: 'Failed to calculate droplets',
      });
    }
  });
};
