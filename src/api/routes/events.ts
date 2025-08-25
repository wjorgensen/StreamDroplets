import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../db/connection';
import { createLogger } from '../../utils/logger';

const logger = createLogger('API:Events');

const paramsSchema = z.object({
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
});

const querySchema = z.object({
  asset: z.enum(['xETH', 'xBTC', 'xUSD', 'xEUR']).optional(),
  event_type: z.string().optional(),
  limit: z.string().optional().transform(val => val ? parseInt(val) : 100),
  offset: z.string().optional().transform(val => val ? parseInt(val) : 0),
});

export const eventsRoutes: FastifyPluginAsync = async (fastify) => {
  const db = getDb();
  
  /**
   * GET /events/:address
   * Returns event history for an address
   */
  fastify.get('/:address', async (request, reply) => {
    try {
      const { address } = paramsSchema.parse(request.params);
      const { asset, event_type, limit, offset } = querySchema.parse(request.query);
      
      let query = db('share_events')
        .where('address', address.toLowerCase())
        .orderBy('timestamp', 'desc')
        .limit(limit)
        .offset(offset);
      
      if (asset) {
        query = query.where('asset', asset);
      }
      
      if (event_type) {
        query = query.where('event_type', event_type);
      }
      
      const events = await query;
      
      return reply.send({
        address,
        events: events.map(event => ({
          type: event.event_type,
          classification: event.event_classification,
          shares_delta: event.shares_delta,
          asset: event.asset,
          round_id: event.round_id,
          timestamp: event.timestamp,
          tx_hash: event.tx_hash,
          chain_id: event.chain_id,
        })),
        pagination: {
          limit,
          offset,
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({
          error: 'Invalid parameters',
          details: error.errors,
        });
      }
      
      logger.error('Error fetching events:', error);
      return reply.status(500).send({
        error: 'Failed to fetch events',
      });
    }
  });
  
  /**
   * GET /events/:address/summary
   * Returns event summary for an address
   */
  fastify.get('/:address/summary', async (request, reply) => {
    try {
      const { address } = paramsSchema.parse(request.params);
      
      const summary = await db('share_events')
        .where('address', address.toLowerCase())
        .select('event_classification')
        .count('* as count')
        .groupBy('event_classification');
      
      const totalEvents = await db('share_events')
        .where('address', address.toLowerCase())
        .count('* as total')
        .first();
      
      return reply.send({
        address,
        total_events: totalEvents?.total || 0,
        breakdown: summary.reduce((acc, item) => {
          acc[item.event_classification] = parseInt(item.count as string);
          return acc;
        }, {} as Record<string, number>),
      });
    } catch (error) {
      logger.error('Error fetching event summary:', error);
      return reply.status(500).send({
        error: 'Failed to fetch event summary',
      });
    }
  });
};