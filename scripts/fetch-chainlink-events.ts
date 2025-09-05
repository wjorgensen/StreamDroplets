import { ethers } from 'ethers';
import { getDb } from '../src/db/connection';
import { createLogger } from '../src/utils/logger';

const logger = createLogger('ChainlinkEventFetcher');

// Chainlink Price Feed contracts on Ethereum mainnet
const PRICE_FEEDS = {
  'ETH/USD': {
    address: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419',
    asset: 'xETH',
    decimals: 8
  },
  'BTC/USD': {
    address: '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c',
    asset: 'xBTC',
    decimals: 8
  },
  'EUR/USD': {
    address: '0xb49f677943BC038e9857d61E7d053CaA2C1734C1',
    asset: 'xEUR',
    decimals: 8
  },
  'USDC/USD': {
    address: '0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6',
    asset: 'xUSD',
    decimals: 8
  },
};

// Event signatures from the contract
const ANSWER_UPDATED_EVENT = 'AnswerUpdated(int256,uint256,uint256)';
const ANSWER_UPDATED_TOPIC = ethers.id(ANSWER_UPDATED_EVENT);

interface PriceUpdate {
  price: bigint;
  roundId: bigint;
  updatedAt: number;
  blockNumber: number;
}

async function fetchChainlinkEvents() {
  const provider = new ethers.JsonRpcProvider('https://eth-mainnet.g.alchemy.com/v2/UqwRvCeB71FIweoaOAIoH2FYqJ6iottq');
  const db = await getDb();
  
  try {
    logger.info('Fetching Chainlink AnswerUpdated events...');
    
    // Calculate date range - from contract deployment to now
    const endBlock = await provider.getBlockNumber();
    const startBlock = 21872213; // Contract deployment block
    
    for (const [pair, feed] of Object.entries(PRICE_FEEDS)) {
      logger.info(`Fetching price events for ${pair} from ${feed.address}...`);
      
      // Fetch in chunks of 10000 blocks to avoid RPC limits
      const chunkSize = 10000;
      let allLogs: any[] = [];
      
      for (let fromBlock = startBlock; fromBlock <= endBlock; fromBlock += chunkSize) {
        const toBlock = Math.min(fromBlock + chunkSize - 1, endBlock);
        
        try {
          // Create filter for AnswerUpdated events
          const filter = {
            address: feed.address,
            topics: [ANSWER_UPDATED_TOPIC],
            fromBlock,
            toBlock,
          };
          
          // Fetch logs
          const logs = await provider.getLogs(filter);
          allLogs = allLogs.concat(logs);
          
          if (logs.length > 0) {
            logger.info(`  Block ${fromBlock}-${toBlock}: found ${logs.length} events`);
          }
        } catch (error) {
          logger.error(`  Error fetching blocks ${fromBlock}-${toBlock}: ${error}`);
        }
      }
      
      const logs = allLogs;
      logger.info(`Found ${logs.length} price updates for ${pair}`);
      
      // Process logs and group by day
      const dailyPrices = new Map<string, PriceUpdate>();
      
      for (const log of logs) {
        try {
          // Decode the event
          // AnswerUpdated(int256 current, uint256 roundId, uint256 updatedAt)
          const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
            ['int256', 'uint256', 'uint256'],
            log.data
          );
          
          const price = decoded[0];
          const roundId = decoded[1];
          const updatedAt = Number(decoded[2]);
          
          // Convert timestamp to date
          const date = new Date(updatedAt * 1000);
          const dateKey = date.toISOString().split('T')[0];
          
          // Store the price closest to midnight for each day
          const existingPrice = dailyPrices.get(dateKey);
          if (!existingPrice) {
            dailyPrices.set(dateKey, {
              price,
              roundId,
              updatedAt,
              blockNumber: log.blockNumber,
            });
          } else {
            // Check which is closer to midnight
            const midnight = new Date(dateKey + 'T00:00:00Z').getTime() / 1000;
            const existingDiff = Math.abs(existingPrice.updatedAt - midnight);
            const newDiff = Math.abs(updatedAt - midnight);
            
            if (newDiff < existingDiff) {
              dailyPrices.set(dateKey, {
                price,
                roundId,
                updatedAt,
                blockNumber: log.blockNumber,
              });
            }
          }
        } catch (error) {
          logger.error(`Error processing log: ${error}`);
        }
      }
      
      logger.info(`Processed ${dailyPrices.size} daily prices for ${pair}`);
      
      // Store in database
      for (const [dateKey, priceData] of dailyPrices) {
        const priceInUSD = Number(priceData.price) / Math.pow(10, feed.decimals);
        
        await db('oracle_prices_timeline')
          .insert({
            asset: feed.asset,
            chain_id: 1,
            block_number: priceData.blockNumber,
            timestamp: new Date(priceData.updatedAt * 1000),
            price_usd: priceInUSD.toString(),
            chainlink_round_id: priceData.roundId.toString(),
            oracle_updated_at: new Date(priceData.updatedAt * 1000),
            source: 'chainlink-events',
            created_at: new Date(),
          })
          .onConflict(['asset', 'timestamp'])
          .merge(['price_usd', 'block_number', 'chainlink_round_id', 'oracle_updated_at']);
      }
    }
    
    // Verify what we have
    const priceCounts = await db('oracle_prices_timeline')
      .select('asset')
      .where('source', 'chainlink-events')
      .count('* as count')
      .groupBy('asset');
    
    logger.info('\nStored price counts by asset:');
    for (const row of priceCounts) {
      logger.info(`  ${row.asset}: ${row.count} daily prices`);
    }
    
    // Get sample prices for verification
    const samplePrices = await db('oracle_prices_timeline')
      .where('source', 'chainlink-events')
      .orderBy('timestamp', 'desc')
      .limit(8);
    
    logger.info('\nLatest prices from events:');
    for (const price of samplePrices) {
      const priceUSD = parseFloat(price.price_usd);
      const date = new Date(price.timestamp).toISOString().split('T')[0];
      logger.info(`  ${date} - ${price.asset}: $${priceUSD.toFixed(2)}`);
    }
    
    logger.info('\n✅ Chainlink event fetching complete!');
    
  } catch (error) {
    logger.error('Error fetching Chainlink events:', error);
  } finally {
    await db.destroy();
  }
}

// Function to get the price at a specific timestamp for snapshots
export async function getChainlinkPriceAtTime(
  asset: string,
  targetTimestamp: Date
): Promise<number | null> {
  const db = await getDb();
  
  try {
    // Find the price closest to the target timestamp
    const targetDateStr = targetTimestamp.toISOString().split('T')[0];
    
    const price = await db('oracle_prices_timeline')
      .where('asset', asset)
      .where('timestamp', '>=', targetDateStr + ' 00:00:00')
      .where('timestamp', '<=', targetDateStr + ' 23:59:59')
      .orderBy('timestamp', 'asc')
      .first();
    
    if (price) {
      return parseFloat(price.price_usd);
    }
    
    // If no price for that day, get the most recent price before it
    const previousPrice = await db('oracle_prices_timeline')
      .where('asset', asset)
      .where('timestamp', '<', targetTimestamp)
      .orderBy('timestamp', 'desc')
      .first();
    
    if (previousPrice) {
      return parseFloat(previousPrice.price_usd);
    }
    
    return null;
  } finally {
    await db.destroy();
  }
}

// Run if called directly
if (require.main === module) {
  fetchChainlinkEvents().catch(console.error);
}