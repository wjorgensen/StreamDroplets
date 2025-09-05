import { getDb } from '../db/connection';
import { createLogger } from '../utils/logger';
import { UnifiedBalanceService } from '../services/UnifiedBalanceService';
import { SimplePriceOracle } from '../oracle/SimplePriceOracle';
import * as dotenv from 'dotenv';

dotenv.config();

const logger = createLogger('DockerGenerateDroplets');

async function generateDroplets() {
  const db = await getDb();
  
  try {
    logger.info('Generating historical droplets...');
    
    // Initialize services
    const priceOracle = new SimplePriceOracle();
    const balanceService = new UnifiedBalanceService(db, priceOracle);
    
    // Clear existing droplets
    logger.info('Clearing existing droplets...');
    await db('droplets_cache').del();
    await db('user_usd_snapshots').del();
    
    // Start date: February 19, 2024
    const startDate = new Date('2024-02-19');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    let currentDate = new Date(startDate);
    let totalDropletsAwarded = 0;
    let daysProcessed = 0;
    
    while (currentDate <= today) {
      const dateStr = currentDate.toISOString().split('T')[0];
      logger.info(`Processing ${dateStr}...`);
      
      // Get all user balances for this date
      const balances = await balanceService.getAllUserBalances(currentDate);
      
      if (balances.length > 0) {
        // Store USD snapshots
        await balanceService.storeUnifiedBalances(balances, currentDate);
        
        // Calculate and award droplets
        const dropletsForDay = await balanceService.calculateAndStoreDroplets(balances, currentDate);
        totalDropletsAwarded += dropletsForDay;
        
        logger.info(`  Awarded ${dropletsForDay.toLocaleString()} droplets to ${balances.length} users`);
      }
      
      daysProcessed++;
      currentDate.setDate(currentDate.getDate() + 1);
    }
    
    // Generate summary
    logger.info('');
    logger.info('========================================');
    logger.info('Historical Droplets Generation Complete');
    logger.info('========================================');
    logger.info(`Days processed: ${daysProcessed}`);
    logger.info(`Total droplets awarded: ${totalDropletsAwarded.toLocaleString()}`);
    
    // Get final statistics
    const stats = await db.raw(`
      SELECT 
        COUNT(DISTINCT user_address) as unique_users,
        COUNT(DISTINCT snapshot_date) as unique_days,
        SUM(amount::numeric) as total_droplets,
        AVG(amount::numeric) as avg_daily_droplets
      FROM droplets_cache
    `);
    
    const stat = stats.rows[0];
    logger.info(`Unique users earning droplets: ${stat.unique_users}`);
    logger.info(`Average droplets per day: ${Number(stat.avg_daily_droplets).toLocaleString()}`);
    
    // Show top earners
    const topEarners = await db.raw(`
      SELECT 
        user_address,
        SUM(amount::numeric) as total_earned,
        COUNT(*) as days_active
      FROM droplets_cache
      GROUP BY user_address
      ORDER BY total_earned DESC
      LIMIT 5
    `);
    
    logger.info('');
    logger.info('Top 5 Droplet Earners:');
    topEarners.rows.forEach((user, i) => {
      logger.info(`  ${i + 1}. ${user.user_address.slice(0, 10)}... - ${Number(user.total_earned).toLocaleString()} droplets (${user.days_active} days)`);
    });
    
    logger.info('');
    logger.info('Droplets generation completed successfully!');
    
  } catch (error) {
    logger.error('Failed to generate droplets:', error);
    throw error;
  } finally {
    await db.destroy();
  }
}

// Run if called directly
if (require.main === module) {
  generateDroplets().catch(error => {
    logger.error('Fatal error:', error);
    process.exit(1);
  });
}

export { generateDroplets };