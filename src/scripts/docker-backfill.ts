import { getDb } from '../db/connection';
import { createLogger } from '../utils/logger';
import { createPublicClient, http, parseAbi, decodeEventLog } from 'viem';
import { mainnet } from 'viem/chains';
import * as dotenv from 'dotenv';

dotenv.config();

const logger = createLogger('DockerBackfill');

// Event ABIs
const STAKE_EVENT = {
  name: 'Stake',
  type: 'event',
  inputs: [
    { indexed: true, name: 'from', type: 'address' },
    { indexed: false, name: 'to', type: 'address' },
    { indexed: false, name: 'shares', type: 'uint256' },
    { indexed: false, name: 'stakeTime', type: 'uint256' },
  ],
} as const;

const UNSTAKE_EVENT = {
  name: 'Unstake',
  type: 'event',
  inputs: [
    { indexed: true, name: 'from', type: 'address' },
    { indexed: false, name: 'to', type: 'address' },
    { indexed: false, name: 'shares', type: 'uint256' },
  ],
} as const;

const TRANSFER_EVENT = {
  name: 'Transfer',
  type: 'event',
  inputs: [
    { indexed: true, name: 'from', type: 'address' },
    { indexed: true, name: 'to', type: 'address' },
    { indexed: false, name: 'value', type: 'uint256' },
  ],
} as const;

