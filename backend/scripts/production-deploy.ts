#!/usr/bin/env node

import { spawn } from 'child_process';
import { createLogger } from '../src/utils/logger';
import { getDb } from '../src/db/connection';

const logger = createLogger('Production-Deploy');

async function waitForDatabase(maxAttempts = 30): Promise<boolean> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      logger.info(`Checking database connection (attempt ${attempt}/${maxAttempts})...`);
      const db = getDb();
      await db.raw('SELECT 1');
      logger.info('Database connection successful!');
      return true;
    } catch (error) {
      logger.warn(`Database not ready yet, retrying in 2s...`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  return false;
}

async function runMigrations(): Promise<boolean> {
  logger.info('Running database migrations...');
  
  return new Promise((resolve) => {
    const migrate = spawn('npx', ['knex', 'migrate:latest', '--knexfile', 'dist/db/knexfile.js', '--env', 'production'], {
      env: process.env,
      stdio: 'inherit'
    });
    
    migrate.on('close', (code) => {
      if (code === 0) {
        logger.info('✅ Migrations completed successfully');
        resolve(true);
      } else {
        logger.warn('⚠️ Migration failed, but continuing...');
        resolve(false);
      }
    });
    
    migrate.on('error', (err) => {
      logger.error('Migration error:', err);
      resolve(false);
    });
  });
}

async function runBackfill(): Promise<void> {
  logger.info('Starting production backfill...');
  
  return new Promise((resolve) => {
    const backfill = spawn('node', ['dist/scripts/production-backfill.js'], {
      env: process.env,
      stdio: 'inherit'
    });
    
    backfill.on('close', (code) => {
      if (code === 0) {
        logger.info('✅ Backfill completed successfully');
      } else {
        logger.warn('⚠️ Backfill completed with warnings');
      }
      resolve();
    });
    
    backfill.on('error', (err) => {
      logger.error('Backfill error:', err);
      resolve();
    });
    
    // Set a timeout for backfill (10 minutes max)
    setTimeout(() => {
      logger.info('Backfill timeout reached, continuing...');
      backfill.kill('SIGTERM');
      resolve();
    }, 10 * 60 * 1000);
  });
}

async function startApiServer(): Promise<void> {
  const port = process.env.PORT || 8080;
  logger.info(`Starting API server on port ${port}...`);
  
  const server = spawn('node', ['dist/simple-server.js'], {
    env: { ...process.env, PORT: String(port) },
    stdio: 'inherit',
    detached: false
  });
  
  server.on('error', (err) => {
    logger.error('API server error:', err);
    process.exit(1);
  });
  
  // Give the API server time to start
  await new Promise(resolve => setTimeout(resolve, 5000));
  logger.info('API server started in background');
}

async function startIndexer(): Promise<void> {
  logger.info('Starting live event indexer...');
  
  const indexer = spawn('node', ['dist/indexer/index.js'], {
    env: process.env,
    stdio: 'inherit',
    detached: false
  });
  
  indexer.on('error', (err) => {
    logger.error('Indexer error:', err);
    // Don't exit, indexer errors are non-fatal
  });
  
  indexer.on('exit', (code) => {
    logger.warn(`Indexer exited with code ${code}, will restart in 10s...`);
    setTimeout(() => startIndexer(), 10000);
  });
}

async function main() {
  try {
    logger.info('🚀 Starting Stream Droplets Full Production Deployment...');
    logger.info('Environment:', {
      NODE_ENV: process.env.NODE_ENV,
      RAILWAY: !!process.env.RAILWAY_ENVIRONMENT,
      PORT: process.env.PORT || 8080,
    });
    
    // Step 1: Wait for database
    const dbReady = await waitForDatabase();
    if (!dbReady) {
      logger.error('Database connection failed after multiple attempts');
      process.exit(1);
    }
    
    // Step 2: Run migrations
    await runMigrations();
    
    // Step 3: Start API server first (needed for health checks)
    await startApiServer();
    
    // Step 4: Run backfill in parallel with indexer
    logger.info('Starting backfill and indexer in parallel...');
    
    // Start backfill (non-blocking)
    runBackfill().then(() => {
      logger.info('Backfill process completed');
    }).catch(err => {
      logger.error('Backfill failed:', err);
    });
    
    // Wait a bit before starting indexer to avoid conflicts
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Step 5: Start live indexer
    await startIndexer();
    
    logger.info('🎉 All services started successfully!');
    logger.info('- API Server: Running');
    logger.info('- Backfill: Running in background');
    logger.info('- Live Indexer: Running');
    
  } catch (error) {
    logger.error('Production deployment failed:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

// Run the deployment
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});