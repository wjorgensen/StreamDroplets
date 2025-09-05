/**
 * Quick Index Script
 * Directly fetches all transactions for xETH contract
 */

import { Alchemy, Network } from 'alchemy-sdk';
import { getDb } from '../db/connection';
import { createLogger } from '../utils/logger';
import dotenv from 'dotenv';

dotenv.config();

const logger = createLogger('QuickIndex');
const db = getDb();

const XETH_CONTRACT = '0x7E586fBaF3084C0be7aB5C82C04FfD7592723153';

async function quickIndex() {
  logger.info('Starting quick index of xETH contract');
  
  try {
    // Initialize Alchemy
    const alchemy = new Alchemy({
      apiKey: process.env.ALCHEMY_API_KEY_1!,
      network: Network.ETH_MAINNET,
    });
    
    // Clear existing data
    logger.info('Clearing existing data...');
    await db('share_events').delete();
    await db('stakes').delete();
    await db('unstakes').delete();
    await db('events').delete();
    await db('transfers').delete();
    
    logger.info('Fetching all xETH transfers...');
    
    // Get all transfers (no block range, get everything)
    let transferCount = 0;
    let pageKey: string | undefined;
    
    // Fetch all transfers TO xETH contract
    do {
      const result = await alchemy.core.getAssetTransfers({
        toAddress: XETH_CONTRACT,
        category: ['external', 'erc20'],
        withMetadata: true,
        excludeZeroValue: false,
        pageKey,
      });
      
      for (const transfer of result.transfers) {
        await db('transfers').insert({
          chain_id: 1,
          contract_address: XETH_CONTRACT.toLowerCase(),
          transaction_hash: transfer.hash,
          block_number: parseInt(transfer.blockNum, 16),
          from_address: transfer.from.toLowerCase(),
          to_address: transfer.to?.toLowerCase() || null,
          value: transfer.value?.toString() || '0',
          asset: transfer.asset || 'ETH',
          category: transfer.category,
          metadata: JSON.stringify(transfer.metadata),
          created_at: new Date(),
        }).onConflict(['chain_id', 'transaction_hash', 'contract_address']).ignore();
        
        transferCount++;
      }
      
      pageKey = result.pageKey;
      logger.info(`Fetched ${transferCount} transfers TO xETH so far...`);
    } while (pageKey);
    
    // Fetch all transfers FROM xETH contract
    pageKey = undefined;
    do {
      const result = await alchemy.core.getAssetTransfers({
        fromAddress: XETH_CONTRACT,
        category: ['external', 'erc20'],
        withMetadata: true,
        excludeZeroValue: false,
        pageKey,
      });
      
      for (const transfer of result.transfers) {
        await db('transfers').insert({
          chain_id: 1,
          contract_address: XETH_CONTRACT.toLowerCase(),
          transaction_hash: transfer.hash,
          block_number: parseInt(transfer.blockNum, 16),
          from_address: transfer.from.toLowerCase(),
          to_address: transfer.to?.toLowerCase() || null,
          value: transfer.value?.toString() || '0',
          asset: transfer.asset || 'xETH',
          category: transfer.category,
          metadata: JSON.stringify(transfer.metadata),
          created_at: new Date(),
        }).onConflict(['chain_id', 'transaction_hash', 'contract_address']).ignore();
        
        transferCount++;
      }
      
      pageKey = result.pageKey;
      logger.info(`Fetched ${transferCount} total transfers...`);
    } while (pageKey);
    
    logger.info(`Total transfers fetched: ${transferCount}`);
    
    // Now fetch event logs for the contract
    logger.info('Fetching xETH event logs...');
    
    const logs = await alchemy.core.getLogs({
      address: XETH_CONTRACT,
      fromBlock: 0,
      toBlock: 'latest',
    });
    
    logger.info(`Fetched ${logs.length} event logs`);
    
    // Check for user's wallet
    const userTransfers = await db('transfers')
      .where('from_address', '0x34e56783c97e0baf0ea52b73ac32d7f5ac815a4c')
      .orWhere('to_address', '0x34e56783c97e0baf0ea52b73ac32d7f5ac815a4c');
    
    logger.info(`\nFound ${userTransfers.length} transfers for user wallet 0x34E56783...`);
    
    for (const transfer of userTransfers) {
      logger.info(`  Block ${transfer.block_number}: ${transfer.from_address} -> ${transfer.to_address}, value: ${transfer.value}`);
    }
    
    await db.destroy();
    logger.info('Quick index complete!');
    
  } catch (error) {
    logger.error('Quick index failed:', error);
    await db.destroy();
    process.exit(1);
  }
}

// Run the quick index
quickIndex()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    logger.error('Fatal error:', error);
    process.exit(1);
  });