import { startServer } from './api/server';
import { createLogger } from './utils/logger';
import { getDb, testConnection } from './db/connection';
import { SchedulerService } from './services/SchedulerService';
import { DailySnapshotService } from './services/DailySnapshotService';
import { UnifiedBalanceService } from './services/UnifiedBalanceService';
import { SimplePriceOracle } from './oracle/SimplePriceOracle';
import dotenv from 'dotenv';

dotenv.config();

const logger = createLogger('Startup');

async function startApplication() {
  logger.info('========================================');
  logger.info('Stream Droplets Starting...');
  logger.info('========================================');
  
  try {
    // Test database connection
    logger.info('Testing database connection...');
    await testConnection();
    logger.info('Database connection successful');
    
    // Get database instance
    const db = await getDb();
    
    // Initialize services
    logger.info('Initializing services...');
    const priceOracle = new SimplePriceOracle();
    const balanceService = new UnifiedBalanceService(db, priceOracle);
    const snapshotService = new DailySnapshotService(db);
    
    // Initialize scheduler for daily snapshots
    logger.info('Starting scheduler service...');
    const scheduler = new SchedulerService(db);
    await scheduler.start();
    
    // Start API server
    logger.info('Starting API server...');
    await startServer();
    
    logger.info('========================================');
    logger.info('Stream Droplets Started Successfully!');
    logger.info(`API Server: http://0.0.0.0:${process.env.API_PORT || 3000}`);
    logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
    logger.info('========================================');
    
    // Graceful shutdown handling
    const shutdown = async (signal: string) => {
      logger.info(`${signal} received, shutting down gracefully...`);
      
      try {
        // Stop scheduler
        await scheduler.stop();
        
        // Close database
        await db.destroy();
        logger.info('Database connections closed');
        
        logger.info('Shutdown complete');
        process.exit(0);
      } catch (error) {
        logger.error('Error during shutdown:', error);
        process.exit(1);
      }
    };
    
    // Register shutdown handlers
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    
    // Handle uncaught errors
    process.on('uncaughtException', (error) => {
      logger.error('Uncaught exception:', error);
      shutdown('UNCAUGHT_EXCEPTION');
    });
    
    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled rejection at:', promise, 'reason:', reason);
      shutdown('UNHANDLED_REJECTION');
    });
    
  } catch (error) {
    logger.error('Failed to start application:', error);
    process.exit(1);
  }
}

// Start the application
startApplication().catch(error => {
  logger.error('Fatal startup error:', error);
  process.exit(1);
});