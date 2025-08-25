#!/usr/bin/env npx tsx
import { getDb } from './src/db/connection';

const API_BASE = 'http://localhost:3000/api/v1';

async function recalculateAllUsers() {
  const db = getDb();
  
  console.log('🔄 Starting recalculation for ALL users with balance snapshots...\n');
  
  // Get all unique addresses with any balance snapshots
  const addresses = await db('balance_snapshots')
    .select('address')
    .where('shares_at_start', '>', 0)
    .groupBy('address')
    .orderBy('address');
  
  console.log(`Found ${addresses.length} addresses with balance snapshots\n`);
  
  let success = 0;
  let failed = 0;
  
  for (const row of addresses) {
    const address = row.address;
    process.stdout.write(`Processing ${address}... `);
    
    try {
      const response = await fetch(`${API_BASE}/droplets/calculate/${address}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      
      const data = await response.json();
      
      if (data.success) {
        const total = data.results?.reduce((sum: number, r: any) => 
          sum + (parseFloat(r.totalDroplets) || 0), 0) || 0;
        
        if (total > 0) {
          console.log(`✅ ${total.toFixed(2)} droplets`);
        } else {
          console.log(`⚪ 0 droplets (might have tiny balance)`);
        }
        success++;
      } else {
        console.log('❌ Failed');
        failed++;
      }
    } catch (error: any) {
      console.log(`❌ Error: ${error.message}`);
      failed++;
    }
  }
  
  console.log('\n' + '='.repeat(60));
  console.log(`✅ Successfully processed: ${success} addresses`);
  console.log(`❌ Failed: ${failed} addresses`);
  console.log(`📊 Total addresses processed: ${addresses.length}`);
  
  // Show final count of users with droplets
  const finalCount = await db('droplets_cache')
    .count('* as count')
    .where('droplets_total', '>', 0)
    .first();
  
  console.log(`\n🎯 Total users with droplets > 0: ${finalCount?.count || 0}`);
  
  process.exit(0);
}

recalculateAllUsers().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});