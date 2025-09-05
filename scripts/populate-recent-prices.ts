import { getDb } from '../src/db/connection';
import { createLogger } from '../src/utils/logger';

const logger = createLogger('PricePopulator');

// Sample prices for testing (realistic values as of 2024)
const SAMPLE_PRICES = {
  'xETH': 3500,   // ETH at $3500
  'xBTC': 65000,  // BTC at $65000
  'xUSD': 1,      // USD stablecoin at $1
  'xEUR': 1.10,   // EUR at $1.10
};

async function populateRecentPrices() {
  const db = await getDb();
  
  try {
    logger.info('Populating recent prices for testing...');
    
    // Generate prices for the last 200 days
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 200);
    
    const records = [];
    const currentDate = new Date(startDate);
    
    while (currentDate <= endDate) {
      for (const [asset, basePrice] of Object.entries(SAMPLE_PRICES)) {
        // Add some random variation (±5%)
        const variation = 0.95 + Math.random() * 0.1;
        const price = basePrice * variation;
        
        records.push({
          asset: asset,
          chain_id: 1, // Ethereum mainnet
          block_number: 19000000 + Math.floor(Math.random() * 1000000), // Fake block number
          price_usd: price.toString(),
          timestamp: new Date(currentDate),
          source: 'chainlink',
          created_at: new Date(),
        });
      }
      
      currentDate.setDate(currentDate.getDate() + 1);
    }
    
    logger.info(`Inserting ${records.length} price records...`);
    
    // Batch insert
    const batchSize = 100;
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      try {
        await db('oracle_prices_timeline').insert(batch);
      } catch (error: any) {
        if (!error.message?.includes('duplicate')) {
          throw error;
        }
      }
      
      if (i % 1000 === 0) {
        logger.info(`  Inserted ${i} records...`);
      }
    }
    
    // Verify
    const counts = await db('oracle_prices_timeline')
      .select('asset')
      .count('* as count')
      .groupBy('asset');
    
    logger.info('Price counts by asset:');
    counts.forEach(c => logger.info(`  ${c.asset}: ${c.count}`));
    
    // Get latest prices
    const latest = await db('oracle_prices_timeline')
      .select('*')
      .orderBy('timestamp', 'desc')
      .limit(4);
    
    logger.info('Latest prices:');
    latest.forEach(p => logger.info(`  ${p.asset}: $${parseFloat(p.price_usd).toFixed(2)}`));
    
  } finally {
    await db.destroy();
  }
}

populateRecentPrices().catch(console.error);