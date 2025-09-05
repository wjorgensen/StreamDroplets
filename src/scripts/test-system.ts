/**
 * Simple test script to verify the system setup
 * Can be run without full compilation
 */

import { getDb } from '../db/connection';
import dotenv from 'dotenv';

dotenv.config();

const db = getDb();

async function testDatabaseSetup() {
  console.log('Testing Database Setup...\n');
  
  try {
    // Check connection
    await db.raw('SELECT 1');
    console.log('✅ Database connection successful');
    
    // Check tables
    const tables = await db.raw(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    
    console.log(`\nFound ${tables.rows.length} tables:`);
    tables.rows.forEach((row: any) => {
      console.log(`  - ${row.table_name}`);
    });
    
    // Check for new unified tables
    const requiredTables = [
      'unified_share_events',
      'chain_share_balances', 
      'user_usd_snapshots',
      'droplets_leaderboard',
      'round_snapshot_jobs'
    ];
    
    console.log('\nChecking required tables for unified USD system:');
    for (const tableName of requiredTables) {
      const exists = tables.rows.some((row: any) => row.table_name === tableName);
      console.log(`  ${exists ? '✅' : '❌'} ${tableName}`);
    }
    
    // Check existing data
    console.log('\n=== Existing Data Summary ===');
    
    // Share events
    const shareEvents = await db('share_events').count('* as count').first();
    console.log(`Share Events: ${shareEvents?.count || 0}`);
    
    // Rounds
    const rounds = await db('rounds')
      .where('chain_id', 1)
      .whereNotNull('end_ts')
      .count('* as count')
      .first();
    console.log(`Completed Rounds: ${rounds?.count || 0}`);
    
    // Balance snapshots
    const snapshots = await db('balance_snapshots').count('* as count').first();
    console.log(`Balance Snapshots: ${snapshots?.count || 0}`);
    
    // Unique addresses
    const addresses = await db('share_events')
      .countDistinct('address as count')
      .first();
    console.log(`Unique Addresses: ${addresses?.count || 0}`);
    
    // Check if integrations are set up
    console.log('\n=== Integration Setup ===');
    
    const hasIntegrationTables = await db.raw(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN ('integration_protocols', 'integration_positions')
    `);
    
    if (hasIntegrationTables.rows.length > 0) {
      const protocols = await db('integration_protocols').count('* as count').first();
      console.log(`Integration Protocols: ${protocols?.count || 0}`);
      
      const positions = await db('integration_positions').count('* as count').first();
      console.log(`Integration Positions: ${positions?.count || 0}`);
    } else {
      console.log('Integration tables not found (run migration 006)');
    }
    
    // Check excluded addresses
    const excluded = await db('excluded_addresses').count('* as count').first();
    console.log(`Excluded Addresses: ${excluded?.count || 0}`);
    
    // Sample data check
    console.log('\n=== Sample Data ===');
    
    // Get a sample address with activity
    const sampleAddress = await db('share_events')
      .select('address')
      .groupBy('address')
      .orderBy(db.raw('COUNT(*)'), 'desc')
      .first();
    
    if (sampleAddress) {
      console.log(`\nSample address: ${sampleAddress.address}`);
      
      // Check their events
      const events = await db('share_events')
        .where('address', sampleAddress.address)
        .count('* as count')
        .first();
      console.log(`  Events: ${events?.count || 0}`);
      
      // Check their balance snapshots
      const balanceSnapshots = await db('balance_snapshots')
        .where('address', sampleAddress.address)
        .count('* as count')
        .first();
      console.log(`  Balance Snapshots: ${balanceSnapshots?.count || 0}`);
      
      // Check if they have unified data
      if (tables.rows.some((r: any) => r.table_name === 'user_usd_snapshots')) {
        const usdSnapshots = await db('user_usd_snapshots')
          .where('address', sampleAddress.address)
          .count('* as count')
          .first();
        console.log(`  USD Snapshots: ${usdSnapshots?.count || 0}`);
      }
      
      if (tables.rows.some((r: any) => r.table_name === 'droplets_leaderboard')) {
        const leaderboard = await db('droplets_leaderboard')
          .where('address', sampleAddress.address)
          .first();
        if (leaderboard) {
          console.log(`  Total Droplets: ${leaderboard.total_droplets}`);
          console.log(`  Rounds Participated: ${leaderboard.rounds_participated}`);
        }
      }
    }
    
    console.log('\n=== System Status ===');
    
    // Check if migrations need to be run
    const migrationStatus = await db('knex_migrations')
      .orderBy('id', 'desc')
      .first();
    
    console.log(`Latest Migration: ${migrationStatus?.name || 'None'}`);
    
    const pendingMigrations = [
      '006_integration_tracking.ts',
      '007_multi_chain_balance_tracking.ts',
      '008_unified_usd_balance_tracking.ts'
    ];
    
    console.log('\nMigration Status:');
    for (const migration of pendingMigrations) {
      const exists = await db('knex_migrations')
        .where('name', migration)
        .first();
      console.log(`  ${exists ? '✅' : '❌'} ${migration}`);
    }
    
    // Recommendation
    console.log('\n=== Recommendations ===');
    
    const hasNewTables = tables.rows.some((r: any) => r.table_name === 'user_usd_snapshots');
    
    if (!hasNewTables) {
      console.log('❌ New unified USD tables not found.');
      console.log('   Run: npx knex migrate:latest --knexfile src/db/knexfile.ts');
    } else {
      const hasData = await db('user_usd_snapshots').count('* as count').first();
      if (!hasData?.count || hasData.count === 0) {
        console.log('⚠️  Unified USD tables exist but have no data.');
        console.log('   Run: npx tsx src/scripts/backfill-and-test.ts');
      } else {
        console.log('✅ System appears to be set up correctly!');
        console.log(`   ${hasData.count} USD snapshots found`);
      }
    }
    
  } catch (error) {
    console.error('❌ Database test failed:', error);
    console.error('\nMake sure:');
    console.error('1. PostgreSQL is running');
    console.error('2. Database credentials in .env are correct');
    console.error('3. Database "stream_droplets" exists');
  } finally {
    await db.destroy();
  }
}

// Run the test
testDatabaseSetup()
  .then(() => {
    console.log('\nTest complete!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });