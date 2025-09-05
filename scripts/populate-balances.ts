import { getDb } from '../src/db/connection';

async function populateBalances() {
  const db = await getDb();
  
  try {
    console.log('Populating chain_share_balances table...');
    
    // Clear existing entries
    await db('chain_share_balances').del();
    
    // Get all unique users and their final balances per chain
    const balances = await db.raw(`
      WITH transfer_flows AS (
        -- Outflows (negative)
        SELECT 
          chain_id,
          from_address as user_address,
          asset,
          -SUM(CAST(value AS NUMERIC)) as net_value
        FROM transfers
        WHERE from_address != '0x0000000000000000000000000000000000000000'
        GROUP BY chain_id, from_address, asset
        
        UNION ALL
        
        -- Inflows (positive)
        SELECT 
          chain_id,
          to_address as user_address,
          asset,
          SUM(CAST(value AS NUMERIC)) as net_value
        FROM transfers
        WHERE to_address != '0x0000000000000000000000000000000000000000'
        GROUP BY chain_id, to_address, asset
      ),
      user_balances AS (
        SELECT 
          chain_id,
          user_address,
          asset,
          SUM(net_value) as balance,
          MAX(chain_id) as last_block -- This should be block_number but transfers don't have it in same table
        FROM transfer_flows
        WHERE user_address NOT IN (SELECT address FROM excluded_addresses)
        GROUP BY chain_id, user_address, asset
        HAVING SUM(net_value) > 0 -- Only keep positive balances
      )
      SELECT * FROM user_balances
      ORDER BY balance DESC
    `);
    
    console.log(`Found ${balances.rows.length} non-zero balances`);
    
    // Get the latest block number for each chain
    const latestBlocks = await db('transfers')
      .select('chain_id')
      .max('block_number as latest_block')
      .groupBy('chain_id');
    
    const blockMap = new Map(latestBlocks.map(b => [b.chain_id, b.latest_block]));
    
    // Insert balances
    const toInsert = balances.rows.map((row: any) => ({
      chain_id: row.chain_id,
      address: row.user_address.toLowerCase(),
      asset: row.asset,
      shares: row.balance.toString(),
      last_block: blockMap.get(row.chain_id) || 0,
      last_updated: new Date()
    }));
    
    if (toInsert.length > 0) {
      await db('chain_share_balances').insert(toInsert);
      console.log(`Inserted ${toInsert.length} balance records`);
      
      // Show top users
      const topUsers = await db('chain_share_balances')
        .select('address', 'asset')
        .sum('shares as total_balance')
        .groupBy('address', 'asset')
        .orderBy('total_balance', 'desc')
        .limit(10);
      
      console.log('\nTop 10 users by balance:');
      topUsers.forEach((u: any) => {
        console.log(`  ${u.address} (${u.asset}): ${u.total_balance}`);
      });
    }
    
    // Summary
    const summary = await db('chain_share_balances')
      .select('chain_id', 'asset')
      .count('* as user_count')
      .sum('shares as total_balance')
      .groupBy('chain_id', 'asset');
    
    console.log('\nSummary by chain and asset:');
    summary.forEach((s: any) => {
      console.log(`  Chain ${s.chain_id} ${s.asset}: ${s.user_count} users, total: ${s.total_balance}`);
    });
    
  } finally {
    await db.destroy();
  }
}

populateBalances().catch(console.error);