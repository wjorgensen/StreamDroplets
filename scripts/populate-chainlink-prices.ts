import { ethers } from 'ethers';
import { getDb } from '../src/db/connection';
import { createLogger } from '../src/utils/logger';

const logger = createLogger('ChainlinkPricePopulator');

// Chainlink Price Feed addresses on Ethereum mainnet
const PRICE_FEEDS = {
  'ETH/USD': '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419',
  'BTC/USD': '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c',
  'EUR/USD': '0xb49f677943BC038e9857d61E7d053CaA2C1734C1',
  // USDC/USD for xUSD
  'USDC/USD': '0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6',
};

const CHAINLINK_ABI = [
  'function latestRoundData() view returns (uint80 roundId, int256 price, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function getRoundData(uint80 _roundId) view returns (uint80 roundId, int256 price, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
];

interface PriceData {
  timestamp: Date;
  price: number;
  asset: string;
}

async function populateChainlinkPrices() {
  const db = await getDb();
  const provider = new ethers.JsonRpcProvider('https://eth-mainnet.g.alchemy.com/v2/UqwRvCeB71FIweoaOAIoH2FYqJ6iottq');
  
  try {
    logger.info('Starting Chainlink price population...');
    
    // Get the date range we need prices for
    const startDate = new Date('2024-01-01'); // Adjust as needed
    const endDate = new Date();
    
    for (const [pair, feedAddress] of Object.entries(PRICE_FEEDS)) {
      logger.info(`Fetching prices for ${pair}...`);
      
      const priceFeed = new ethers.Contract(feedAddress, CHAINLINK_ABI, provider);
      const decimals = await priceFeed.decimals();
      
      // Get latest round data to find current round
      const latestRound = await priceFeed.latestRoundData();
      let currentRoundId = BigInt(latestRound.roundId.toString());
      
      const prices: PriceData[] = [];
      const targetTimestamp = Math.floor(startDate.getTime() / 1000);
      
      // Work backwards through rounds to get historical data
      while (currentRoundId > 0n && prices.length < 365) { // Limit to 365 days of data
        try {
          const roundData = await priceFeed.getRoundData(currentRoundId);
          const timestamp = Number(roundData.updatedAt);
          
          if (timestamp < targetTimestamp) {
            break; // We've gone far enough back
          }
          
          const price = Number(roundData.price) / Math.pow(10, decimals);
          const asset = pair.split('/')[0].toLowerCase();
          
          prices.push({
            timestamp: new Date(timestamp * 1000),
            price,
            asset: asset === 'usdc' ? 'xusd' : `x${asset}`,
          });
          
          currentRoundId--;
          
          // Rate limiting
          if (prices.length % 10 === 0) {
            await new Promise(resolve => setTimeout(resolve, 100));
            logger.debug(`  Fetched ${prices.length} prices for ${pair}`);
          }
        } catch (error) {
          logger.debug(`Round ${currentRoundId} not available, continuing...`);
          currentRoundId--;
        }
      }
      
      logger.info(`Fetched ${prices.length} historical prices for ${pair}`);
      
      // Store prices in database
      if (prices.length > 0) {
        // Group by day and take the last price of each day
        const dailyPrices = new Map<string, PriceData>();
        
        for (const priceData of prices) {
          const dateKey = priceData.timestamp.toISOString().split('T')[0];
          dailyPrices.set(dateKey, priceData);
        }
        
        // Insert into oracle_prices_timeline table
        for (const [dateKey, priceData] of dailyPrices) {
          await db('oracle_prices_timeline')
            .insert({
              asset_type: priceData.asset,
              price: priceData.price.toString(),
              timestamp: priceData.timestamp,
              source: 'chainlink',
              created_at: new Date(),
            })
            .onConflict(['asset_type', 'timestamp'])
            .merge();
        }
        
        logger.info(`Stored ${dailyPrices.size} daily prices for ${pair}`);
      }
    }
    
    // Verify what we have
    const priceCounts = await db('oracle_prices_timeline')
      .select('asset_type')
      .count('* as count')
      .groupBy('asset_type');
    
    logger.info('Price counts by asset:');
    for (const row of priceCounts) {
      logger.info(`  ${row.asset_type}: ${row.count} prices`);
    }
    
    // Get sample prices for today
    const today = new Date();
    const todayPrices = await db('oracle_prices_timeline')
      .select('*')
      .where('timestamp', '>=', new Date(today.toISOString().split('T')[0]))
      .orderBy('timestamp', 'desc')
      .limit(4);
    
    if (todayPrices.length > 0) {
      logger.info('Latest prices:');
      for (const price of todayPrices) {
        logger.info(`  ${price.asset_type}: $${price.price} at ${price.timestamp}`);
      }
    }
    
  } catch (error) {
    logger.error('Error populating Chainlink prices:', error);
  } finally {
    await db.destroy();
  }
}

populateChainlinkPrices().catch(console.error);