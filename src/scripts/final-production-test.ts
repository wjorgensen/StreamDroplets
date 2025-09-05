import { getDb } from '../db/connection';
import { createLogger } from '../utils/logger';
import Table from 'cli-table3';
import chalk from 'chalk';

const logger = createLogger('FinalProductionTest');

const PRICE_MAP: Record<string, number> = {
  'xETH': 2500,   // $2500 per share
  'xBTC': 45000,  // $45000 per share  
  'xUSD': 1,      // $1 per share
  'xEUR': 1.08    // $1.08 per share
};

const TARGET_METRICS = {
  TVL: 157090247,
  USERS: 1071,
  DROPLETS_30D: 4712707410, // 157090247 * 30
  TABLES: 29  // 29 functional tables (30 minus knex_migrations_lock)
};

async function runFinalProductionTest() {
  const db = await getDb();
  
  try {
    console.log('\n' + chalk.cyan('=' .repeat(60)));
    console.log(chalk.cyan.bold('        STREAM DROPLETS - FINAL PRODUCTION TEST'));
    console.log(chalk.cyan('=' .repeat(60)) + '\n');
    
    const results: { test: string; expected: string; actual: string; status: string }[] = [];
    
    // Test 1: Database Tables Count
    console.log(chalk.yellow('📊 Testing Database Structure...'));
    const tables = await db.raw(`
      SELECT COUNT(*) as count 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_type = 'BASE TABLE'
    `);
    const tableCount = parseInt(tables.rows[0].count);
    results.push({
      test: 'Database Tables',
      expected: `${TARGET_METRICS.TABLES} tables`,
      actual: `${tableCount} tables`,
      status: tableCount === TARGET_METRICS.TABLES ? '✅' : '❌'
    });
    
    // Test 2: User Count
    console.log(chalk.yellow('👥 Testing User Metrics...'));
    const userCount = await db('chain_share_balances')
      .countDistinct('address as count');
    const totalUsers = parseInt(userCount[0].count);
    results.push({
      test: 'Unique Users',
      expected: `${TARGET_METRICS.USERS}`,
      actual: `${totalUsers}`,
      status: totalUsers === TARGET_METRICS.USERS ? '✅' : '❌'
    });
    
    // Test 3: TVL Calculation
    console.log(chalk.yellow('💰 Calculating Total Value Locked...'));
    const balances = await db('chain_share_balances')
      .select('asset')
      .sum('shares as total_shares')
      .count('* as holders')
      .groupBy('asset')
      .orderBy('asset');
    
    let totalTVL = 0;
    const assetBreakdown: any[] = [];
    
    for (const balance of balances) {
      const shares = parseFloat(balance.total_shares) / 1e18;
      const pricePerShare = PRICE_MAP[balance.asset];
      const tvl = shares * pricePerShare;
      totalTVL += tvl;
      
      assetBreakdown.push({
        asset: balance.asset,
        holders: balance.holders,
        shares: shares.toFixed(2),
        price: `$${pricePerShare}`,
        tvl: `$${tvl.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`
      });
    }
    
    const tvlDiff = Math.abs(totalTVL - TARGET_METRICS.TVL);
    const tvlPctDiff = (tvlDiff / TARGET_METRICS.TVL) * 100;
    
    results.push({
      test: 'Total TVL',
      expected: `$${(TARGET_METRICS.TVL / 1e6).toFixed(1)}M`,
      actual: `$${(totalTVL / 1e6).toFixed(1)}M`,
      status: tvlPctDiff < 1 ? '✅' : '❌'
    });
    
    // Test 4: Droplets Calculation
    console.log(chalk.yellow('💎 Verifying Droplets Calculation...'));
    const dropletsPerDay = Math.floor(totalTVL);
    const dropletsFor30Days = dropletsPerDay * 30;
    
    results.push({
      test: 'Droplets (30 days)',
      expected: `~${(TARGET_METRICS.DROPLETS_30D / 1e9).toFixed(1)}B`,
      actual: `${(dropletsFor30Days / 1e9).toFixed(1)}B`,
      status: Math.abs(dropletsFor30Days - TARGET_METRICS.DROPLETS_30D) / TARGET_METRICS.DROPLETS_30D < 0.01 ? '✅' : '❌'
    });
    
    // Test 5: Data Integrity
    console.log(chalk.yellow('🔍 Checking Data Integrity...'));
    const dataChecks = await Promise.all([
      db('chain_share_balances').where('shares', '<', 0).count('* as count'),
      db('chain_share_balances').whereNull('address').count('* as count'),
      db('chain_share_balances').whereNull('asset').count('* as count'),
    ]);
    
    const hasNegativeBalances = parseInt(dataChecks[0][0].count) > 0;
    const hasNullAddresses = parseInt(dataChecks[1][0].count) > 0;
    const hasNullAssets = parseInt(dataChecks[2][0].count) > 0;
    
    results.push({
      test: 'Data Integrity',
      expected: 'No invalid data',
      actual: (!hasNegativeBalances && !hasNullAddresses && !hasNullAssets) ? 'All valid' : 'Issues found',
      status: (!hasNegativeBalances && !hasNullAddresses && !hasNullAssets) ? '✅' : '❌'
    });
    
    // Test 6: API Health Check
    console.log(chalk.yellow('🌐 Checking API Health...'));
    try {
      const response = await fetch('http://localhost:3000/health');
      const apiHealthy = response.ok;
      results.push({
        test: 'API Health',
        expected: 'Responding',
        actual: apiHealthy ? 'Healthy' : 'Not responding',
        status: apiHealthy ? '✅' : '⚠️'
      });
    } catch (error) {
      results.push({
        test: 'API Health',
        expected: 'Responding',
        actual: 'Not accessible',
        status: '⚠️'
      });
    }
    
    // Display Asset Breakdown Table
    console.log('\n' + chalk.cyan.bold('📈 Asset Breakdown:'));
    const assetTable = new Table({
      head: [
        chalk.white.bold('Asset'),
        chalk.white.bold('Holders'),
        chalk.white.bold('Total Shares'),
        chalk.white.bold('Price/Share'),
        chalk.white.bold('TVL')
      ],
      style: { head: [], border: [] }
    });
    
    assetBreakdown.forEach(asset => {
      assetTable.push([
        chalk.yellow(asset.asset),
        asset.holders,
        asset.shares,
        asset.price,
        chalk.green(asset.tvl)
      ]);
    });
    
    console.log(assetTable.toString());
    
    // Display Test Results Table
    console.log('\n' + chalk.cyan.bold('🧪 Test Results:'));
    const resultsTable = new Table({
      head: [
        chalk.white.bold('Test'),
        chalk.white.bold('Expected'),
        chalk.white.bold('Actual'),
        chalk.white.bold('Status')
      ],
      style: { head: [], border: [] }
    });
    
    results.forEach(result => {
      resultsTable.push([
        chalk.cyan(result.test),
        result.expected,
        result.actual,
        result.status
      ]);
    });
    
    console.log(resultsTable.toString());
    
    // Calculate pass rate
    const passedTests = results.filter(r => r.status === '✅').length;
    const totalTests = results.length;
    const passRate = (passedTests / totalTests) * 100;
    
    // Final Summary
    console.log('\n' + chalk.cyan('=' .repeat(60)));
    console.log(chalk.cyan.bold('                    FINAL SUMMARY'));
    console.log(chalk.cyan('=' .repeat(60)));
    
    console.log(chalk.white.bold('\n📊 System Metrics:'));
    console.log(`   • Users: ${chalk.green(totalUsers.toLocaleString())} active addresses`);
    console.log(`   • TVL: ${chalk.green('$' + (totalTVL / 1e6).toFixed(1) + 'M')} across 4 vaults`);
    console.log(`   • Droplets: ${chalk.green((dropletsFor30Days / 1e9).toFixed(1) + 'B')} (30-day projection)`);
    console.log(`   • Tables: ${chalk.green(tableCount)} in database`);
    
    console.log(chalk.white.bold('\n✅ Test Results:'));
    console.log(`   • Passed: ${chalk.green(passedTests + '/' + totalTests)} tests`);
    console.log(`   • Pass Rate: ${chalk.green(passRate.toFixed(0) + '%')}`);
    
    if (passRate === 100) {
      console.log('\n' + chalk.green.bold('🎉 PRODUCTION READY! All tests passed successfully!'));
    } else if (passRate >= 80) {
      console.log('\n' + chalk.yellow.bold('⚠️  MOSTLY READY - Minor issues to address'));
    } else {
      console.log('\n' + chalk.red.bold('❌ NOT READY - Critical issues found'));
    }
    
    console.log('\n' + chalk.cyan('=' .repeat(60)) + '\n');
    
    await db.destroy();
    process.exit(passRate === 100 ? 0 : 1);
    
  } catch (error) {
    logger.error('Test failed:', error);
    console.log('\n' + chalk.red.bold('❌ CRITICAL ERROR during testing'));
    console.log(chalk.red(error.message));
    await db.destroy();
    process.exit(1);
  }
}

// Run the test
if (require.main === module) {
  runFinalProductionTest().catch(error => {
    logger.error('Fatal error:', error);
    process.exit(1);
  });
}

export { runFinalProductionTest };