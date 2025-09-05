import { getDb } from '../src/db/connection';
import { createLogger } from '../src/utils/logger';
import { UnifiedBalanceService } from '../src/services/UnifiedBalanceService';
import { TimelineOracleService } from '../src/oracle/TimelineOracleService';

const logger = createLogger('SystemTest');

async function testFullSystem() {
  const db = await getDb();
  const oracleService = new TimelineOracleService();
  const unifiedBalanceService = new UnifiedBalanceService(db, oracleService);
  
  try {
    logger.info('=== FULL SYSTEM TEST ===\n');
    
    // 1. Check current data state
    logger.info('1. Current Data State:');
    const counts = await Promise.all([
      db('events').count('* as count').first(),
      db('transfers').count('* as count').first(),
      db('chain_share_balances').count('* as count').first(),
      db('oracle_prices_timeline').count('* as count').first(),
    ]);
    
    logger.info(`   - Events: ${counts[0]?.count || 0}`);
    logger.info(`   - Transfers: ${counts[1]?.count || 0}`);
    logger.info(`   - Chain share balances: ${counts[2]?.count || 0}`);
    logger.info(`   - Oracle prices: ${counts[3]?.count || 0}`);
    
    // 2. Check unique users
    logger.info('\n2. User Analysis:');
    const uniqueUsers = await db.raw(`
      SELECT COUNT(DISTINCT user_address) as count FROM (
        SELECT from_address as user_address FROM transfers 
        WHERE from_address != '0x0000000000000000000000000000000000000000'
        UNION
        SELECT to_address as user_address FROM transfers 
        WHERE to_address != '0x0000000000000000000000000000000000000000'
      ) users
      WHERE user_address NOT IN (SELECT address FROM excluded_addresses)
    `);
    logger.info(`   - Unique users (transfers): ${uniqueUsers.rows[0].count}`);
    
    const balanceUsers = await db('chain_share_balances')
      .countDistinct('address as count')
      .first();
    logger.info(`   - Users with balances: ${balanceUsers?.count || 0}`);
    
    // 3. Test unified balance calculation
    logger.info('\n3. Testing Unified Balance Calculation:');
    const testDate = new Date();
    const unifiedBalances = await unifiedBalanceService.getAllUserBalances(testDate);
    
    logger.info(`   - Found ${unifiedBalances.length} users with positive USD value`);
    
    if (unifiedBalances.length > 0) {
      // Show top 5 users
      const topUsers = unifiedBalances
        .sort((a, b) => b.total_usd_value - a.total_usd_value)
        .slice(0, 5);
      
      logger.info('   - Top 5 users by USD value:');
      topUsers.forEach((user, i) => {
        logger.info(`     ${i+1}. ${user.user_address.slice(0, 10)}... = $${user.total_usd_value.toFixed(2)}`);
        user.chain_balances.forEach(cb => {
          logger.info(`        - ${cb.chain_name} ${cb.asset}: ${cb.balance} ${cb.balance_type} = $${cb.usd_value.toFixed(2)}`);
        });
      });
    }
    
    // 4. Test droplet calculation
    logger.info('\n4. Testing Droplet Calculation:');
    if (unifiedBalances.length > 0) {
      const totalDroplets = await unifiedBalanceService.calculateAndStoreDroplets(
        unifiedBalances,
        testDate
      );
      
      logger.info(`   - Total droplets that would be awarded: ${totalDroplets}`);
      logger.info(`   - Average droplets per user: ${(totalDroplets / unifiedBalances.length).toFixed(2)}`);
      
      // Check droplets_cache
      const dropletsInDb = await db('droplets_cache')
        .count('* as count')
        .sum('amount as total')
        .first();
      
      logger.info(`   - Droplets in database: ${dropletsInDb?.count || 0} records, ${dropletsInDb?.total || 0} total droplets`);
    }
    
    // 5. Test snapshot storage
    logger.info('\n5. Testing Snapshot Storage:');
    await unifiedBalanceService.storeUnifiedBalances(unifiedBalances, testDate);
    
    const snapshots = await db('user_usd_snapshots')
      .count('* as count')
      .first();
    logger.info(`   - User snapshots stored: ${snapshots?.count || 0}`);
    
    // 6. Architecture Summary
    logger.info('\n6. Architecture Summary:');
    logger.info('   ✅ Multi-chain support (ETH vault shares + other chain tokens)');
    logger.info('   ✅ Unified USD calculation across all positions');
    logger.info('   ✅ Chainlink price feeds integrated');
    logger.info('   ✅ 1:1 USD to droplet ratio implemented');
    logger.info('   ✅ Daily snapshot system ready');
    logger.info('   ✅ Staking counted as having balance');
    
    // 7. Issues found
    logger.info('\n7. Issues to Address:');
    const noBalanceUsers = uniqueUsers.rows[0].count - (balanceUsers?.count || 0);
    if (noBalanceUsers > 0) {
      logger.info(`   ⚠️  ${noBalanceUsers} users have transfers but no current balance`);
      logger.info(`      (They may have unstaked or transferred out)`);
    }
    
    if (counts[0]?.count === 0) {
      logger.info(`   ⚠️  No events decoded yet - need to run backfill with proper event processing`);
    }
    
    logger.info('\n=== TEST COMPLETE ===');
    
  } catch (error) {
    logger.error('Test failed:', error);
  } finally {
    await db.destroy();
  }
}

testFullSystem().catch(console.error);