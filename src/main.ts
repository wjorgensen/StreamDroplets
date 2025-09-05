import { startServer } from './api/server';
import { createLogger } from './utils/logger';
import { testConnection } from './db/connection';
import dotenv from 'dotenv';

dotenv.config();

const logger = createLogger('Main');

async function main() {
  logger.info('========================================');
  logger.info('Stream Droplets Starting...');
  logger.info('========================================');
  
  try {
    // Test database connection
    logger.info('Testing database connection...');
    await testConnection();
    logger.info('Database connection successful');
    
    // Start API server
    logger.info('Starting API server...');
    await startServer();
    
    logger.info('========================================');
    logger.info('Stream Droplets Started Successfully!');
    logger.info(`API Server: http://0.0.0.0:${process.env.API_PORT || 3000}`);
    logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
    logger.info('========================================');
    
    // Handle graceful shutdown
    process.on('SIGTERM', () => {
      logger.info('SIGTERM received, shutting down...');
      process.exit(0);
    });
    
    process.on('SIGINT', () => {
      logger.info('SIGINT received, shutting down...');
      process.exit(0);
    });
    
  } catch (error) {
    logger.error('Failed to start application:', error);
    process.exit(1);
  }
}

// Start the application
main().catch(error => {
  logger.error('Fatal error:', error);
  process.exit(1);
});