import { createPublicClient, http, Address, parseAbiItem } from 'viem';
import { mainnet } from 'viem/chains';
import { getDb } from '../db/connection';
import { config } from '../config';
import { createLogger } from '../utils/logger';

const logger = createLogger('Indexer');
// Deploy timestamp: 2025-08-25 12:06 UTC - Force rebuild with better error logging

// Use environment variables for contract addresses
const TOKENS = [
  { 
    symbol: 'xETH', 
    ethereum: process.env.XETH_VAULT_ETH || '0x7E586fBaF3084C0be7aB5C82C04FfD7592723153', 
    sonic: process.env.XETH_VAULT_SONIC || '0x16af6b1315471Dc306D47e9CcEfEd6e5996285B6' 
  },
  { 
    symbol: 'xBTC', 
    ethereum: process.env.XBTC_VAULT_ETH || '0x12fd502e2052CaFB41eccC5B596023d9978057d6', 
    sonic: process.env.XBTC_VAULT_SONIC || '0xB88fF15ae5f82c791e637b27337909BcF8065270' 
  },
  { 
    symbol: 'xUSD', 
    ethereum: process.env.XUSD_VAULT_ETH || '0xE2Fc85BfB48C4cF147921fBE110cf92Ef9f26F94', 
    sonic: process.env.XUSD_VAULT_SONIC || '0x6202B9f02E30E5e1c62Cc01E4305450E5d83b926' 
  },
  { 
    symbol: 'xEUR', 
    ethereum: process.env.XEUR_VAULT_ETH || '0xc15697f61170Fc3Bb4e99Eb7913b4C7893F64F13', 
    sonic: process.env.XEUR_VAULT_SONIC || '0x931383c1bCA6a41E931f2519BAe8D716857F156c' 
  },
];

class LiveIndexer {
  private db = getDb();
  private ethClient: any;
  private sonicClient: any;
  private lastEthBlock: bigint = 0n;
  private lastSonicBlock: bigint = 0n;
  private isRunning = false;

  constructor() {
    // Log contract addresses being used
    logger.info('Contract addresses configured:');
    TOKENS.forEach(token => {
      logger.info(`  ${token.symbol}: ETH=${token.ethereum}, Sonic=${token.sonic}`);
    });
    
    const apiKey = config.rpc.apiKeys?.[0] || process.env.ALCHEMY_API_KEY_1;
    
    // Use public endpoints if no API key is available
    const ethRpcUrl = apiKey 
      ? `https://eth-mainnet.g.alchemy.com/v2/${apiKey}`
      : 'https://eth.llamarpc.com'; // Public RPC fallback
    
    logger.info(`Using Ethereum RPC: ${ethRpcUrl.includes('alchemy') ? 'Alchemy' : 'Public RPC'}`);
    
    this.ethClient = createPublicClient({
      chain: mainnet,
      transport: http(ethRpcUrl, {
        retryCount: 3,
        retryDelay: 1000,
      }),
    });
    
    // Sonic uses public RPC (Alchemy doesn't support Sonic yet)
    const sonicRpcUrl = 'https://rpc.soniclabs.com';
    logger.info(`Using Sonic RPC: ${sonicRpcUrl}`);
    
    // Define Sonic chain manually
    const sonicChain = {
      id: 146,
      name: 'Sonic',
      network: 'sonic',
      nativeCurrency: {
        decimals: 18,
        name: 'Sonic',
        symbol: 'S',
      },
      rpcUrls: {
        default: { http: [sonicRpcUrl] },
        public: { http: [sonicRpcUrl] },
      },
    };
    
    this.sonicClient = createPublicClient({
      chain: sonicChain as any,
      transport: http(sonicRpcUrl, {
        retryCount: 3,
        retryDelay: 1000,
      }),
    });
  }

