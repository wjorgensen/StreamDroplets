import { DailySnapshotService } from '../src/services/DailySnapshotService';
import { TimelineOracleService } from '../src/oracle/TimelineOracleService';
import { getDb } from '../src/db/connection';
import { createLogger } from '../src/utils/logger';

const logger = createLogger('SnapshotTest');

async function testSnapshots() {
  const db = await getDb();
  const oracleService = new TimelineOracleService();
  const snapshotService = new DailySnapshotService(db, oracleService);
  
  try {
    logger.info('Starting snapshot test...');
    
    // Test 1: Generate snapshots for a specific date range
    const startDate = new Date('2025-01-15T00:00:00Z');
    const endDate = new Date('2025-01-16T00:00:00Z');
    
    logger.info(`Testing snapshot generation from ${startDate.toISOString()} to ${endDate.toISOString()}`);
    
    // First, let's check what user balances we have
    const users = await db('transfers')
      .select('to_address as address')
      .sum('value as balance')
      .where('from_address', '0x0000000000000000000000000000000000000000')
      .whereNotIn('to_address', function() {
        this.select('address').from('excluded_addresses');
      })
      .groupBy('to_address')
      .having(db.raw('SUM(value::numeric) > 0'))
      .limit(5);
    
    logger.info(`Found ${users.length} users with balances`);
    
    if (users.length === 0) {
      // Get users who received transfers (not just minting)
      const activeUsers = await db('transfers')
        .select(db.raw('DISTINCT to_address as address'))
        .whereNotIn('to_address', function() {
          this.select('address').from('excluded_addresses');
        })
        .whereNot('to_address', '0x0000000000000000000000000000000000000000')
        .limit(10);
      
      logger.info(`Found ${activeUsers.length} active users from transfers`);
      
      // For testing, we'll simulate some balances
      for (const user of activeUsers) {
        if (user.address) {
          // Check their actual balance from minting events
          const mintingBalance = await db('transfers')
            .sum('value as balance')
            .where('to_address', user.address)
            .where('from_address', '0x0000000000000000000000000000000000000000')
            .first();
          
          logger.info(`User ${user.address} minted balance: ${mintingBalance?.balance || 0}`);
        }
      }
    }
    
    // Now generate the snapshot
    logger.info('Generating daily snapshot...');
    const result = await snapshotService.generateDailySnapshot(startDate);
    
    logger.info('Snapshot generation result:', result);
    
    // Check what was created
    const snapshots = await db('user_usd_snapshots')
      .select('*')
      .where('snapshot_timestamp', '>=', startDate)
      .where('snapshot_timestamp', '<', endDate)
      .limit(5);
    
    logger.info(`Created ${snapshots.length} USD snapshots`);
    
    // Check droplet awards
    const droplets = await db('droplets_cache')
      .select('user_address', 'amount', 'awarded_at')
      .where('awarded_at', '>=', startDate)
      .where('awarded_at', '<', endDate)
      .limit(5);
    
    logger.info(`Awarded droplets to ${droplets.length} users`);
    
    if (droplets.length > 0) {
      logger.info('Sample droplet awards:');
      for (const d of droplets) {
        logger.info(`  User ${d.user_address}: ${d.amount} droplets`);
      }
    }
    
    // Test the 1:1 USD to droplet ratio
    if (snapshots.length > 0 && droplets.length > 0) {
      const ratioCheck = await db.raw(`
        SELECT 
          u.user_address,
          u.total_usd_value,
          d.amount as droplets_awarded,
          CASE 
            WHEN u.total_usd_value = d.amount THEN '✅ 1:1 Ratio'
            ELSE '❌ Ratio Mismatch'
          END as ratio_check
        FROM user_usd_snapshots u
        LEFT JOIN droplets_cache d 
          ON u.user_address = d.user_address
          AND DATE(u.snapshot_timestamp) = DATE(d.awarded_at)
        WHERE u.snapshot_timestamp >= ?
          AND u.snapshot_timestamp < ?
        LIMIT 10
      `, [startDate, endDate]);
      
      logger.info('USD to Droplet Ratio Check:');
      for (const r of ratioCheck.rows) {
        logger.info(`  ${r.user_address}: $${r.total_usd_value} USD = ${r.droplets_awarded} droplets - ${r.ratio_check}`);
      }
    }
    
  } catch (error) {
    logger.error('Snapshot test failed:', error);
  } finally {
    await db.destroy();
  }
}

testSnapshots().catch(console.error);