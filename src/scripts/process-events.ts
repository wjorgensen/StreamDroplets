/**
 * Process Events Script
 * Processes the event logs to extract stake/unstake/redeem data
 */

import { Alchemy, Network } from 'alchemy-sdk';
import { decodeEventLog } from 'viem';
import { getDb } from '../db/connection';
import { createLogger } from '../utils/logger';
import { STREAM_VAULT_ABI } from '../config/contracts';
import dotenv from 'dotenv';

dotenv.config();

const logger = createLogger('ProcessEvents');
const db = getDb();

const XETH_CONTRACT = '0x7E586fBaF3084C0be7aB5C82C04FfD7592723153';
const USER_WALLET = '0x34e56783c97e0baf0ea52b73ac32d7f5ac815a4c';

async function processEvents() {
  logger.info('Processing xETH event logs');
  
  try {
    // Initialize Alchemy
    const alchemy = new Alchemy({
      apiKey: process.env.ALCHEMY_API_KEY_1!,
      network: Network.ETH_MAINNET,
    });
    
    // Clear existing event data
    await db('share_events').delete();
    await db('stakes').delete();
    await db('unstakes').delete();
    
    logger.info('Fetching xETH event logs...');
    
    // Fetch all logs for the contract
    const logs = await alchemy.core.getLogs({
      address: XETH_CONTRACT,
      fromBlock: 0,
      toBlock: 'latest',
    });
    
    logger.info(`Processing ${logs.length} event logs`);
    
    let userEvents = [];
    let processedCount = 0;
    
    for (const log of logs) {
      try {
        // Try to decode the log
        let decoded: any = null;
        let eventName = '';
        
        // Try each event type
        const eventSignatures = {
          'Stake': 'event Stake(address indexed account, uint256 amount, uint256 round)',
          'Unstake': 'event Unstake(address indexed account, uint256 amount, uint256 round)',
          'Redeem': 'event Redeem(address indexed account, uint256 share, uint256 round)',
          'InstantUnstake': 'event InstantUnstake(address indexed account, uint256 amount, uint256 round)',
        };
        
        for (const [name, signature] of Object.entries(eventSignatures)) {
          try {
            decoded = decodeEventLog({
              abi: STREAM_VAULT_ABI,
              data: log.data,
              topics: log.topics as any,
            });
            
            if (decoded.eventName === name) {
              eventName = name;
              break;
            }
          } catch {
            // Not this event type
          }
        }
        
        if (decoded && eventName) {
          processedCount++;
          
          const account = decoded.args.account?.toLowerCase();
          // blockNumber might be hex string or already decimal
          const blockNumber = typeof log.blockNumber === 'string' && log.blockNumber.startsWith('0x') 
            ? parseInt(log.blockNumber, 16) 
            : Number(log.blockNumber);
          
          // Check if this is our user's event
          if (account === USER_WALLET) {
            userEvents.push({
              event: eventName,
              account,
              amount: decoded.args.amount?.toString() || decoded.args.share?.toString(),
              round: Number(decoded.args.round),
              block: blockNumber,
              txHash: log.transactionHash,
            });
          }
          
          // Store in database based on event type
          if (eventName === 'Stake') {
            await db('stakes').insert({
              chain_id: 1,
              contract_address: XETH_CONTRACT.toLowerCase(),
              account,
              amount: decoded.args.amount.toString(),
              round: Number(decoded.args.round),
              block_number: blockNumber,
              transaction_hash: log.transactionHash,
              timestamp: new Date(),
            }).onConflict(['chain_id', 'transaction_hash', 'account']).ignore();
            
            await db('share_events').insert({
              chain_id: 1,
              asset: 'xETH',
              address: account,
              event_type: 'stake',
              shares_delta: decoded.args.amount.toString(),
              block: blockNumber,
              timestamp: new Date(),
              tx_hash: log.transactionHash,
              log_index: log.logIndex,
              round_id: Number(decoded.args.round),
            }).onConflict(['chain_id', 'tx_hash', 'log_index']).ignore();
            
          } else if (eventName === 'Unstake' || eventName === 'InstantUnstake') {
            await db('unstakes').insert({
              chain_id: 1,
              contract_address: XETH_CONTRACT.toLowerCase(),
              account,
              amount: decoded.args.amount.toString(),
              round: Number(decoded.args.round),
              block_number: blockNumber,
              transaction_hash: log.transactionHash,
              timestamp: new Date(),
            }).onConflict(['chain_id', 'transaction_hash', 'account']).ignore();
            
            await db('share_events').insert({
              chain_id: 1,
              asset: 'xETH',
              address: account,
              event_type: eventName.toLowerCase(),
              shares_delta: `-${decoded.args.amount.toString()}`,
              block: blockNumber,
              timestamp: new Date(),
              tx_hash: log.transactionHash,
              log_index: log.logIndex,
              round_id: Number(decoded.args.round),
            }).onConflict(['chain_id', 'tx_hash', 'log_index']).ignore();
            
          } else if (eventName === 'Redeem') {
            await db('share_events').insert({
              chain_id: 1,
              asset: 'xETH',
              address: account,
              event_type: 'redeem',
              shares_delta: `-${decoded.args.share.toString()}`,
              block: blockNumber,
              timestamp: new Date(),
              tx_hash: log.transactionHash,
              log_index: log.logIndex,
              round_id: Number(decoded.args.round),
            }).onConflict(['chain_id', 'tx_hash', 'log_index']).ignore();
          }
        }
      } catch (error) {
        // Skip logs we can't decode
      }
    }
    
    logger.info(`Processed ${processedCount} events`);
    
    // Show user's events
    logger.info(`\n=== User wallet ${USER_WALLET} events ===`);
    for (const event of userEvents) {
      logger.info(`Block ${event.block}: ${event.event}`);
      logger.info(`  Amount: ${event.amount} (${BigInt(event.amount) / 10n**18n} ETH)`);
      logger.info(`  Round: ${event.round}`);
      logger.info(`  TxHash: ${event.txHash}`);
    }
    
    // Calculate final balance
    const allUserEvents = await db('share_events')
      .where('address', USER_WALLET)
      .orderBy('block', 'asc');
    
    let balance = 0n;
    logger.info('\n=== Balance calculation ===');
    for (const event of allUserEvents) {
      const delta = BigInt(event.shares_delta);
      balance += delta;
      logger.info(`${event.event_type}: ${delta > 0 ? '+' : ''}${delta / 10n**18n} ETH, Balance: ${balance / 10n**18n} ETH`);
    }
    
    logger.info(`\nFinal balance: ${balance / 10n**18n} ETH (${balance} wei)`);
    
    await db.destroy();
    
  } catch (error) {
    logger.error('Event processing failed:', error);
    await db.destroy();
    process.exit(1);
  }
}

// Run the event processor
processEvents()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    logger.error('Fatal error:', error);
    process.exit(1);
  });