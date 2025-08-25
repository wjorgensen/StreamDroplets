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
      // Simple database connection test
      const dbHealthy = await testConnection();
      
      if (!dbHealthy) {
        return reply.status(503).send({
          status: 'unhealthy',
          timestamp: new Date(),
          database: 'disconnected',
        });
      }
      
      // Basic health status - keep it simple for Railway
      const status = {
        status: 'healthy',
        timestamp: new Date(),
        database: 'connected',
        service: 'stream-droplets-api',
        version: '1.0.0'
      };
      
      // Try to get basic stats if possible (but don't fail if not)
      try {
        const userCount = await db('current_balances')
          .countDistinct('address as count')
          .first()
          .timeout(1000); // 1 second timeout
        
        if (userCount) {
          (status as any).users = userCount.count || 0;
        }
      } catch (e) {
        // Ignore errors getting stats
      }
      
      return reply.status(200).send(status);
      
    } catch (error) {
      return reply.status(503).send({
        status: 'unhealthy',
        timestamp: new Date(),
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