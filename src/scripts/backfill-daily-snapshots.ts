/**
 * Backfill Daily Snapshots
 * Processes historical data using the 24-hour snapshot system
 */

import { getDb } from '../db/connection';
import { DailySnapshotService } from '../services/DailySnapshotService';
import { ChainBalanceTracker } from '../services/ChainBalanceTracker';
import { createLogger } from '../utils/logger';
import dotenv from 'dotenv';

dotenv.config();

const logger = createLogger('BackfillDaily');
const db = getDb();

async function backfillDailySnapshots() {
  logger.info('Starting daily snapshot backfill...');
  
  try {
    // Step 1: Ensure database migrations are up to date
    logger.info('Checking database schema...');
    const tables = await db.raw(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN (
        'daily_usd_snapshots',
        'daily_snapshot_jobs',
        'chain_share_balances',
        'system_state'
      )
    `);
    
    if (tables.rows.length < 4) {
      logger.error('Required tables not found. Please run migration 009:');
      logger.error('npx knex migrate:latest --knexfile src/db/knexfile.ts');
      process.exit(1);
    }
    
    logger.info(`Found ${tables.rows.length} required tables`);
    
    // Step 2: Rebuild chain balances from events
    logger.info('Rebuilding chain balance snapshots...');
    const balanceTracker = new ChainBalanceTracker();
    await balanceTracker.rebuildBalancesFromEvents();
    
    // Step 3: Determine date range for backfill
    const firstEvent = await db('unified_share_events')
      .orderBy('timestamp', 'asc')
      .first();
    
    if (!firstEvent) {
      logger.warn('No events found to process');
      return;
    }
    
    const startDate = new Date(firstEvent.timestamp);
    startDate.setUTCHours(0, 0, 0, 0); // Start of day
    
    const endDate = new Date();
    endDate.setUTCHours(0, 0, 0, 0); // Today at midnight
    
    logger.info(`Backfilling from ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`);
    
    // Step 4: Process daily snapshots
    const snapshotService = new DailySnapshotService();
    const currentDate = new Date(startDate);
    let processedDays = 0;
    
    while (currentDate <= endDate) {
      const dateStr = currentDate.toISOString().split('T')[0];
      
      // Check if already processed
      const existing = await db('daily_snapshot_jobs')
        .where('snapshot_date', dateStr)
        .where('status', 'completed')
        .first();
      
      if (!existing) {
        logger.info(`Processing snapshot for ${dateStr}`);
        try {
          await snapshotService.processDailySnapshot(currentDate);
          processedDays++;
        } catch (error) {
          logger.error(`Failed to process ${dateStr}:`, error);
        }
      } else {
        logger.debug(`Skipping ${dateStr} - already processed`);
      }
      
      // Move to next day
      currentDate.setDate(currentDate.getDate() + 1);
    }
    
    logger.info(`Backfill complete! Processed ${processedDays} days`);
    
    // Step 5: Show summary
    await showSummary();
    
  } catch (error) {
    logger.error('Backfill failed:', error);
    process.exit(1);
  } finally {
    await db.destroy();
  }
}

async function showSummary() {
  logger.info('\n=== Backfill Summary ===');
  
  // Total users with droplets
  const usersWithDroplets = await db('droplets_leaderboard')
    .where('total_droplets', '>', 0)
    .count('* as count')
    .first();
  
  logger.info(`Users with droplets: ${usersWithDroplets?.count || 0}`);
  
  // Total droplets awarded
  const totalDroplets = await db('droplets_leaderboard')
    .sum('total_droplets as total')
    .first();
  
  logger.info(`Total droplets awarded: ${totalDroplets?.total || 0}`);
  
  // Days processed
  const daysProcessed = await db('daily_snapshot_jobs')
    .where('status', 'completed')
    .count('* as count')
    .first();
  
  logger.info(`Days processed: ${daysProcessed?.count || 0}`);
  
  // Top 10 users
  const topUsers = await db('droplets_leaderboard')
    .orderBy('total_droplets', 'desc')
    .limit(10)
    .select('address', 'total_droplets', 'days_participated');
  
  if (topUsers.length > 0) {
    logger.info('\nTop 10 Users:');
    topUsers.forEach((user, index) => {
      logger.info(`${index + 1}. ${user.address.substring(0, 10)}... - ${user.total_droplets} droplets (${user.days_participated} days)`);
    });
  }
  
  // Check for any failed jobs
  const failedJobs = await db('daily_snapshot_jobs')
    .where('status', 'failed')
    .count('* as count')
    .first();
  
  if (failedJobs?.count && failedJobs.count > 0) {
    logger.warn(`\n⚠️ ${failedJobs.count} daily snapshots failed`);
    
    const failed = await db('daily_snapshot_jobs')
      .where('status', 'failed')
      .select('snapshot_date', 'error_message')
      .limit(5);
    
    failed.forEach(job => {
      logger.warn(`  - ${job.snapshot_date}: ${job.error_message}`);
    });
  }
}

// Allow running with date range arguments
const args = process.argv.slice(2);
if (args.length === 2) {
  const startDate = new Date(args[0]);
  const endDate = new Date(args[1]);
  
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    logger.error('Invalid date format. Use: npm run backfill-daily YYYY-MM-DD YYYY-MM-DD');
    process.exit(1);
  }
  
  logger.info(`Custom date range: ${args[0]} to ${args[1]}`);
  // You could modify the backfill function to accept these dates
}

// Run the backfill
backfillDailySnapshots()
  .then(() => {
    logger.info('Backfill completed successfully!');
    process.exit(0);
  })
  .catch((error) => {
    logger.error('Fatal error:', error);
    process.exit(1);
  });