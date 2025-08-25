import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../db/connection';
import { config } from '../../config';
import { createLogger } from '../../utils/logger';
import { AccrualEngine } from '../../accrual/AccrualEngine';
import { EventIndexer } from '../../indexer/EventIndexer';

const logger = createLogger('API:Admin');

const configSchema = z.object({
  key: z.string(),
  value: z.string(),
});

const backfillSchema = z.object({
  asset: z.enum(['xETH', 'xBTC', 'xUSD', 'xEUR']),
  fromBlock: z.number().optional(),
  toBlock: z.number().optional(),
});

export const adminRoutes: FastifyPluginAsync = async (fastify) => {
  const db = getDb();
  
  // Admin authentication middleware
  fastify.addHook('preHandler', async (request, reply) => {
    const apiKey = request.headers['x-api-key'] as string;
    
    if (!config.api.adminKey || apiKey !== config.api.adminKey) {
      return reply.status(401).send({
        error: 'Unauthorized',
      });
    }
  });
  
  /**
   * POST /admin/config
   * Updates configuration values
   */
  fastify.post('/config', async (request, reply) => {
    try {
      const { key, value } = configSchema.parse(request.body);
      
      await db('config')
        .insert({ key, value })
        .onConflict('key')
        .merge(['value', 'updated_at']);
      
      logger.info(`Config updated: ${key}`);
      
      return reply.send({
        message: 'Configuration updated',
        key,
        value,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({
          error: 'Invalid configuration',
          details: error.errors,
        });
      }
      
      logger.error('Error updating config:', error);
      return reply.status(500).send({
        error: 'Failed to update configuration',
      });
    }
  });
  
  /**
   * GET /admin/config
   * Returns all configuration values
   */
  fastify.get('/config', async (request, reply) => {
    try {
      const configs = await db('config').select('*');
      
      return reply.send({
        configs: configs.reduce((acc, item) => {
          acc[item.key] = item.value;
          return acc;
        }, {} as Record<string, string>),
      });
    } catch (error) {
      logger.error('Error fetching config:', error);
      return reply.status(500).send({
        error: 'Failed to fetch configuration',
      });
    }
  });
  
  /**
   * POST /admin/recalculate
   * Triggers full recalculation of all droplets
   */
  fastify.post('/recalculate', async (request, reply) => {
    try {
      const accrualEngine = new AccrualEngine();
      
      // Run in background
      setImmediate(async () => {
        try {
          await accrualEngine.recalculateAll();
          logger.info('Recalculation completed');
        } catch (error) {
          logger.error('Recalculation failed:', error);
        }
      });
      
      return reply.send({
        message: 'Recalculation started',
      });
    } catch (error) {
      logger.error('Error starting recalculation:', error);
      return reply.status(500).send({
        error: 'Failed to start recalculation',
      });
    }
  });
  
  /**
   * POST /admin/backfill
   * Triggers historical data backfill
   */
  fastify.post('/backfill', async (request, reply) => {
    try {
      const params = backfillSchema.parse(request.body);
      
      logger.info('Starting backfill:', params);
      
      // This would trigger the backfill process
      // Implementation would depend on specific requirements
      
      return reply.send({
        message: 'Backfill started',
        params,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({
          error: 'Invalid backfill parameters',
          details: error.errors,
        });
      }
      
      logger.error('Error starting backfill:', error);
      return reply.status(500).send({
        error: 'Failed to start backfill',
      });
    }
  });
  
  /**
   * GET /admin/stats
   * Returns system statistics
   */
  fastify.get('/stats', async (request, reply) => {
    try {
      const stats = await Promise.all([
        db('share_events').count('* as total').first(),
        db('rounds').count('* as total').first(),
        db('balance_snapshots').count('* as total').first(),
        db('droplets_cache').count('* as total').first(),
        db('bridge_events').count('* as total').first(),
        db('current_balances')
          .count('* as addresses')
          .sum('shares as total_shares')
          .first(),
      ]);
      
      return reply.send({
        events: stats[0]?.total || 0,
        rounds: stats[1]?.total || 0,
        snapshots: stats[2]?.total || 0,
        cached_droplets: stats[3]?.total || 0,
        bridge_events: stats[4]?.total || 0,
        unique_addresses: stats[5]?.addresses || 0,
        total_shares: stats[5]?.total_shares || '0',
      });
    } catch (error) {
      logger.error('Error fetching stats:', error);
      return reply.status(500).send({
        error: 'Failed to fetch statistics',
      });
    }
  });
};