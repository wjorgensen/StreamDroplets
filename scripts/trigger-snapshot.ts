import { DailySnapshotService } from '../src/services/DailySnapshotService';
import { TimelineOracleService } from '../src/oracle/TimelineOracleService';
import { getDb } from '../src/db/connection';
import { createLogger } from '../src/utils/logger';

const logger = createLogger('ManualSnapshot');

async function triggerSnapshots() {
  const db = await getDb();
  const oracleService = new TimelineOracleService();
  const snapshotService = new DailySnapshotService(db, oracleService);
  
  try {
    logger.info('Starting manual snapshot generation...');
    
    // Generate snapshots for the past 3 days
    const dates = [
      new Date('2025-01-26T00:00:00Z'),
      new Date('2025-01-27T00:00:00Z'),
      new Date('2025-01-28T00:00:00Z'),
    ];
    
    for (const date of dates) {
      logger.info(`Generating snapshot for ${date.toISOString()}`);
      
      try {
        const result = await snapshotService.generateDailySnapshot(date);
        logger.info(`Snapshot result for ${date.toISOString()}:`, result);
      } catch (error) {
        logger.error(`Failed to generate snapshot for ${date.toISOString()}:`, error);
      }
    }
    
    // Check results
    const snapshots = await db('daily_usd_snapshots')
      .select('*')
      .orderBy('snapshot_timestamp', 'desc');
    
    logger.info(`Total daily snapshots created: ${snapshots.length}`);
    
    const userSnapshots = await db('user_usd_snapshots')
      .select('user_address', 'total_usd_value', 'snapshot_timestamp')
      .orderBy('total_usd_value', 'desc')
      .limit(10);
    
    logger.info(`Top 10 users by USD value:`);
    for (const snapshot of userSnapshots) {
      logger.info(`  ${snapshot.user_address}: $${snapshot.total_usd_value}`);
    }
    
    const droplets = await db('droplets_cache')
      .select('user_address', 'amount', 'awarded_at')
      .orderBy('amount', 'desc')
      .limit(10);
    
    logger.info(`Top 10 droplet awards:`);
    for (const award of droplets) {
      logger.info(`  ${award.user_address}: ${award.amount} droplets`);
    }
    
  } catch (error) {
    logger.error('Snapshot generation failed:', error);
  } finally {
    await db.destroy();
  }
}

triggerSnapshots().catch(console.error);