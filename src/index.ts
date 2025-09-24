import { MainOrchestrator } from './services/MainOrchestrator';
import { startServer } from './api/server';
import { createLogger } from './utils/logger';
import { testConnection, getDb, closeDb } from './db/connection';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const logger = createLogger('Main');

/**
 * Run database migrations
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
    
    // Test database connection
    logger.info('Testing database connection...');
    const dbConnected = await testConnection();
    if (!dbConnected) {
      logger.error('Failed to connect to database');
      process.exit(1);
    }
    
    logger.info('Database connected successfully');
    
    // Run database migrations
    logger.info('Running database migrations...');
    await runMigrations();
    logger.info('Database migrations completed');
    
    // Initialize the main orchestrator
    logger.info('Initializing MainOrchestrator...');
    orchestrator = new MainOrchestrator();
    
    // Start the API server
    logger.info('Starting API server...');
    await startServer();
    logger.info(`API server running on port ${process.env.API_PORT || 3000}`);
    
    // Setup graceful shutdown
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
    
    // Setup signal handlers
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
    
    // Start the orchestration service
    logger.info('Starting orchestration service...');
    logger.info('- Initializing AlchemyService for all chains');
    logger.info('- Running historical backfill from deployment dates');
    logger.info('- Starting real-time processing (12:05AM EST daily)');
    
    // Start orchestrator (this handles backfill then real-time processing)
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
    
    // Attempt graceful cleanup
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

// Export main function for testing
export { main };

// Start the application when run directly
if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal error starting application:', error);
    process.exit(1);
  });
}