import { getDb } from '../src/db/connection';
import { createLogger } from '../src/utils/logger';
import { UnifiedBalanceService } from '../src/services/UnifiedBalanceService';
import { SimplePriceOracle } from '../src/oracle/SimplePriceOracle';

const logger = createLogger('HistoricalSnapshots');

async function generateHistoricalSnapshots() {
  const db = await getDb();
  const oracleService = new SimplePriceOracle();
  const unifiedBalanceService = new UnifiedBalanceService(db, oracleService);
  
  try {
    logger.info('=== GENERATING HISTORICAL SNAPSHOTS ===\n');
    
    // Contract deployment date (block 21872213 was around Feb 19, 2024)
    const startDate = new Date('2024-02-19');
    const endDate = new Date(); // Today
    
    // Calculate days since launch
    const daysSinceLaunch = Math.floor((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
    logger.info(`Generating ${daysSinceLaunch} daily snapshots from ${startDate.toISOString()} to ${endDate.toISOString()}`);
    
    let successCount = 0;
    let errorCount = 0;
    
    // Generate snapshots for each day
    const currentDate = new Date(startDate);
    while (currentDate <= endDate) {
      try {
        // Use midnight UTC for consistency
        const snapshotTime = new Date(currentDate);
        snapshotTime.setUTCHours(0, 0, 0, 0);
        
        logger.info(`\nProcessing snapshot for ${snapshotTime.toISOString().split('T')[0]}...`);
        
        // Get all user balances for this date
        const unifiedBalances = await unifiedBalanceService.getAllUserBalances(snapshotTime);
        
        if (unifiedBalances.length > 0) {
          // Store snapshots
          await unifiedBalanceService.storeUnifiedBalances(unifiedBalances, snapshotTime);
          
          // Calculate and store droplets (1:1 with USD)
          const totalDroplets = await unifiedBalanceService.calculateAndStoreDroplets(
            unifiedBalances,
            snapshotTime
          );
          
          logger.info(`  ✓ ${unifiedBalances.length} users, ${totalDroplets} droplets awarded`);
          successCount++;
        } else {
          logger.info(`  - No users with balances on this date`);
        }
        
      } catch (error) {
        logger.error(`  ✗ Error processing ${currentDate.toISOString()}: ${error}`);
        errorCount++;
      }
      
      // Move to next day
      currentDate.setDate(currentDate.getDate() + 1);
    }
    
    // Summary
    logger.info('\n=== SNAPSHOT GENERATION COMPLETE ===');
    logger.info(`Successfully generated: ${successCount} snapshots`);
    logger.info(`Errors: ${errorCount}`);
    
    // Verify results
    const totalSnapshots = await db('user_usd_snapshots')
      .countDistinct('round_id as count')
      .first();
    
    const totalDroplets = await db('droplets_cache')
      .sum('amount as total')
      .first();
    
    const uniqueDates = await db('droplets_cache')
      .countDistinct('snapshot_date as count')
      .first();
    
    logger.info('\nDatabase Statistics:');
    logger.info(`  - Total snapshot rounds: ${totalSnapshots?.count || 0}`);
    logger.info(`  - Total droplets awarded: ${totalDroplets?.total || 0}`);
    logger.info(`  - Unique snapshot dates: ${uniqueDates?.count || 0}`);
    
    // Show sample of recent snapshots
    const recentSnapshots = await db('user_usd_snapshots')
      .select(db.raw('DATE(snapshot_time) as date'))
      .count('* as users')
      .sum('total_usd_value as total_usd')
      .groupBy('date')
      .orderBy('date', 'desc')
      .limit(5);
    
    logger.info('\nRecent Snapshots:');
    recentSnapshots.forEach(s => {
      logger.info(`  ${s.date}: ${s.users} users, $${Number(s.total_usd).toLocaleString()} total`);
    });
    
  } catch (error) {
    logger.error('Historical snapshot generation failed:', error);
  } finally {
    await db.destroy();
  }
}

generateHistoricalSnapshots().catch(console.error);