async function runBackfill() {
  const db = await getDb();
  
  try {
    logger.info('Starting Docker container backfill...');
    
    // Create Ethereum client
    const client = createPublicClient({
      chain: mainnet,
      transport: http(`${process.env.ALCHEMY_ETH_BASE_URL}${process.env.ALCHEMY_API_KEY_1}`),
    });
    
    // Vault configurations
    const vaults = [
      { address: process.env.XETH_VAULT_ETH!, symbol: 'xETH', startBlock: 21872213n },
      { address: process.env.XBTC_VAULT_ETH!, symbol: 'xBTC', startBlock: 21872213n },
      { address: process.env.XUSD_VAULT_ETH!, symbol: 'xUSD', startBlock: 21872213n },
      { address: process.env.XEUR_VAULT_ETH!, symbol: 'xEUR', startBlock: 21872213n },
    ];
    
    // Get current block
    const currentBlock = await client.getBlockNumber();
    logger.info(`Current block: ${currentBlock}`);
    
    // Process each vault
    for (const vault of vaults) {
      logger.info(`Processing ${vault.symbol} vault at ${vault.address}`);
      
      // Fetch events in chunks
      const chunkSize = 5000n;
      let fromBlock = vault.startBlock;
      
      while (fromBlock < currentBlock) {
        const toBlock = fromBlock + chunkSize > currentBlock ? currentBlock : fromBlock + chunkSize;
        
        try {
          // Get all logs for this vault
          const logs = await client.getLogs({
            address: vault.address as `0x${string}`,
            fromBlock,
            toBlock,
          });
          
          logger.info(`Found ${logs.length} events in blocks ${fromBlock}-${toBlock}`);
          
          // Process each log
          for (const log of logs) {
            const timestamp = new Date();
            let eventData: any = null;
            let eventName = 'Unknown';
            
            // Try to decode as different event types
            try {
              if (log.topics[0] === '0x5af417134f72a9d41143ace85b0a26dce6f550f894f2cbc1eeee8810603d91b6') {
                // Stake event
                eventData = decodeEventLog({
                  abi: [STAKE_EVENT],
                  data: log.data,
                  topics: log.topics,
                });
                eventName = 'Stake';
                
                // Update balance
                await db('chain_share_balances')
                  .insert({
                    address: eventData.args.from.toLowerCase(),
                    chain_id: 1,
                    asset: vault.symbol,
                    shares: eventData.args.shares.toString(),
                    last_block: Number(log.blockNumber),
                    created_at: timestamp,
                    updated_at: timestamp,
                  })
                  .onConflict(['address', 'chain_id', 'asset'])
                  .merge({
                    shares: db.raw('chain_share_balances.shares::numeric + ?', [eventData.args.shares.toString()]),
                    last_block: Number(log.blockNumber),
                    updated_at: timestamp,
                  });
              } else if (log.topics[0] === '0xddd252950000000000000000000000000000000000000000000000000000000') {
                // Unstake event
                eventData = decodeEventLog({
                  abi: [UNSTAKE_EVENT],
                  data: log.data,
                  topics: log.topics,
                });
                eventName = 'Unstake';
                
                // Update balance (subtract)
                await db('chain_share_balances')
                  .insert({
                    address: eventData.args.from.toLowerCase(),
                    chain_id: 1,
                    asset: vault.symbol,
                    shares: '0',
                    last_block: Number(log.blockNumber),
                    created_at: timestamp,
                    updated_at: timestamp,
                  })
                  .onConflict(['address', 'chain_id', 'asset'])
                  .merge({
                    shares: db.raw('GREATEST(0, chain_share_balances.shares::numeric - ?)', [eventData.args.shares.toString()]),
                    last_block: Number(log.blockNumber),
                    updated_at: timestamp,
                  });
              } else if (log.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef') {
                // Transfer event
                eventData = decodeEventLog({
                  abi: [TRANSFER_EVENT],
                  data: log.data,
                  topics: log.topics,
                });
                eventName = 'Transfer';
                
                // Update sender balance (subtract)
                if (eventData.args.from !== '0x0000000000000000000000000000000000000000') {
                  await db('chain_share_balances')
                    .where({
                      address: eventData.args.from.toLowerCase(),
                      chain_id: 1,
                      asset: vault.symbol,
                    })
                    .update({
                      shares: db.raw('GREATEST(0, shares::numeric - ?)', [eventData.args.value.toString()]),
                      last_block: Number(log.blockNumber),
                      updated_at: timestamp,
                    });
                }
                
                // Update receiver balance (add)
                if (eventData.args.to !== '0x0000000000000000000000000000000000000000') {
                  await db('chain_share_balances')
                    .insert({
                      address: eventData.args.to.toLowerCase(),
                      chain_id: 1,
                      asset: vault.symbol,
                      shares: eventData.args.value.toString(),
                      last_block: Number(log.blockNumber),
                      created_at: timestamp,
                      updated_at: timestamp,
                    })
                    .onConflict(['address', 'chain_id', 'asset'])
                    .merge({
                      shares: db.raw('chain_share_balances.shares::numeric + ?', [eventData.args.value.toString()]),
                      last_block: Number(log.blockNumber),
                      updated_at: timestamp,
                    });
                }
              }
            } catch (decodeError) {
              // Skip events we can't decode
              continue;
            }
            
            // Store event
            if (eventData) {
              await db('events')
                .insert({
                  transaction_hash: log.transactionHash,
                  block_number: Number(log.blockNumber),
                  contract_address: vault.address.toLowerCase(),
                  event_name: eventName,
                  event_data: JSON.stringify(eventData.args),
                  created_at: timestamp,
                })
                .onConflict(['transaction_hash', 'block_number', 'contract_address', 'event_name'])
                .ignore();
            }
          }
        } catch (error) {
          logger.error(`Error processing blocks ${fromBlock}-${toBlock}:`, error);
        }
        
        fromBlock = toBlock + 1n;
      }
      
      logger.info(`Completed processing ${vault.symbol}`);
    }
    
    // Add excluded addresses
    logger.info('Adding excluded addresses...');
    const excludedAddresses = [
      // Vault contracts
      process.env.XETH_VAULT_ETH,
      process.env.XBTC_VAULT_ETH,
      process.env.XUSD_VAULT_ETH,
      process.env.XEUR_VAULT_ETH,
    ].filter(Boolean);
    
    for (const address of excludedAddresses) {
      await db('excluded_addresses')
        .insert({
          address: address!.toLowerCase(),
          reason: 'Vault contract',
          created_at: new Date(),
        })
        .onConflict('address')
        .ignore();
    }
    
    logger.info('Backfill completed successfully!');
    
  } catch (error) {
    logger.error('Backfill failed:', error);
    throw error;
  } finally {
    await db.destroy();
  }
}

// Run if called directly
if (require.main === module) {
  runBackfill().catch(error => {
    logger.error('Fatal error:', error);
    process.exit(1);
  });
}

export { runBackfill };