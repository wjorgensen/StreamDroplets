import { getDb } from '../src/db/connection';
import { createLogger } from '../src/utils/logger';
import { UnifiedBalanceService } from '../src/services/UnifiedBalanceService';
import { SimplePriceOracle } from '../src/oracle/SimplePriceOracle';

const logger = createLogger('HistoricalDroplets');

async function generateAllHistoricalDroplets() {
  const db = await getDb();
  const oracleService = new SimplePriceOracle();
  const unifiedBalanceService = new UnifiedBalanceService(db, oracleService);
  
  try {
    logger.info('=== GENERATING ALL HISTORICAL DROPLETS ===\n');
    
    // Contract deployment date (block 21872213 was around Feb 19, 2024)
    const startDate = new Date('2024-02-19');
    const endDate = new Date(); // Today
    
    // Clear existing data for fresh calculation
    logger.info('Clearing existing droplet data...');
    await db('droplets_cache').del();
    await db('user_usd_snapshots').del();
    
    // Calculate days since launch
    const daysSinceLaunch = Math.floor((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
    logger.info(`Generating ${daysSinceLaunch} daily snapshots from ${startDate.toISOString()} to ${endDate.toISOString()}`);
    
    let successCount = 0;
    let errorCount = 0;
    let totalDropletsAwarded = 0;
    const userDropletTotals = new Map<string, number>();
    
    // Generate snapshots for each day
    const currentDate = new Date(startDate);
    let dayNumber = 1;
    
    while (currentDate <= endDate) {
      try {
        // Use midnight UTC for consistency
        const snapshotTime = new Date(currentDate);
        snapshotTime.setUTCHours(0, 0, 0, 0);
        
        logger.info(`\nDay ${dayNumber}: Processing snapshot for ${snapshotTime.toISOString().split('T')[0]}...`);
        
        // Get all user balances for this date
        const unifiedBalances = await unifiedBalanceService.getAllUserBalances(snapshotTime);
        
        if (unifiedBalances.length > 0) {
          // Store snapshots
          await unifiedBalanceService.storeUnifiedBalances(unifiedBalances, snapshotTime);
          
          // Award droplets for this day (1:1 with USD)
          const dateStr = snapshotTime.toISOString().split('T')[0];
          let dailyDroplets = 0;
          
          for (const balance of unifiedBalances) {
            const dropletsAmount = Math.floor(balance.total_usd_value); // 1 droplet per $1 USD per day
            
            if (dropletsAmount > 0) {
              // Track cumulative total per user
              const current = userDropletTotals.get(balance.user_address) || 0;
              userDropletTotals.set(balance.user_address, current + dropletsAmount);
              
              dailyDroplets += dropletsAmount;
              totalDropletsAwarded += dropletsAmount;
              
              // Store this day's droplets
              await db('droplets_cache')
                .insert({
                  user_address: balance.user_address,
                  amount: dropletsAmount.toString(),
                  snapshot_date: dateStr,
                  awarded_at: new Date(),
                  reason: `Day ${dayNumber} USD exposure: $${balance.total_usd_value.toFixed(2)}`,
                })
                .onConflict(['user_address', 'snapshot_date'])
                .merge();
            }
          }
          
          logger.info(`  ✓ ${unifiedBalances.length} users, ${dailyDroplets.toLocaleString()} droplets awarded`);
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
      dayNumber++;
    }
    
    // Summary
    logger.info('\n=== DROPLET GENERATION COMPLETE ===');
    logger.info(`Successfully generated: ${successCount} daily snapshots`);
    logger.info(`Errors: ${errorCount}`);
    logger.info(`Total droplets awarded: ${totalDropletsAwarded.toLocaleString()}`);
    logger.info(`Unique users earning droplets: ${userDropletTotals.size}`);
    
    // Show top earners
    const topEarners = Array.from(userDropletTotals.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    
    logger.info('\nTop 10 Droplet Earners (Cumulative):');
    topEarners.forEach(([address, total], i) => {
      logger.info(`  ${i+1}. ${address.slice(0,10)}... = ${total.toLocaleString()} droplets`);
    });
    
    // Verify totals in database
    const dbTotals = await db.raw(`
      SELECT 
        COUNT(DISTINCT user_address) as unique_users,
        COUNT(DISTINCT snapshot_date) as unique_dates,
        SUM(amount::numeric) as total_droplets
      FROM droplets_cache
    `);
    
    logger.info('\nDatabase Verification:');
    logger.info(`  Unique users: ${dbTotals.rows[0].unique_users}`);
    logger.info(`  Unique dates: ${dbTotals.rows[0].unique_dates}`);
    logger.info(`  Total droplets in DB: ${Number(dbTotals.rows[0].total_droplets).toLocaleString()}`);
    
    // Calculate expected droplets (TVL × days)
    const avgTVL = await db.raw(`
      SELECT 
        AVG(total_sum) as avg_tvl
      FROM (
        SELECT 
          DATE(snapshot_time) as date,
          SUM(total_usd_value::numeric) as total_sum
        FROM user_usd_snapshots
        GROUP BY DATE(snapshot_time)
      ) daily_tvls
    `);
    
    const avgTVLValue = Number(avgTVL.rows[0].avg_tvl || 0);
    const expectedDroplets = avgTVLValue * successCount;
    
    logger.info('\nExpected vs Actual:');
    logger.info(`  Average daily TVL: $${avgTVLValue.toLocaleString()}`);
    logger.info(`  Days counted: ${successCount}`);
    logger.info(`  Expected droplets (TVL × days): ${expectedDroplets.toLocaleString()}`);
    logger.info(`  Actual droplets awarded: ${totalDropletsAwarded.toLocaleString()}`);
    logger.info(`  Ratio: ${(totalDropletsAwarded / expectedDroplets * 100).toFixed(2)}%`);
    
  } catch (error) {
    logger.error('Historical droplet generation failed:', error);
  } finally {
    await db.destroy();
  }
}

generateAllHistoricalDroplets().catch(console.error);