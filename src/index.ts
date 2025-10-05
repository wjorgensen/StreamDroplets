import { MainOrchestrator } from './services/MainOrchestrator';
import { startServer } from './api/server';
import { createLogger } from './utils/logger';
import { testConnection, getDb, closeDb } from './db/connection';
import dotenv from 'dotenv';

dotenv.config();

const logger = createLogger('Main');

/**
 * Runs database migrations
 */
async function runMigrations(): Promise<void> {
  try {
    const db = getDb();
    await db.migrate.latest();
    logger.info('Migrations completed successfully');
  } catch (error: any) {
    logger.error('Migration failed:', {
      message: error.message,
      stack: error.stack,
      code: error.code,
      detail: error.detail,
      error: error
    });
    throw error;
  }
}

async function main() {
  let orchestrator: MainOrchestrator | null = null;
  
  try {
    logger.info('Starting StreamDroplets - Multi-Chain Indexer & Orchestrator');
    
    logger.info('Testing database connection...');
    const dbConnected = await testConnection();
    if (!dbConnected) {
      logger.error('Failed to connect to database');
      process.exit(1);
    }
    
    logger.info('Database connected successfully');
    
    logger.info('Running database migrations...');
    await runMigrations();
    logger.info('Database migrations completed');
    
    logger.info('Initializing MainOrchestrator...');
    orchestrator = new MainOrchestrator();
    
    logger.info('Starting API server...');
    await startServer();
    logger.info(`API server running on port ${process.env.API_PORT || 3000}`);
    
    const gracefulShutdown = async () => {
      logger.info('Shutting down gracefully...');
      try {
        if (orchestrator) {
          logger.info('Stopping orchestrator...');
          orchestrator.stop();
        }
        logger.info('Closing database connection...');
        await closeDb();
        logger.info('All services stopped');
        process.exit(0);
      } catch (error) {
        logger.error('Error during shutdown:', error);
        process.exit(1);
      }
    };
    
    process.on('SIGINT', gracefulShutdown);
    process.on('SIGTERM', gracefulShutdown);
    process.on('uncaughtException', (error) => {
      logger.error('Uncaught Exception:', error);
      gracefulShutdown();
    });
    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
      gracefulShutdown();
    });
    
    logger.info('Starting orchestration service...');
    logger.info('- Initializing AlchemyService for all chains');
    logger.info('- Running historical backfill from deployment dates');
    logger.info('- Starting real-time processing (12:05AM EST daily)');
    
    await orchestrator.start();
    
    logger.info('=====================================');
    logger.info('StreamDroplets is fully operational!');
    logger.info(`API server: http://localhost:${process.env.API_PORT || 3000}`);
    logger.info('Historical backfill complete, real-time processing active');
    logger.info('=====================================');
    
  } catch (error: any) {
    logger.error('Failed to start application:', {
      message: error.message,
      stack: error.stack
    });
    
    if (orchestrator) {
      try {
        orchestrator.stop();
      } catch (cleanupError) {
        logger.error('Error during cleanup:', cleanupError);
      }
    }
    
    try {
      await closeDb();
    } catch (cleanupError) {
      logger.error('Error closing database during cleanup:', cleanupError);
    }
    
    process.exit(1);
  }
}

export { main };

if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal error starting application:', error);
    process.exit(1);
  });
}