import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { config } from '../config';
import { createLogger } from '../utils/logger';
import { pointsRoutes } from './routes/points';
import { leaderboardRoutes } from './routes/leaderboard';
import { eventsRoutes } from './routes/events';
import { roundsRoutes } from './routes/rounds';
import { adminRoutes } from './routes/admin';
import { healthRoutes } from './routes/health';
import { testConnection } from '../db/connection';

const logger = createLogger('API');

export async function createServer() {
  const fastify = Fastify({
    logger: false, // We use our own logger
    trustProxy: true,
  });
  
  // Register plugins
  await fastify.register(cors, {
    origin: true,
    credentials: true,
  });
  
  await fastify.register(helmet, {
    contentSecurityPolicy: false,
  });
  
  await fastify.register(rateLimit, {
    max: config.api.rateLimit,
    timeWindow: '1 minute',
  });
  
  // Register routes under /api/v1
  await fastify.register(pointsRoutes, { prefix: '/api/v1/points' });
  await fastify.register(leaderboardRoutes, { prefix: '/api/v1/leaderboard' });
  await fastify.register(eventsRoutes, { prefix: '/api/v1/events' });
  await fastify.register(roundsRoutes, { prefix: '/api/v1/rounds' });
  await fastify.register(adminRoutes, { prefix: '/api/v1/admin' });
  await fastify.register(healthRoutes, { prefix: '/api/v1/health' });
  
  // Error handler
  fastify.setErrorHandler((error, _request, reply) => {
    logger.error('Request error:', error);
    reply.status(error.statusCode || 500).send({
      error: error.message || 'Internal Server Error',
    });
  });
  
  return fastify;
}

export async function startServer() {
  // Test database connection
  const dbConnected = await testConnection();
  if (!dbConnected) {
    logger.error('Failed to connect to database');
    process.exit(1);
  }
  
  const fastify = await createServer();
  
  try {
    await fastify.listen({
      port: config.api.port,
      host: config.api.host,
    });
    
    logger.info(`Server listening on ${config.api.host}:${config.api.port}`);
  } catch (error) {
    logger.error('Failed to start server:', error);
    console.error('Full error:', error);
    process.exit(1);
  }
}

// Start server if run directly
if (require.main === module) {
  startServer();
}