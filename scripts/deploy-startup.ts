import { spawn } from 'child_process';
import { getDb } from '../src/db/connection';
import { createLogger } from '../src/utils/logger';

const logger = createLogger('Deployment');

async function checkIfBackfillNeeded(): Promise<boolean> {
  const db = getDb();
  try {
    // Check if we have any data
    const userCount = await db('current_balances').count('* as count');
    const hasData = userCount[0].count > 0;
    
    if (!hasData) {
      logger.info('No existing data found. Initial backfill needed.');
      return true;
    }
    
    // Check if we're reasonably up to date (within last 1000 blocks)
    const lastBlock = await db('current_balances')
      .max('last_update_block as max_block')
      .first();
    
    // You could add logic here to check if we're too far behind
    logger.info(`Found existing data with last block: ${lastBlock?.max_block}`);
    return false;
  } catch (error) {
    logger.error('Error checking backfill status:', error);
    return true; // Assume backfill needed if check fails
  } finally {
    await db.destroy();
  }
}

async function runBackfill(): Promise<void> {
  logger.info('Starting initial backfill...');
  
  return new Promise((resolve, reject) => {
    const backfill = spawn('npx', ['tsx', 'scripts/production-backfill.ts'], {
      env: process.env,
      stdio: 'inherit'
    });
    
    backfill.on('close', (code) => {
      if (code === 0) {
        logger.info('Backfill completed successfully');
        resolve();
      } else {
        reject(new Error(`Backfill failed with code ${code}`));
      }
    });
    
    backfill.on('error', (err) => {
      reject(err);
    });
  });
}

async function startServices(): Promise<void> {
  logger.info('Starting services...');
  
  // Start the indexer in the background
  const indexer = spawn('npm', ['run', 'indexer'], {
    env: process.env,
    stdio: 'inherit',
    detached: false
  });
  
  indexer.on('error', (err) => {
    logger.error('Indexer failed to start:', err);
  });
  
  // Give indexer time to initialize
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  // Start the API server (this will be the main process)
  const api = spawn('npm', ['run', 'api'], {
    env: process.env,
    stdio: 'inherit'
  });
  
  api.on('error', (err) => {
    logger.error('API server failed to start:', err);
    process.exit(1);
  });
  
  api.on('close', (code) => {
    logger.info(`API server exited with code ${code}`);
    process.exit(code || 0);
  });
  
  // Handle graceful shutdown
  process.on('SIGTERM', () => {
    logger.info('Received SIGTERM, shutting down gracefully...');
    indexer.kill('SIGTERM');
    api.kill('SIGTERM');
  });
  
  process.on('SIGINT', () => {
    logger.info('Received SIGINT, shutting down gracefully...');
    indexer.kill('SIGTERM');
    api.kill('SIGTERM');
  });
}

async function main() {
  try {
    logger.info('🚀 Starting Stream Droplets deployment...');
    
    // Check if we need to run backfill
    const needsBackfill = await checkIfBackfillNeeded();
    
    if (needsBackfill) {
      await runBackfill();
    } else {
      logger.info('Skipping backfill - data already exists');
    }
    
    // Start the live services
    await startServices();
    
  } catch (error) {
    logger.error('Deployment startup failed:', error);
    process.exit(1);
  }
}

// Run the deployment
main().catch(console.error);