  async initialize() {
    try {
      // Get the last indexed block from database
      const lastEth = await this.db('current_balances')
        .where('chain_id', 1)
        .max('last_update_block as max_block')
        .first();
      
      const lastSonic = await this.db('current_balances')
        .where('chain_id', 146)
        .max('last_update_block as max_block')
        .first();
      
      this.lastEthBlock = BigInt(lastEth?.max_block || 0);
      this.lastSonicBlock = BigInt(lastSonic?.max_block || 0);
      
      logger.info(`Database last blocks - Ethereum: ${this.lastEthBlock}, Sonic: ${this.lastSonicBlock}`);
      
      // If no data, start from recent blocks
      if (this.lastEthBlock === 0n) {
        const currentBlock = await this.ethClient.getBlockNumber();
        this.lastEthBlock = currentBlock - 100n;
        logger.info(`No Ethereum history, starting from block ${this.lastEthBlock}`);
      }
      if (this.lastSonicBlock === 0n) {
        const currentBlock = await this.sonicClient.getBlockNumber();
        this.lastSonicBlock = currentBlock - 100n;
        logger.info(`No Sonic history, starting from block ${this.lastSonicBlock}`);
      }
      
      logger.info(`Starting from Ethereum block: ${this.lastEthBlock}`);
      logger.info(`Starting from Sonic block: ${this.lastSonicBlock}`);
    } catch (error: any) {
      logger.error('Error initializing indexer:', {
        error: error?.message || 'Unknown error',
        stack: error?.stack || 'No stack trace'
      });
      throw error;
    }
  }

  async processEthereumBlocks() {
    try {
      const currentBlock = await this.ethClient.getBlockNumber();
      
      if (currentBlock <= this.lastEthBlock) {
        return; // No new blocks
      }
      
      const fromBlock = this.lastEthBlock + 1n;
      // Limit batch size to prevent RPC errors
      const maxBatchSize = 100n;
      const toBlock = fromBlock + maxBatchSize > currentBlock ? currentBlock : fromBlock + maxBatchSize;
      
      logger.info(`Processing Ethereum blocks ${fromBlock} to ${toBlock}`);
      
      for (const token of TOKENS) {
        try {
          // First check if contract exists
          const code = await this.ethClient.getBytecode({ 
            address: token.ethereum as `0x${string}` 
          });
          
          if (!code || code === '0x') {
            logger.warn(`Contract ${token.symbol} not found at ${token.ethereum} on Ethereum, skipping...`);
            continue;
          }
          
          // Get transfer events
          const transfers = await this.ethClient.getLogs({
            address: token.ethereum as Address,
            event: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'),
            fromBlock,
            toBlock,
          });
          
          // Get PPS events
          const ppsEvents = await this.ethClient.getLogs({
            address: token.ethereum as Address,
            event: parseAbiItem('event PricePerShareUpdated(uint256 pricePerShare, uint256 totalUnderlying, uint256 totalSupply)'),
            fromBlock,
            toBlock,
          });
          
          // Process transfers with validation
          for (const transfer of transfers) {
            // Validate event data exists
            if (!transfer.args || !transfer.args.from || !transfer.args.to || transfer.args.value === undefined) {
              logger.warn(`Invalid transfer event for ${token.symbol}:`, { 
                blockNumber: transfer.blockNumber,
                transactionHash: transfer.transactionHash
              });
              continue;
            }
            
            // Retry logic for individual transfers
            let retryCount = 0;
            const maxRetries = 3;
            while (retryCount < maxRetries) {
              try {
                await this.processTransfer(
                  transfer.args.from,
                  transfer.args.to,
                  transfer.args.value,
                  token.symbol,
                  1,
                  Number(transfer.blockNumber),
                  transfer.transactionHash
                );
                break; // Success, exit retry loop
              } catch (err: any) {
                retryCount++;
                if (retryCount >= maxRetries) {
                  logger.error(`Failed to process transfer after ${maxRetries} retries:`, {
                    token: token.symbol,
                    from: transfer.args.from,
                    to: transfer.args.to,
                    value: transfer.args.value.toString(),
                    error: err.message
                  });
                } else {
                  await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
                }
              }
            }
          }
          
          // Process PPS updates as rounds with proper idempotency
          for (const pps of ppsEvents) {
            // Validate PPS event data
            if (!pps.args || !pps.args.pricePerShare) {
              logger.warn(`Invalid PPS event for ${token.symbol}:`, {
                blockNumber: pps.blockNumber,
                transactionHash: pps.transactionHash
              });
              continue;
            }
            
            // Use block number + asset as unique identifier for idempotency
            const roundId = `${pps.blockNumber}_${token.symbol}_${1}`;
            
            try {
              await this.db('rounds').insert({
                round_id: roundId,
                asset: token.symbol,
                chain_id: 1,
                start_block: Number(pps.blockNumber),
                start_ts: new Date(),
                pps: pps.args.pricePerShare.toString(),
                pps_scale: 18,
                tx_hash: pps.transactionHash,
              }).onConflict(['round_id', 'asset', 'chain_id']).ignore(); // Ignore duplicates
            } catch (err: any) {
              logger.error(`Failed to insert round for ${token.symbol}:`, {
                roundId,
                error: err.message
              });
            }
          }
          
          if (transfers.length > 0 || ppsEvents.length > 0) {
            logger.info(`Processed ${transfers.length} transfers and ${ppsEvents.length} PPS updates for ${token.symbol} on Ethereum`);
          }
        } catch (error: any) {
          logger.error(`Error processing ${token.symbol} on Ethereum:`, {
            error: error?.message || 'Unknown error',
            stack: error?.stack || 'No stack trace',
            token: token.symbol,
            address: token.ethereum,
            fromBlock: fromBlock.toString(),
            toBlock: toBlock.toString(),
            fullError: JSON.stringify(error)
          });
        }
      }
      
      // Only update if we successfully processed all tokens
      this.lastEthBlock = toBlock;
    } catch (error: any) {
      logger.error('Error processing Ethereum blocks:', {
        error: error?.message || 'Unknown error',
        stack: error?.stack || 'No stack trace',
        fullError: JSON.stringify(error)
      });
    }
  }

