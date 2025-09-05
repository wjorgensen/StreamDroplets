import { getDb } from '../src/db/connection';

async function checkUsers() {
  const db = await getDb();
  
  try {
    // Check transfers table columns
    const transferColumns = await db('transfers').columnInfo();
    console.log('Transfers table columns:', Object.keys(transferColumns));
    
    // Check transfers table  
    const transferUsers = await db('transfers')
      .countDistinct('from_address as count')
      .whereNot('from_address', '0x0000000000000000000000000000000000000000')
      .whereNotIn('from_address', db('excluded_addresses').select('address'))
      .first();
      
    const transferReceivers = await db('transfers')
      .countDistinct('to_address as count')
      .whereNot('to_address', '0x0000000000000000000000000000000000000000')
      .whereNotIn('to_address', db('excluded_addresses').select('address'))
      .first();
    
    // Get all unique users (both senders and receivers)
    const allUsers = await db.raw(`
      SELECT COUNT(DISTINCT user_address) as count FROM (
        SELECT from_address as user_address FROM transfers 
        WHERE from_address != '0x0000000000000000000000000000000000000000'
        UNION
        SELECT to_address as user_address FROM transfers 
        WHERE to_address != '0x0000000000000000000000000000000000000000'
      ) users
      WHERE user_address NOT IN (SELECT address FROM excluded_addresses)
    `);
    
    // Check chain_share_balances
    const balanceUsers = await db('chain_share_balances')
      .count('* as count')
      .first();
    
    // Count total events and transfers
    const totalEvents = await db('events').count('* as count').first();
    const totalTransfers = await db('transfers').count('* as count').first();
    
    console.log('\nData counts:');
    console.log('- Total events:', totalEvents?.count || 0);
    console.log('- Total transfers:', totalTransfers?.count || 0);
    console.log('- Unique senders in transfers:', transferUsers?.count || 0);
    console.log('- Unique receivers in transfers:', transferReceivers?.count || 0);
    console.log('- Total unique users (senders + receivers):', allUsers?.rows?.[0]?.count || 0);
    console.log('- Chain share balances:', balanceUsers?.count || 0);
    
    // Get sample users
    const sampleUsers = await db('transfers')
      .select('from_address')
      .whereNot('from_address', '0x0000000000000000000000000000000000000000')
      .whereNotIn('from_address', db('excluded_addresses').select('address'))
      .groupBy('from_address')
      .limit(20);
    
    if (sampleUsers.length > 0) {
      console.log('\nSample users from transfers:');
      sampleUsers.forEach(u => console.log('  -', u.from_address));
    }
    
    // Check what chains have data
    const chainData = await db('transfers')
      .select('chain')
      .count('* as count')
      .groupBy('chain');
    
    console.log('\nTransfers by chain:');
    chainData.forEach(c => console.log(`  - ${c.chain}: ${c.count} transfers`));
    
    // Check events decoded data
    const sampleEvent = await db('events').first();
    if (sampleEvent) {
      console.log('\nSample event decoded_data:', JSON.stringify(sampleEvent.decoded_data, null, 2));
    }
    
  } finally {
    await db.destroy();
  }
}

checkUsers().catch(console.error);