#!/usr/bin/env node

import fastify from 'fastify';
import { Client } from 'pg';

console.log('Starting Stream Droplets API Server...');
console.log('Environment:', {
  NODE_ENV: process.env.NODE_ENV,
  PORT: process.env.PORT || 8080,
  HAS_DATABASE_URL: !!process.env.DATABASE_URL,
});

async function testDatabase(): Promise<boolean> {
  if (!process.env.DATABASE_URL) {
    console.error('FATAL: DATABASE_URL not set!');
    return false;
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
  });

  try {
    await client.connect();
    await client.query('SELECT 1');
    await client.end();
    console.log('✅ Database connection OK');
    return true;
  } catch (error: any) {
    console.error('❌ Database connection failed:', error.message);
    return false;
  }
}

async function startServer() {
  // Test database first
  const dbOk = await testDatabase();
  if (!dbOk) {
    console.error('Cannot start server without database');
    process.exit(1);
  }

  try {
    const app = fastify({
      logger: {
        level: 'info',
        transport: process.env.NODE_ENV === 'production' ? undefined : {
          target: 'pino-pretty',
          options: {
            translateTime: 'HH:MM:ss Z',
            ignore: 'pid,hostname',
          },
        },
      },
    });

    // Register CORS for production
    await app.register(import('@fastify/cors'), {
      origin: true,
      credentials: true,
    });

    // Simple health check endpoint
    app.get('/api/v1/health', async (_request, reply) => {
      try {
        const client = new Client({
          connectionString: process.env.DATABASE_URL,
          ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
        });
        
        await client.connect();
        await client.query('SELECT 1');
        await client.end();
        
        return reply.status(200).send({
          status: 'healthy',
          timestamp: new Date().toISOString(),
          database: 'connected',
          service: 'stream-droplets-api',
          version: '1.0.0'
        });
      } catch (error) {
        return reply.status(503).send({
          status: 'unhealthy',
          timestamp: new Date().toISOString(),
          database: 'disconnected',
          error: (error as any).message,
        });
      }
    });

    // Register other routes
    const { pointsRoutes } = await import('./api/routes/points');
    const { leaderboardRoutes } = await import('./api/routes/leaderboard');
    const { eventsRoutes } = await import('./api/routes/events');
    const { roundsRoutes } = await import('./api/routes/rounds');
    
    await app.register(pointsRoutes, { prefix: '/api/v1/points' });
    await app.register(leaderboardRoutes, { prefix: '/api/v1/leaderboard' });
    await app.register(eventsRoutes, { prefix: '/api/v1/events' });
    await app.register(roundsRoutes, { prefix: '/api/v1/rounds' });

    const port = Number(process.env.PORT || 8080);
    const host = '0.0.0.0'; // Bind to all interfaces

    await app.listen({ port, host });
    
    console.log(`✅ Server running on http://${host}:${port}`);
    console.log(`Health check: http://${host}:${port}/api/v1/health`);
    
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Handle shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down...');
  process.exit(0);
});

// Start server
startServer().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});