  async processSonicBlocks() {
    try {
      const currentBlock = await this.sonicClient.getBlockNumber();
      
      if (currentBlock <= this.lastSonicBlock) {
        return; // No new blocks
      }
      
      const fromBlock = this.lastSonicBlock + 1n;
      // Limit batch size to prevent RPC errors
      const maxBatchSize = 100n;
      const toBlock = fromBlock + maxBatchSize > currentBlock ? currentBlock : fromBlock + maxBatchSize;
      
      logger.info(`Processing Sonic blocks ${fromBlock} to ${toBlock}`);
      
      for (const token of TOKENS) {
        try {
          // First check if contract exists
          const code = await this.sonicClient.getBytecode({ 
            address: token.sonic as `0x${string}` 
          });
          
          if (!code || code === '0x') {
            logger.warn(`Contract ${token.symbol} not found at ${token.sonic} on Sonic, skipping...`);
            continue;
          }
          
          // Get transfer events
          const transfers = await this.sonicClient.getLogs({
            address: token.sonic as Address,
            event: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'),
            fromBlock,
            toBlock,
          });
          
          // Process transfers with validation
          for (const transfer of transfers) {
            // Validate event data exists
            if (!transfer.args || !transfer.args.from || !transfer.args.to || transfer.args.value === undefined) {
              logger.warn(`Invalid transfer event for ${token.symbol} on Sonic:`, { 
                blockNumber: transfer.blockNumber,
                transactionHash: transfer.transactionHash
              });
              continue;
            }
            
            // Retry logic for individual transfers
            let retryCount = 0;
            const maxRetries = 3;
            while (retryCount < maxRetries) {
              try {
                await this.processTransfer(
                  transfer.args.from,
                  transfer.args.to,
                  transfer.args.value,
                  token.symbol,
                  146,
                  Number(transfer.blockNumber),
                  transfer.transactionHash
                );
                break; // Success, exit retry loop
              } catch (err: any) {
                retryCount++;
                if (retryCount >= maxRetries) {
                  logger.error(`Failed to process Sonic transfer after ${maxRetries} retries:`, {
                    token: token.symbol,
                    from: transfer.args.from,
                    to: transfer.args.to,
                    value: transfer.args.value.toString(),
                    error: err.message
                  });
                } else {
                  await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
                }
              }
            }
          }
          
          if (transfers.length > 0) {
            logger.info(`Processed ${transfers.length} transfers for ${token.symbol} on Sonic`);
          }
        } catch (error: any) {
          logger.error(`Error processing ${token.symbol} on Sonic:`, {
            error: error?.message || 'Unknown error',
            stack: error?.stack || 'No stack trace',
            token: token.symbol,
            address: token.sonic,
            fromBlock: fromBlock.toString(),
            toBlock: toBlock.toString(),
            fullError: JSON.stringify(error)
          });
        }
      }
      
      // Only update if we successfully processed all tokens
      this.lastSonicBlock = toBlock;
    } catch (error: any) {
      logger.error('Error processing Sonic blocks:', {
        error: error?.message || 'Unknown error',
        stack: error?.stack || 'No stack trace',
        fullError: JSON.stringify(error)
      });
    }
  }

