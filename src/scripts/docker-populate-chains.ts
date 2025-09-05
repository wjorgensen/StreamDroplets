import { getDb } from '../db/connection';
import { createLogger } from '../utils/logger';
import * as dotenv from 'dotenv';

dotenv.config();

const logger = createLogger('DockerPopulateChains');

async function populateChains() {
  const db = await getDb();
  
  try {
    logger.info('Populating cross-chain data...');
    
    // Chain configurations with estimated TVL distribution
    const chainData = [
      {
        chainId: 146,
        name: 'Sonic',
        totalTVL: 15000000, // $15M
        userCount: 450,
      },
      {
        chainId: 8453,
        name: 'Base',
        totalTVL: 12000000, // $12M
        userCount: 380,
      },
      {
        chainId: 42161,
        name: 'Arbitrum',
        totalTVL: 10000000, // $10M
        userCount: 320,
      },
      {
        chainId: 43114,
        name: 'Avalanche',
        totalTVL: 8000000, // $8M
        userCount: 250,
      },
      {
        chainId: 81457,
        name: 'Berachain',
        totalTVL: 5000000, // $5M
        userCount: 180,
      },
    ];
    
    for (const chain of chainData) {
      logger.info(`Populating ${chain.name} (Chain ${chain.chainId})...`);
      
      const records = [];
      
      // Generate realistic distribution
      for (let i = 0; i < chain.userCount; i++) {
        // Generate deterministic address for this user
        const userAddress = `0x${(BigInt(chain.chainId) * 1000000n + BigInt(i)).toString(16).padStart(40, '0')}`;
        
        // Power law distribution for value
        let userValue: number;
        if (i < chain.userCount * 0.02) {
          // Top 2% - whales
          userValue = chain.totalTVL * 0.4 / (chain.userCount * 0.02) + Math.random() * 100000;
        } else if (i < chain.userCount * 0.2) {
          // Next 18% - large holders
          userValue = chain.totalTVL * 0.4 / (chain.userCount * 0.18) + Math.random() * 10000;
        } else {
          // Remaining 80% - small holders
          userValue = chain.totalTVL * 0.2 / (chain.userCount * 0.8) + Math.random() * 1000;
        }
        
        // Distribute across assets
        const assets = ['streamETH', 'streamBTC', 'streamUSD', 'streamEUR'];
        const assetWeights = [0.4, 0.3, 0.2, 0.1]; // ETH 40%, BTC 30%, USD 20%, EUR 10%
        const assetPrices = [3488, 95000, 1, 1.05];
        const assetDecimals = [18, 8, 6, 6];
        
        for (let j = 0; j < assets.length; j++) {
          const assetValue = userValue * assetWeights[j];
          if (assetValue > 100) { // Only include if meaningful value
            // Convert to token amount with appropriate decimals
            const tokenAmount = assetValue / assetPrices[j];
            const shares = BigInt(Math.floor(tokenAmount * Math.pow(10, assetDecimals[j])));
            
            if (shares > 0n) {
              records.push({
                address: userAddress.toLowerCase(),
                chain_id: chain.chainId,
                asset: assets[j],
                shares: shares.toString(),
                last_block: 1000000 + i,
                created_at: new Date(),
                updated_at: new Date(),
              });
            }
          }
        }
      }
      
      // Insert records in batches
      if (records.length > 0) {
        const batchSize = 100;
        for (let i = 0; i < records.length; i += batchSize) {
          const batch = records.slice(i, i + batchSize);
          await db('chain_share_balances')
            .insert(batch)
            .onConflict(['address', 'chain_id', 'asset'])
            .merge(['shares', 'last_block', 'updated_at']);
        }
        
        logger.info(`  Inserted ${records.length} balance records for ${chain.name}`);
      }
    }
    
    // Calculate and log total TVL
    const tvlSummary = await db.raw(`
      SELECT 
        chain_id,
        COUNT(DISTINCT address) as users,
        SUM(CASE
          WHEN asset LIKE '%ETH' THEN shares::numeric / 1e18 * 3488
          WHEN asset LIKE '%BTC' THEN shares::numeric / 1e8 * 95000
          WHEN asset LIKE '%USD' THEN 
            CASE WHEN chain_id = 1 THEN shares::numeric / 1e8 
                 ELSE shares::numeric / 1e6 
            END
          WHEN asset LIKE '%EUR' THEN shares::numeric / 1e6 * 1.05
          ELSE 0
        END) as tvl
      FROM chain_share_balances
      WHERE shares::numeric > 0
      GROUP BY chain_id
      ORDER BY chain_id
    `);
    
    let totalTVL = 0;
    tvlSummary.rows.forEach(row => {
      const tvl = Number(row.tvl);
      totalTVL += tvl;
      logger.info(`Chain ${row.chain_id}: $${tvl.toLocaleString()} TVL, ${row.users} users`);
    });
    
    logger.info(`Total TVL across all chains: $${totalTVL.toLocaleString()}`);
    logger.info('Cross-chain data population completed!');
    
  } catch (error) {
    logger.error('Failed to populate chains:', error);
    throw error;
  } finally {
    await db.destroy();
  }
}

// Run if called directly
if (require.main === module) {
  populateChains().catch(error => {
    logger.error('Fatal error:', error);
    process.exit(1);
  });
}

export { populateChains };