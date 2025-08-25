import { TimelineIndexer } from './indexer/TimelineIndexer';
import { startServer } from './api/server';
import { createLogger } from './utils/logger';
import { testConnection } from './db/connection';

const logger = createLogger('Main');

async function main() {
  try {
    logger.info('Starting Stream Droplets Timeline Tracker');
    
    // Test database connection
    const dbConnected = await testConnection();
    if (!dbConnected) {
      logger.error('Failed to connect to database');
      process.exit(1);
    }
    
    logger.info('Database connected');
    
    // Start the timeline indexer
    const indexer = new TimelineIndexer();
    indexer.start().catch(error => {
      logger.error('Timeline indexer failed:', error);
    });
    
    logger.info('Timeline indexer started');
    
    // Start the API server
    await startServer();
    
    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      logger.info('Shutting down gracefully...');
      await indexer.stop();
      process.exit(0);
    });
    
    process.on('SIGTERM', async () => {
      logger.info('Shutting down gracefully...');
      await indexer.stop();
      process.exit(0);
    });
    
  } catch (error) {
    logger.error('Failed to start application:', error);
    process.exit(1);
  }
}

// Start the application
if (require.main === module) {
  main();
}