  async processTransfer(
    from: string,
    to: string,
    value: bigint,
    token: string,
    chainId: number,
    blockNumber: number,
    txHash?: string
  ) {
    logger.debug(`Processing transfer: ${token} on chain ${chainId}, from ${from} to ${to}, value: ${value.toString()}, block: ${blockNumber}`);
    
    // Use database transaction for atomicity
    await this.db.transaction(async (trx) => {
      // Update sender balance
      if (from !== '0x0000000000000000000000000000000000000000') {
        const existing = await trx('current_balances')
          .where({ 
            address: from.toLowerCase(), 
            asset: token, 
            chain_id: chainId 
          })
          .first();
      
      const newBalance = existing 
        ? BigInt(existing.shares) - value
        : -value;
      
        if (newBalance >= 0n) {
          await trx('current_balances')
            .insert({
              address: from.toLowerCase(),
              asset: token,
              chain_id: chainId,
              shares: newBalance.toString(),
              last_update_block: blockNumber,
            })
            .onConflict(['address', 'asset', 'chain_id'])
            .merge({
              shares: newBalance.toString(),
              last_update_block: blockNumber,
              updated_at: trx.fn.now(),
            });
          logger.debug(`Updated balance for sender ${from}: ${newBalance.toString()} ${token}`);
        } else {
          // Log negative balance warning - this shouldn't happen
          logger.warn(`Negative balance detected for ${from} in ${token}:`, {
            balance: newBalance.toString(),
            blockNumber,
            chainId,
            txHash
          });
        }
      }
    
      // Update receiver balance
      if (to !== '0x0000000000000000000000000000000000000000') {
        const existing = await trx('current_balances')
          .where({ 
            address: to.toLowerCase(), 
            asset: token, 
            chain_id: chainId 
          })
          .first();
      
      const newBalance = existing 
        ? BigInt(existing.shares) + value
        : value;
      
        await trx('current_balances')
          .insert({
            address: to.toLowerCase(),
            asset: token,
            chain_id: chainId,
            shares: newBalance.toString(),
            last_update_block: blockNumber,
          })
          .onConflict(['address', 'asset', 'chain_id'])
          .merge({
            shares: newBalance.toString(),
            last_update_block: blockNumber,
            updated_at: trx.fn.now(),
          });
        logger.debug(`Updated balance for receiver ${to}: ${newBalance.toString()} ${token}`);
      }
    });
  }

  async start() {
    await this.initialize();
    this.isRunning = true;
    
    logger.info('🚀 Live indexer started');
    
    // Main indexing loop
    while (this.isRunning) {
      try {
        // Process both chains in parallel
        await Promise.all([
          this.processEthereumBlocks(),
          this.processSonicBlocks(),
        ]);
        
        // Wait before next poll (10 seconds for Ethereum, ~1 block)
        await new Promise(resolve => setTimeout(resolve, 10000));
      } catch (error) {
        logger.error('Error in indexing loop:', error);
        // Wait a bit longer on error
        await new Promise(resolve => setTimeout(resolve, 30000));
      }
    }
  }

  stop() {
    logger.info('Stopping indexer...');
    this.isRunning = false;
  }
}

// Start the indexer if run directly
if (require.main === module) {
  const indexer = new LiveIndexer();
  
  // Handle graceful shutdown
  process.on('SIGTERM', () => {
    indexer.stop();
    process.exit(0);
  });
  
  process.on('SIGINT', () => {
    indexer.stop();
    process.exit(0);
  });
  
  indexer.start().catch(error => {
    logger.error('Indexer failed:', error);
    process.exit(1);
  });
}

export { LiveIndexer };