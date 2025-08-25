import { spawn } from 'child_process';
import { createLogger } from '../src/utils/logger';

const logger = createLogger('Railway');

async function waitForDatabase(maxAttempts = 30): Promise<boolean> {
  const { getDb } = await import('../src/db/connection');
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      logger.info(`Checking database connection (attempt ${attempt}/${maxAttempts})...`);
      const db = getDb();
      await db.raw('SELECT 1');
      await db.destroy();
      logger.info('Database connection successful!');
      return true;
    } catch (error) {
      logger.warn(`Database not ready yet, retrying in 2s...`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  
  return false;
}

async function startApiServer(): Promise<void> {
  logger.info('Starting API server...');
  
  // Import and start the server directly
  const { createServer } = await import('../src/api/server');
  const { config } = await import('../src/config');
  
  const server = await createServer();
  const port = process.env.PORT || config.api.port || 3000;
  
  await server.listen({ 
    port: Number(port), 
    host: '0.0.0.0' // Important for Railway
  });
  
  logger.info(`API server running on port ${port}`);
  logger.info(`Health check available at http://0.0.0.0:${port}/api/v1/health`);
}

async function main() {
  try {
    logger.info('🚀 Starting Stream Droplets on Railway...');
    
    // Wait for database to be ready
    const dbReady = await waitForDatabase();
    
    if (!dbReady) {
      logger.error('Database connection failed after multiple attempts');
      process.exit(1);
    }
    
    // Start the API server only (for now)
    await startApiServer();
    
    // Optionally start indexer in background after API is stable
    setTimeout(() => {
      logger.info('Starting background indexer...');
      const indexer = spawn('npm', ['run', 'indexer'], {
        env: process.env,
        stdio: 'inherit',
        detached: false
      });
      
      indexer.on('error', (err) => {
        logger.error('Indexer error (non-fatal):', err);
      });
    }, 10000); // Start indexer after 10 seconds
    
  } catch (error) {
    logger.error('Railway startup failed:', error);
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