/**
 * Backfill and Test Script
 * Processes historical data and tests the unified USD balance system
 */

import { getDb } from '../db/connection';
import { RoundSnapshotService } from '../services/RoundSnapshotService';
import { ChainBalanceTracker } from '../services/ChainBalanceTracker';
import { SimplifiedAccrualEngine } from '../accrual/SimplifiedAccrualEngine';
import { createLogger } from '../utils/logger';
import dotenv from 'dotenv';

dotenv.config();

const logger = createLogger('BackfillTest');
const db = getDb();

async function backfillHistoricalData() {
  logger.info('Starting historical data backfill...');
  
  try {
    // Step 1: Ensure database migrations are up to date
    logger.info('Checking database schema...');
    const tables = await db.raw(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN (
        'unified_share_events',
        'chain_share_balances',
        'user_usd_snapshots',
        'droplets_leaderboard',
        'round_snapshot_jobs'
      )
    `);
    
    if (tables.rows.length < 5) {
      logger.error('Required tables not found. Please run migrations first:');
      logger.error('npx knex migrate:latest --knexfile src/db/knexfile.ts');
      process.exit(1);
    }
    
    logger.info(`Found ${tables.rows.length} required tables`);
    
    // Step 2: Migrate existing share_events to unified_share_events
    logger.info('Migrating existing events to unified format...');
    
    const existingEvents = await db('share_events')
      .select('*')
      .orderBy('block', 'asc')
      .orderBy('log_index', 'asc');
    
    logger.info(`Found ${existingEvents.length} existing events to migrate`);
    
    if (existingEvents.length > 0) {
      const batchSize = 1000;
      for (let i = 0; i < existingEvents.length; i += batchSize) {
        const batch = existingEvents.slice(i, i + batchSize);
        const unifiedEvents = batch.map(event => ({
          chain_id: event.chain_id,
          address: event.address.toLowerCase(),
          asset: event.asset,
          event_type: mapEventType(event.event_type),
          shares_delta: event.shares_delta,
          block_number: event.block,
          timestamp: event.timestamp,
          tx_hash: event.tx_hash,
          log_index: event.log_index,
          round_id: event.round_id,
        }));
        
        await db('unified_share_events')
          .insert(unifiedEvents)
          .onConflict(['chain_id', 'tx_hash', 'log_index'])
          .ignore();
        
        logger.info(`Migrated ${i + batch.length}/${existingEvents.length} events`);
      }
    }
    
    // Step 3: Build chain balance snapshots
    logger.info('Building chain balance snapshots...');
    const balanceTracker = new ChainBalanceTracker();
    await balanceTracker.rebuildAllBalances();
    
    // Step 4: Get all completed rounds
    logger.info('Finding completed rounds...');
    const completedRounds = await db('rounds')
      .where('chain_id', 1) // Ethereum
      .whereNotNull('end_ts')
      .orderBy('round_id', 'asc')
      .select('round_id', 'asset', 'start_ts', 'end_ts', 'pps');
    
    // Group rounds by round_id
    const roundsMap = new Map<number, any[]>();
    for (const round of completedRounds) {
      if (!roundsMap.has(round.round_id)) {
        roundsMap.set(round.round_id, []);
      }
      roundsMap.get(round.round_id)!.push(round);
    }
    
    logger.info(`Found ${roundsMap.size} unique rounds to process`);
    
    // Step 5: Process each round
    const snapshotService = new RoundSnapshotService();
    let processedCount = 0;
    
    for (const [roundId, _rounds] of roundsMap) {
      // Check if already processed
      const existing = await db('round_snapshot_jobs')
        .where('round_id', roundId)
        .where('status', 'completed')
        .first();
      
      if (existing) {
        logger.info(`Round ${roundId} already processed, skipping`);
        processedCount++;
        continue;
      }
      
      logger.info(`Processing round ${roundId} (${processedCount + 1}/${roundsMap.size})...`);
      
      try {
        await snapshotService.processRoundSnapshot(roundId);
        processedCount++;
      } catch (error) {
        logger.error(`Failed to process round ${roundId}:`, error);
      }
      
      // Add a small delay to avoid overwhelming the system
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    logger.info(`Backfill complete! Processed ${processedCount} rounds`);
    
  } catch (error) {
    logger.error('Backfill failed:', error);
    throw error;
  }
}

async function testSystem() {
  logger.info('\n=== Starting System Tests ===\n');
  
  const engine = new SimplifiedAccrualEngine();
  
  // Test 1: Check if droplets are calculated correctly
  logger.info('Test 1: Checking droplet calculations...');
  
  // Get top addresses from leaderboard
  const topUsers = await db('droplets_leaderboard')
    .orderBy('total_droplets', 'desc')
    .limit(5);
  
  if (topUsers.length === 0) {
    logger.warn('No users found in leaderboard. System may need more data.');
  } else {
    logger.info(`Found ${topUsers.length} users in leaderboard`);
    
    for (const user of topUsers) {
      const result = await engine.calculateDroplets(user.address);
      logger.info(`User ${user.address.slice(0, 10)}...:`);
      logger.info(`  Total Droplets: ${result.droplets}`);
      logger.info(`  Rounds Participated: ${user.rounds_participated}`);
      logger.info(`  Average USD/Round: ${user.average_usd_per_round}`);
    }
  }
  
  // Test 2: Check multi-chain balance aggregation
  logger.info('\nTest 2: Checking multi-chain balance aggregation...');
  
  const chainBalances = await db('chain_share_balances')
    .select('address', 'asset', 'chain_id', 'shares')
    .limit(10);
  
  if (chainBalances.length > 0) {
    // Group by address to see multi-chain holdings
    const addressMap = new Map<string, any[]>();
    for (const balance of chainBalances) {
      if (!addressMap.has(balance.address)) {
        addressMap.set(balance.address, []);
      }
      addressMap.get(balance.address)!.push(balance);
    }
    
    for (const [address, balances] of addressMap) {
      if (balances.length > 1) {
        logger.info(`Multi-chain user ${address.slice(0, 10)}...:`);
        for (const bal of balances) {
          logger.info(`  ${bal.asset} on chain ${bal.chain_id}: ${bal.shares} shares`);
        }
      }
    }
  }
  
  // Test 3: Check USD snapshots
  logger.info('\nTest 3: Checking USD snapshots...');
  
  const latestSnapshots = await db('user_usd_snapshots')
    .orderBy('round_id', 'desc')
    .limit(5);
  
  if (latestSnapshots.length > 0) {
    logger.info(`Latest snapshots (Round ${latestSnapshots[0].round_id}):`);
    for (const snapshot of latestSnapshots) {
      logger.info(`  ${snapshot.address.slice(0, 10)}...:`);
      logger.info(`    Total USD: $${BigInt(snapshot.total_usd_value) / 10n**6n}`);
      logger.info(`    Droplets Earned: ${snapshot.droplets_earned}`);
      logger.info(`    Had Unstake: ${snapshot.had_unstake}`);
    }
  }
  
  // Test 4: Check round processing status
  logger.info('\nTest 4: Checking round processing status...');
  
  const roundJobs = await db('round_snapshot_jobs')
    .orderBy('round_id', 'desc')
    .limit(5);
  
  if (roundJobs.length > 0) {
    logger.info('Recent round processing:');
    for (const job of roundJobs) {
      logger.info(`  Round ${job.round_id}: ${job.status}`);
      logger.info(`    Users: ${job.users_processed}, Droplets: ${job.total_droplets_awarded}`);
    }
  }
  
  // Test 5: Check for data consistency
  logger.info('\nTest 5: Checking data consistency...');
  
  // Check if total droplets in leaderboard matches snapshots
  const leaderboardTotal = await db('droplets_leaderboard')
    .sum('total_droplets as total')
    .first();
  
  const snapshotTotal = await db('user_usd_snapshots')
    .sum('droplets_earned as total')
    .first();
  
  logger.info(`Total droplets in leaderboard: ${leaderboardTotal?.total || 0}`);
  logger.info(`Total droplets in snapshots: ${snapshotTotal?.total || 0}`);
  
  if (leaderboardTotal?.total !== snapshotTotal?.total) {
    logger.warn('⚠️  Droplet totals do not match! May need to rebuild leaderboard.');
  } else {
    logger.info('✅ Droplet totals match!');
  }
  
  // Test 6: Test API endpoint
  logger.info('\nTest 6: Testing API endpoint simulation...');
  
  if (topUsers.length > 0) {
    const testAddress = topUsers[0].address;
    const apiResult = await engine.calculateDroplets(testAddress);
    
    logger.info(`API Response for ${testAddress.slice(0, 10)}...:`);
    logger.info(JSON.stringify(apiResult, null, 2));
  }
  
  // Test 7: Check for excluded addresses
  logger.info('\nTest 7: Checking excluded addresses...');
  
  const excludedCount = await db('excluded_addresses')
    .count('* as count')
    .first();
  
  logger.info(`Total excluded addresses: ${excludedCount?.count || 0}`);
  
  // Check if integration contracts are excluded
  const integrationContracts = await db('integration_protocols')
    .select('contract_address', 'protocol_name');
  
  for (const contract of integrationContracts) {
    const isExcluded = await db('excluded_addresses')
      .where('address', contract.contract_address.toLowerCase())
      .first();
    
    if (isExcluded) {
      logger.info(`✅ ${contract.protocol_name} is excluded`);
    } else {
      logger.warn(`⚠️  ${contract.protocol_name} is NOT excluded!`);
    }
  }
  
  logger.info('\n=== System Tests Complete ===\n');
}

function mapEventType(eventType: string): string {
  // Map old event types to new unified types
  switch (eventType.toLowerCase()) {
    case 'stake':
      return 'stake';
    case 'unstake':
    case 'instant_unstake':
      return 'unstake';
    case 'transfer':
      return 'transfer';
    case 'oft_sent':
    case 'bridge_burn':
      return 'bridge_out';
    case 'oft_received':
    case 'bridge_mint':
      return 'bridge_in';
    default:
      return eventType.toLowerCase();
  }
}

async function main() {
  try {
    logger.info('Stream Droplets Backfill and Test Script');
    logger.info('=========================================\n');
    
    // Run backfill
    await backfillHistoricalData();
    
    // Wait a moment for data to settle
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Run tests
    await testSystem();
    
    // Summary
    const stats = await db('droplets_leaderboard')
      .select(
        db.raw('COUNT(*) as total_users'),
        db.raw('SUM(CAST(total_droplets AS DECIMAL)) as total_droplets'),
        db.raw('AVG(CAST(rounds_participated AS DECIMAL)) as avg_rounds')
      )
      .first();
    
    logger.info('\n=== Final Summary ===');
    logger.info(`Total Users: ${stats?.total_users || 0}`);
    logger.info(`Total Droplets Awarded: ${stats?.total_droplets || 0}`);
    logger.info(`Average Rounds per User: ${Math.round(stats?.avg_rounds || 0)}`);
    
    const pendingRounds = await engine.checkPendingRounds();
    if (pendingRounds.length > 0) {
      logger.warn(`\n⚠️  There are ${pendingRounds.length} rounds pending processing: ${pendingRounds.join(', ')}`);
    } else {
      logger.info('\n✅ All rounds have been processed!');
    }
    
  } catch (error) {
    logger.error('Script failed:', error);
    process.exit(1);
  } finally {
    await db.destroy();
  }
}

// Add this to make the engine available
const engine = new SimplifiedAccrualEngine();

// Run the script
if (require.main === module) {
  main()
    .then(() => {
      logger.info('\nBackfill and test completed successfully!');
      process.exit(0);
    })
    .catch((error) => {
      logger.error('Unhandled error:', error);
      process.exit(1);
    });
}