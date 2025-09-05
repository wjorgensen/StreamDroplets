/**
 * Targeted Historical Index Script
 * Indexes a specific date range for faster testing
 */

import { AlchemyOptimizedIndexer } from '../indexer/AlchemyOptimizedIndexer';
import { getDb } from '../db/connection';
import { createLogger } from '../utils/logger';
import { CONTRACTS } from '../config/contracts';
import { Network } from 'alchemy-sdk';
import dotenv from 'dotenv';

dotenv.config();

const logger = createLogger('TargetedIndex');
const db = getDb();

// Target specific timeframe
// User mentioned staking for ~3 months and unstaking on Aug 26
// Let's index May 1 - Sept 1, 2024
// May 1, 2024 is approximately block 19,780,000
// Sept 1, 2024 is approximately block 20,650,000
const START_BLOCK = 19780000;
const END_BLOCK = 20650000;

async function targetedIndex() {
  logger.info(`Starting targeted index from block ${START_BLOCK} to ${END_BLOCK}`);
  logger.info(`This covers approximately May 1 - Sept 1, 2024`);
  
  try {
    // Clear existing data
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
    
    // Set cursor to start block
    await db('cursors').update({ last_safe_block: START_BLOCK });
    
    logger.info('Data cleared. Configuring indexer...');
    
    // Configure indexer for just xETH on Ethereum first
    const indexerConfig = {
      apiKey: process.env.ALCHEMY_API_KEY_1!,
      network: Network.ETH_MAINNET,
      contracts: [
        {
          address: CONTRACTS.xETH.ethereum,
          symbol: 'xETH',
          chainId: 1,
          startBlock: START_BLOCK,
          type: 'vault' as const,
        },
      ],
    };
    
    // Create and start indexer
    const indexer = new AlchemyOptimizedIndexer(indexerConfig);
    
    let lastLogTime = Date.now();
    let eventCount = 0;
    
    indexer.on('started', () => {
      logger.info('Indexer started successfully');
    });
    
    indexer.on('error', (error) => {
      logger.error('Indexer error:', error);
    });
    
    indexer.on('eventProcessed', async ({ eventName: _eventName, contract: _contract, blockNumber }) => {
      eventCount++;
      
      // Log progress every 5 seconds
      if (Date.now() - lastLogTime > 5000) {
        const progress = ((blockNumber - START_BLOCK) / (END_BLOCK - START_BLOCK)) * 100;
        logger.info(`Progress: ${progress.toFixed(2)}% - Block ${blockNumber} - ${eventCount} events processed`);
        
        // Check for your specific wallet
        const userEvents = await db('share_events')
          .where('address', '0x34e56783c97e0baf0ea52b73ac32d7f5ac815a4c')
          .select('*');
        
        if (userEvents.length > 0) {
          logger.info(`Found ${userEvents.length} events for user wallet 0x34E56783...`);
        }
        
        lastLogTime = Date.now();
      }
    });
    
    // Start indexing
    await indexer.start();
    
    // Let it run for the targeted range
    logger.info('Indexer running for targeted range...');
    
    // Check every 10 seconds if we've reached the end block
    const checkInterval = setInterval(async () => {
      const cursor = await db('cursors').select('last_safe_block').first();
      if (cursor && cursor.last_safe_block >= END_BLOCK) {
        logger.info(`Reached end block ${END_BLOCK}. Stopping indexer...`);
        clearInterval(checkInterval);
        await indexer.stop();
        
        // Show summary
        const stats = await db('share_events')
          .select(
            db.raw('COUNT(*) as total_events'),
            db.raw('COUNT(DISTINCT address) as unique_addresses')
          )
          .first();
        
        logger.info('Indexing complete!');
        logger.info(`Total events: ${stats.total_events}`);
        logger.info(`Unique addresses: ${stats.unique_addresses}`);
        
        // Check user's wallet specifically
        const userEvents = await db('share_events')
          .where('address', '0x34e56783c97e0baf0ea52b73ac32d7f5ac815a4c')
          .orderBy('block', 'asc');
        
        logger.info(`\nUser wallet 0x34E56783... events:`);
        for (const event of userEvents) {
          logger.info(`  ${event.event_type}: ${event.shares_delta} at block ${event.block}`);
        }
        
        await db.destroy();
        process.exit(0);
      }
    }, 10000);
    
    // Handle shutdown
    process.on('SIGINT', async () => {
      logger.info('Shutting down...');
      clearInterval(checkInterval);
      await indexer.stop();
      await db.destroy();
      process.exit(0);
    });
    
  } catch (error) {
    logger.error('Targeted index failed:', error);
    await db.destroy();
    process.exit(1);
  }
}

// Run the targeted index
targetedIndex()
  .then(() => {
    logger.info('Targeted index started successfully');
  })
  .catch((error) => {
    logger.error('Fatal error:', error);
    process.exit(1);
  });