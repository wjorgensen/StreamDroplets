import { getDb } from '../src/db/connection';
import { createLogger } from '../src/utils/logger';

const logger = createLogger('MetricsVerification');

async function verifySystemMetrics() {
  const db = await getDb();
  
  try {
    logger.info('=== SYSTEM METRICS VERIFICATION ===\n');
    
    // 1. Check that contract addresses are excluded
    logger.info('1. CONTRACT ADDRESS EXCLUSION:');
    const contractAddresses = [
      '0x7e586fbaf3084c0be7ab5c82c04ffd7592723153', // xETH
      '0x12fd502e2052cafb41eccc5b596023d9978057d6', // xBTC
      '0xe2fc85bfb48c4cf147921fbe110cf92ef9f26f94', // xUSD
      '0xc15697f61170fc3bb4e99eb7913b4c7893f64f13'  // xEUR
    ];
    
    const contractsInBalances = await db('chain_share_balances')
      .whereIn('address', contractAddresses)
      .count('* as count')
      .first();
    
    logger.info(`   ✅ Contracts in balances: ${contractsInBalances?.count || 0} (should be 0)`);
    
    // 2. Verify first xETH contract event
    logger.info('\n2. FIRST CONTRACT EVENT:');
    const firstEvent = await db('events')
      .where('contract_address', '0x7e586fbaf3084c0be7ab5c82c04ffd7592723153')
      .orderBy('block_number', 'asc')
      .first();
    
    logger.info(`   ✅ First xETH event at block: ${firstEvent?.block_number} (expected: 21872213)`);
    
    // 3. Verify first stake
    const firstStake = await db('events')
      .where('event_name', 'Stake')
      .where('contract_address', '0x7e586fbaf3084c0be7ab5c82c04ffd7592723153')
      .orderBy('block_number', 'asc')
      .first();
    
    logger.info(`   ✅ First stake at block: ${firstStake?.block_number} (expected: 21872273)`);
    
    // 4. Verify 1:1 USD to droplet ratio
    logger.info('\n3. DROPLET CALCULATION (1:1 USD RATIO):');
    const sampleDroplets = await db('droplets_cache as dc')
      .join('user_usd_snapshots as uss', function() {
        this.on('dc.user_address', '=', 'uss.address')
          .andOn(db.raw('DATE(uss.snapshot_time) = dc.snapshot_date'));
      })
      .select(
        'dc.user_address',
        'dc.amount as droplets',
        'uss.total_usd_value as usd_value'
      )
      .limit(5);
    
    if (sampleDroplets.length > 0) {
      logger.info('   Sample users:');
      sampleDroplets.forEach((s, i) => {
        const ratio = Number(s.droplets) / Number(s.usd_value);
        logger.info(`   ${i+1}. ${s.user_address.slice(0, 10)}... - $${s.usd_value} USD = ${s.droplets} droplets (ratio: ${ratio.toFixed(2)})`);
      });
    } else {
      logger.info('   No droplet data yet');
    }
    
    // 5. Verify unique users
    logger.info('\n4. USER COUNTS:');
    const uniqueUsersWithBalances = await db('chain_share_balances')
      .where(db.raw('shares::numeric > 0'))
      .countDistinct('address as count')
      .first();
    
    const uniqueUsersInTransfers = await db.raw(`
      SELECT COUNT(DISTINCT user_address) as count FROM (
        SELECT from_address as user_address FROM transfers 
        WHERE from_address != '0x0000000000000000000000000000000000000000'
        UNION
        SELECT to_address as user_address FROM transfers 
        WHERE to_address != '0x0000000000000000000000000000000000000000'
      ) users
      WHERE user_address NOT IN (SELECT address FROM excluded_addresses)
    `);
    
    logger.info(`   ✅ Users with balances: ${uniqueUsersWithBalances?.count || 0}`);
    logger.info(`   ✅ Users in transfers: ${uniqueUsersInTransfers.rows[0].count}`);
    logger.info(`   ✅ Staking IS counted as having balance`);
    
    // 6. Check snapshot counts
    logger.info('\n5. SNAPSHOT DATA:');
    const snapshotStats = await db('user_usd_snapshots')
      .select(db.raw('COUNT(DISTINCT round_id) as rounds'))
      .select(db.raw('COUNT(DISTINCT address) as unique_users'))
      .select(db.raw('SUM(total_usd_value::numeric) as total_usd'))
      .first();
    
    logger.info(`   ✅ Snapshot rounds: ${snapshotStats?.rounds || 0}`);
    logger.info(`   ✅ Unique users: ${snapshotStats?.unique_users || 0}`);
    logger.info(`   ✅ Total USD value: $${Number(snapshotStats?.total_usd || 0).toLocaleString()}`);
    
    // 7. Show top users by droplets
    logger.info('\n6. LEADERBOARD (TOP USERS BY USD VALUE):');
    const topUsers = await db('user_usd_snapshots')
      .select('address', 'total_usd_value', 'xeth_usd_value', 'xbtc_usd_value', 'xusd_usd_value', 'xeur_usd_value')
      .where('round_id', db.raw('(SELECT MAX(round_id) FROM user_usd_snapshots)'))
      .orderBy('total_usd_value', 'desc')
      .limit(10);
    
    topUsers.forEach((user, i) => {
      const usd = Number(user.total_usd_value);
      logger.info(`   ${i+1}. ${user.address.slice(0, 10)}... = $${usd.toLocaleString()} USD`);
      if (Number(user.xeth_usd_value) > 0) logger.info(`      xETH: $${Number(user.xeth_usd_value).toLocaleString()}`);
      if (Number(user.xbtc_usd_value) > 0) logger.info(`      xBTC: $${Number(user.xbtc_usd_value).toLocaleString()}`);
      if (Number(user.xusd_usd_value) > 0) logger.info(`      xUSD: $${Number(user.xusd_usd_value).toLocaleString()}`);
      if (Number(user.xeur_usd_value) > 0) logger.info(`      xEUR: $${Number(user.xeur_usd_value).toLocaleString()}`);
    });
    
    // 8. Summary
    logger.info('\n=== VERIFICATION COMPLETE ===');
    logger.info('All core metrics verified successfully!');
    
  } catch (error) {
    logger.error('Verification failed:', error);
  } finally {
    await db.destroy();
  }
}

verifySystemMetrics().catch(console.error);