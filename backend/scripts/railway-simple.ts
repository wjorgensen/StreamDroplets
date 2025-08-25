#!/usr/bin/env tsx

console.log('Starting Stream Droplets API (Simple Mode)...');
console.log('Environment:', {
  NODE_ENV: process.env.NODE_ENV,
  RAILWAY: !!process.env.RAILWAY_ENVIRONMENT,
  PORT: process.env.PORT || 3000,
  HAS_DATABASE_URL: !!process.env.DATABASE_URL,
});

// Import pg directly to test
import { Client } from 'pg';

async function quickDbTest(): Promise<boolean> {
  if (!process.env.DATABASE_URL) {
    console.error('FATAL: DATABASE_URL not set!');
    return false;
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Always use SSL for Railway
  });

  try {
    await client.connect();
    await client.query('SELECT 1');
    await client.end();
    console.log('✅ Database connection OK');
    return true;
  } catch (error: any) {
    console.error('❌ Database connection failed:', error.message);
    console.error('Connection string pattern:', process.env.DATABASE_URL.replace(/:[^:@]+@/, ':***@'));
    return false;
  }
}

async function startServer() {
  // Test database first
  const dbOk = await quickDbTest();
  if (!dbOk) {
    console.error('Cannot start server without database');
    process.exit(1);
  }

  try {
    // Import Fastify directly
    const fastify = (await import('fastify')).default;
    
    const app = fastify({
      logger: {
        level: 'info',
        transport: {
          target: 'pino-pretty',
          options: {
            translateTime: 'HH:MM:ss Z',
            ignore: 'pid,hostname',
          },
        },
      },
    });

    // Simple health check that just tests database
    app.get('/api/v1/health', async (request, reply) => {
      try {
        const client = new Client({
          connectionString: process.env.DATABASE_URL,
          ssl: { rejectUnauthorized: false }
        });
        
        await client.connect();
        await client.query('SELECT 1');
        await client.end();
        
        return reply.status(200).send({
          status: 'healthy',
          timestamp: new Date().toISOString(),
          database: 'connected',
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

    // Add all other routes
    const { healthRoutes } = await import('../src/api/routes/health');
    const { pointsRoutes } = await import('../src/api/routes/points');
    const { leaderboardRoutes } = await import('../src/api/routes/leaderboard');
    const { eventsRoutes } = await import('../src/api/routes/events');
    const { roundsRoutes } = await import('../src/api/routes/rounds');
    
    await app.register(healthRoutes, { prefix: '/api/v1/health' });
    await app.register(pointsRoutes, { prefix: '/api/v1/points' });
    await app.register(leaderboardRoutes, { prefix: '/api/v1/leaderboard' });
    await app.register(eventsRoutes, { prefix: '/api/v1/events' });
    await app.register(roundsRoutes, { prefix: '/api/v1/rounds' });

    const port = Number(process.env.PORT || 3000);
    const host = '0.0.0.0'; // Required for Railway

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

// Start
startServer().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});