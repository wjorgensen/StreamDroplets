import { FastifyPluginAsync } from 'fastify';
import { getDb } from '../../db/connection';
import { testConnection } from '../../db/connection';

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
  const db = getDb();
  
  /**
   * GET /health
   * Returns service health status
   */
  fastify.get('/', async (_request, reply) => {
    try {
      // Test database connection
      const dbHealthy = await testConnection();
      
      // Get indexer status
      const cursors = await db('cursors').select('*');
      
      // Get latest blocks for each chain
      const indexerStatus = await Promise.all(
        cursors.map(async (cursor) => {
          const latestEvent = await db('share_events')
            .where('chain_id', cursor.chain_id)
            .orderBy('block', 'desc')
            .first();
          
          return {
            chain_id: cursor.chain_id,
            contract: cursor.contract_address,
            last_safe_block: cursor.last_safe_block,
            last_event_block: latestEvent?.block || 0,
            updated_at: cursor.updated_at,
          };
        })
      );
      
      // Calculate lag
      const now = Date.now();
      const maxLag = Math.max(
        ...indexerStatus.map(status => 
          now - new Date(status.updated_at).getTime()
        )
      );
      
      const status = {
        status: dbHealthy ? 'healthy' : 'unhealthy',
        timestamp: new Date(),
        database: dbHealthy ? 'connected' : 'disconnected',
        indexer: {
          status: maxLag < 60000 ? 'synced' : 'lagging',
          lag_ms: maxLag,
          chains: indexerStatus,
        },
      };
      
      return reply
        .status(dbHealthy ? 200 : 503)
        .send(status);
      
    } catch (error) {
      return reply.status(503).send({
        status: 'unhealthy',
        error: 'Health check failed',
      });
    }
  });
  
  /**
   * GET /health/ready
   * Returns readiness status
   */
  fastify.get('/ready', async (_request, reply) => {
    try {
      const dbHealthy = await testConnection();
      
      if (!dbHealthy) {
        return reply.status(503).send({ ready: false });
      }
      
      // Check if we have any rounds indexed
      const roundCount = await db('rounds').count('* as count').first() as {count: number} | undefined;
      const hasRounds = (roundCount?.count || 0) > 0;
      
      return reply
        .status(hasRounds ? 200 : 503)
        .send({ ready: hasRounds });
      
    } catch (error) {
      return reply.status(503).send({ ready: false });
    }
  });
  
  /**
   * GET /health/live
   * Returns liveness status
   */
  fastify.get('/live', async (_request, reply) => {
    return reply.send({ alive: true });
  });
};