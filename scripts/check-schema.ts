import { getDb } from '../src/db/connection';

async function checkSchema() {
  const db = await getDb();
  
  try {
    const cols = await db('chain_share_balances').columnInfo();
    console.log('chain_share_balances columns:', Object.keys(cols));
    console.log('Column details:', cols);
  } finally {
    await db.destroy();
  }
}

checkSchema().catch(console.error);