#!/usr/bin/env npx tsx
import { getDb } from './src/db/connection';
import { AccrualEngine } from './src/accrual/AccrualEngine';

async function recalculateAllUsers() {
  const db = getDb();
  const engine = new AccrualEngine();
  
  console.log('🔄 Starting direct recalculation for ALL users with balance snapshots...\n');
  
  // Get all unique addresses with any balance snapshots (not just those with current positive balance)
  const addresses = await db('balance_snapshots')
    .select('address')
    .where('shares_at_start', '>', 0)
    .groupBy('address')
    .orderBy('address');
  
  console.log(`Found ${addresses.length} addresses with balance snapshots\n`);
  
  let success = 0;
  let failed = 0;
  let withDroplets = 0;
  
  for (const row of addresses) {
    const address = row.address;
    process.stdout.write(`Processing ${address}... `);
    
    try {
      const result = await engine.calculateDroplets(address);
      
      const total = Number(result.totalDroplets) / 1e18;
      
      if (total > 0) {
        console.log(`✅ ${total.toFixed(2)} droplets`);
        withDroplets++;
      } else {
        console.log(`⚪ 0 droplets`);
      }
      success++;
    } catch (error: any) {
      console.log(`❌ Error: ${error.message}`);
      failed++;
    }
  }
  
  console.log('\n' + '='.repeat(60));
  console.log(`✅ Successfully processed: ${success} addresses`);
  console.log(`💧 Addresses with droplets > 0: ${withDroplets}`);
  console.log(`❌ Failed: ${failed} addresses`);
  console.log(`📊 Total addresses processed: ${addresses.length}`);
  
  // Show final count of users with droplets
  const finalCount = await db('droplets_cache')
    .count('* as count')
    .where('droplets_total', '>', 0)
    .first();
  
  console.log(`\n🎯 Total users with droplets > 0 in cache: ${finalCount?.count || 0}`);
  
  process.exit(0);
}

recalculateAllUsers().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});