#!/usr/bin/env tsx

import { EventIndexer } from '../src/indexer/EventIndexer';
import { AccrualEngine } from '../src/accrual/AccrualEngine';
import { ChainlinkService } from '../src/oracle/ChainlinkService';
import { getDb, closeDb } from '../src/db/connection';
import { createLogger } from '../src/utils/logger';
import { CONTRACTS } from '../src/config/contracts';
import { CONSTANTS, AssetType } from '../src/config/constants';

const logger = createLogger('Backfill');

interface BackfillOptions {
  asset?: AssetType;
  fromBlock?: number;
  toBlock?: number;
  chainId?: number;
  recalculate?: boolean;
}

async function backfill(options: BackfillOptions = {}) {
  const db = getDb();
  
  try {
    logger.info('Starting backfill with options:', options);
    
    // If specific asset is provided, backfill only that
    const assets: AssetType[] = options.asset ? [options.asset] : ['xETH', 'xBTC', 'xUSD', 'xEUR'];
    
    for (const asset of assets) {
      logger.info(`Backfilling ${asset}`);
      
      // Set cursors to start block if provided
      if (options.fromBlock) {
        const contracts = CONTRACTS[asset];
        
        if (options.chainId === CONSTANTS.CHAIN_IDS.ETHEREUM || !options.chainId) {
          await db('cursors')
            .insert({
              chain_id: CONSTANTS.CHAIN_IDS.ETHEREUM,
              contract_address: contracts.ethereum,
              last_safe_block: options.fromBlock - 1,
            })
            .onConflict(['chain_id', 'contract_address'])
            .merge(['last_safe_block']);
        }
        
        if (options.chainId === CONSTANTS.CHAIN_IDS.SONIC || !options.chainId) {
          await db('cursors')
            .insert({
              chain_id: CONSTANTS.CHAIN_IDS.SONIC,
              contract_address: contracts.sonic,
              last_safe_block: options.fromBlock - 1,
            })
            .onConflict(['chain_id', 'contract_address'])
            .merge(['last_safe_block']);
        }
      }
    }
    
    // Start indexer for backfill
    const indexer = new EventIndexer();
    await indexer.start();
    
    // Wait for indexing to catch up
    // In production, this would monitor progress
    logger.info('Indexing in progress...');
    
    // If recalculate flag is set, recalculate all droplets
    if (options.recalculate) {
      logger.info('Recalculating all droplets...');
      const accrualEngine = new AccrualEngine();
      await accrualEngine.recalculateAll();
      logger.info('Recalculation complete');
    }
    
    logger.info('Backfill complete');
    
  } catch (error) {
    logger.error('Backfill failed:', error);
    process.exit(1);
  } finally {
    await closeDb();
  }
}

// Parse command line arguments
const args = process.argv.slice(2);
const options: BackfillOptions = {};

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '--asset':
      options.asset = args[++i] as AssetType;
      break;
    case '--from':
      options.fromBlock = parseInt(args[++i]);
      break;
    case '--to':
      options.toBlock = parseInt(args[++i]);
      break;
    case '--chain':
      options.chainId = parseInt(args[++i]);
      break;
    case '--recalculate':
      options.recalculate = true;
      break;
    case '--help':
      console.log(`
Usage: npm run backfill [options]

Options:
  --asset <xETH|xBTC|xUSD|xEUR>  Specific asset to backfill
  --from <block>             Starting block number
  --to <block>               Ending block number  
  --chain <1|146>            Specific chain ID (1=Ethereum, 146=Sonic)
  --recalculate              Recalculate all droplets after backfill
  --help                     Show this help message
      `);
      process.exit(0);
  }
}

// Run backfill
backfill(options);