/**
 * Full Historical Reindex Script
 * Clears existing data and reindexes from contract deployment
 */

import { AlchemyOptimizedIndexer } from '../indexer/AlchemyOptimizedIndexer';
import { getDb } from '../db/connection';
import { createLogger } from '../utils/logger';
import { CONTRACTS } from '../config/contracts';
import { Network } from 'alchemy-sdk';
import dotenv from 'dotenv';

dotenv.config();

const logger = createLogger('FullReindex');
const db = getDb();

// xETH deployed 190 days ago from Sept 2, 2025
// That's around Feb 24, 2025 (but this seems wrong as it's in the future)
// The user mentioned staking for 3 months and unstaking on Aug 26
// So likely deployed around May-June 2024
// Ethereum averages ~7200 blocks per day
// June 1, 2024 would be approximately block 20,000,000
const XETH_DEPLOYMENT_BLOCK = 20000000; // June 2024 approximate

async function fullReindex() {
  logger.info('Starting full historical reindex...');
  
  try {
    // Step 1: Clear existing data
    logger.info('Clearing existing data...');
    await db.raw(`
      TRUNCATE TABLE 
        share_events,
        unified_share_events,
        chain_share_balances,
        daily_usd_snapshots,
        droplets_leaderboard,
        stakes,
        unstakes,
        rounds,
        share_transfers,
        transfers,
        events
      CASCADE
    `);
    
    // Reset cursors to deployment block
    await db('cursors').update({ last_safe_block: XETH_DEPLOYMENT_BLOCK });
    
    logger.info('Data cleared. Starting indexer...');
    
    // Step 2: Configure indexer with proper start blocks
    const indexerConfig = {
      apiKey: process.env.ALCHEMY_API_KEY_1!,
      network: Network.ETH_MAINNET,
      contracts: [
        {
          address: CONTRACTS.xETH.ethereum,
          symbol: 'xETH',
          chainId: 1,
          startBlock: XETH_DEPLOYMENT_BLOCK,
          type: 'vault' as const,
        },
        {
          address: CONTRACTS.xBTC.ethereum,
          symbol: 'xBTC',
          chainId: 1,
          startBlock: XETH_DEPLOYMENT_BLOCK,
          type: 'vault' as const,
        },
        {
          address: CONTRACTS.xUSD.ethereum,
          symbol: 'xUSD',
          chainId: 1,
          startBlock: XETH_DEPLOYMENT_BLOCK,
          type: 'vault' as const,
        },
        {
          address: CONTRACTS.xEUR.ethereum,
          symbol: 'xEUR',
          chainId: 1,
          startBlock: XETH_DEPLOYMENT_BLOCK,
          type: 'vault' as const,
        },
      ],
    };
    
    // Step 3: Run the indexer
    const indexer = new AlchemyOptimizedIndexer(indexerConfig);
    
    indexer.on('started', () => {
      logger.info('Indexer started successfully');
    });
    
    indexer.on('error', (error) => {
      logger.error('Indexer error:', error);
    });
    
    indexer.on('eventProcessed', ({ eventName, contract, blockNumber }) => {
      if (blockNumber % 10000 === 0) {
        logger.info(`Processing block ${blockNumber} - ${eventName} from ${contract}`);
      }
    });
    
    // Start indexing
    await indexer.start();
    
    // Run for a while to collect data
    logger.info('Indexer running. Press Ctrl+C to stop...');
    
    // Keep the process alive
    process.on('SIGINT', async () => {
      logger.info('Shutting down...');
      await indexer.stop();
      await db.destroy();
      process.exit(0);
    });
    
  } catch (error) {
    logger.error('Reindex failed:', error);
    await db.destroy();
    process.exit(1);
  }
}

// Run the reindex
fullReindex()
  .then(() => {
    logger.info('Reindex started successfully');
  })
  .catch((error) => {
    logger.error('Fatal error:', error);
    process.exit(1);
  });