import { createPublicClient, http, Address, parseAbiItem, Log } from 'viem';
import { mainnet } from 'viem/chains';
import { getDb } from '../db/connection';
import { config } from '../config';
import { createLogger } from '../utils/logger';

const logger = createLogger('StreamVaultIndexer');

// Contract addresses from environment (fail if not provided)
const TOKENS = [
  { 
    symbol: 'xETH', 
    ethereum: process.env.XETH_VAULT_ETH!, 
    sonic: process.env.XETH_VAULT_SONIC!
  },
  { 
    symbol: 'xBTC', 
    ethereum: process.env.XBTC_VAULT_ETH!, 
    sonic: process.env.XBTC_VAULT_SONIC!
  },
  { 
    symbol: 'xUSD', 
    ethereum: process.env.XUSD_VAULT_ETH!, 
    sonic: process.env.XUSD_VAULT_SONIC!
  },
  { 
    symbol: 'xEUR', 
    ethereum: process.env.XEUR_VAULT_ETH!, 
    sonic: process.env.XEUR_VAULT_SONIC!
  },
];

// StreamVault Events (from contract)
const EVENTS = {
  Stake: parseAbiItem('event Stake(address indexed account, uint256 amount, uint256 round)'),
  Unstake: parseAbiItem('event Unstake(address indexed account, uint256 amount, uint256 round)'),
  Redeem: parseAbiItem('event Redeem(address indexed account, uint256 share, uint256 round)'),
  InstantUnstake: parseAbiItem('event InstantUnstake(address indexed account, uint256 amount, uint256 round)'),
  RoundRolled: parseAbiItem('event RoundRolled(uint256 round, uint256 pricePerShare, uint256 sharesMinted, uint256 wrappedTokensMinted, uint256 wrappedTokensBurned, uint256 yield, bool isYieldPositive)'),
  Transfer: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'),
};

// Contract addresses to exclude from droplet calculations
const EXCLUDED_ADDRESSES = new Set([
  // Add vault contracts themselves
  ...TOKENS.map(t => t.ethereum.toLowerCase()),
  ...TOKENS.map(t => t.sonic.toLowerCase()),
  // Add zero address
  '0x0000000000000000000000000000000000000000',
  // Add common protocol addresses (expand as needed)
  '0x000000000000000000000000000000000000dead', // burn address
]);

// Helper to check if address should be excluded
function isExcludedAddress(address: string): boolean {
  return EXCLUDED_ADDRESSES.has(address.toLowerCase());
}

class StreamVaultIndexer {
  private db = getDb();
  private ethClient: any;
  private sonicClient: any;
  private lastEthBlock: bigint = 0n;
  private lastSonicBlock: bigint = 0n;
  private isRunning = false;

  constructor() {
    // Validate required environment variables
    for (const token of TOKENS) {
      if (!token.ethereum || !token.sonic) {
        throw new Error(`Missing contract addresses for ${token.symbol}`);
      }
    }
    
    logger.info('StreamVault contract addresses:');
    TOKENS.forEach(token => {
      logger.info(`  ${token.symbol}: ETH=${token.ethereum}, Sonic=${token.sonic}`);
    });
    
    const apiKey = config.rpc.apiKeys?.[0];
    if (!apiKey) {
      throw new Error('No Alchemy API key configured. Please set ALCHEMY_API_KEY_1');
    }
    
    const ethRpcUrl = `https://eth-mainnet.g.alchemy.com/v2/${apiKey}`;
    logger.info(`Using Ethereum RPC: Alchemy`);
    
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
      const lastEth = await this.db('cursors')
        .where('chain_id', 1)
        .first();
      
      const lastSonic = await this.db('cursors')
        .where('chain_id', 146)
        .first();
      
      this.lastEthBlock = BigInt(lastEth?.last_block || 0);
      this.lastSonicBlock = BigInt(lastSonic?.last_block || 0);
      
      logger.info(`Database last blocks - Ethereum: ${this.lastEthBlock}, Sonic: ${this.lastSonicBlock}`);
      
      // If no data, start from deployment blocks (you should set these based on actual deployment)
      if (this.lastEthBlock === 0n) {
        // TODO: Set to actual deployment block
        const currentBlock = await this.ethClient.getBlockNumber();
        this.lastEthBlock = currentBlock - 1000n; // Start from 1000 blocks ago for testing
        logger.info(`No Ethereum history, starting from block ${this.lastEthBlock}`);
      }
      if (this.lastSonicBlock === 0n) {
        const currentBlock = await this.sonicClient.getBlockNumber();
        this.lastSonicBlock = currentBlock - 1000n;
        logger.info(`No Sonic history, starting from block ${this.lastSonicBlock}`);
      }
      
      logger.info(`Starting from Ethereum block: ${this.lastEthBlock}`);
      logger.info(`Starting from Sonic block: ${this.lastSonicBlock}`);
    } catch (error: any) {
      logger.error('Error initializing indexer:', error);
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
      const maxBatchSize = 100n; // Conservative batch size
      const toBlock = fromBlock + maxBatchSize > currentBlock ? currentBlock : fromBlock + maxBatchSize;
      
      logger.info(`Processing Ethereum blocks ${fromBlock} to ${toBlock}`);
      
      for (const token of TOKENS) {
        try {
          // Check if contract exists
          const code = await this.ethClient.getBytecode({ 
            address: token.ethereum as `0x${string}` 
          });
          
          if (!code || code === '0x') {
            logger.warn(`Contract ${token.symbol} not found at ${token.ethereum} on Ethereum`);
            continue;
          }
          
          // Get all StreamVault events
          const [stakes, unstakes, redeems, instantUnstakes, roundRolls, transfers] = await Promise.all([
            this.ethClient.getLogs({
              address: token.ethereum as Address,
              event: EVENTS.Stake,
              fromBlock,
              toBlock,
            }),
            this.ethClient.getLogs({
              address: token.ethereum as Address,
              event: EVENTS.Unstake,
              fromBlock,
              toBlock,
            }),
            this.ethClient.getLogs({
              address: token.ethereum as Address,
              event: EVENTS.Redeem,
              fromBlock,
              toBlock,
            }),
            this.ethClient.getLogs({
              address: token.ethereum as Address,
              event: EVENTS.InstantUnstake,
              fromBlock,
              toBlock,
            }),
            this.ethClient.getLogs({
              address: token.ethereum as Address,
              event: EVENTS.RoundRolled,
              fromBlock,
              toBlock,
            }),
            this.ethClient.getLogs({
              address: token.ethereum as Address,
              event: EVENTS.Transfer,
              fromBlock,
              toBlock,
            }),
          ]);
          
          // Process events
          await this.processStakeEvents(stakes, token.symbol, 1);
          await this.processUnstakeEvents(unstakes, token.symbol, 1);
          await this.processRedeemEvents(redeems, token.symbol, 1);
          await this.processInstantUnstakeEvents(instantUnstakes, token.symbol, 1);
          await this.processRoundRollEvents(roundRolls, token.symbol, 1);
          await this.processTransferEvents(transfers, token.symbol, 1);
          
          const totalEvents = stakes.length + unstakes.length + redeems.length + 
                             instantUnstakes.length + roundRolls.length + transfers.length;
          
          if (totalEvents > 0) {
            logger.info(`Processed ${totalEvents} events for ${token.symbol} on Ethereum`);
          }
        } catch (error: any) {
          logger.error(`Error processing ${token.symbol} on Ethereum:`, error);
        }
      }
      
      // Update cursor
      await this.updateCursor(1, Number(toBlock));
      this.lastEthBlock = toBlock;
    } catch (error: any) {
      logger.error('Error processing Ethereum blocks:', error);
    }
  }

  async processSonicBlocks() {
    try {
      const currentBlock = await this.sonicClient.getBlockNumber();
      
      if (currentBlock <= this.lastSonicBlock) {
        return;
      }
      
      const fromBlock = this.lastSonicBlock + 1n;
      const maxBatchSize = 100n;
      const toBlock = fromBlock + maxBatchSize > currentBlock ? currentBlock : fromBlock + maxBatchSize;
      
      logger.info(`Processing Sonic blocks ${fromBlock} to ${toBlock}`);
      
      for (const token of TOKENS) {
        try {
          // Check if contract exists
          const code = await this.sonicClient.getBytecode({ 
            address: token.sonic as `0x${string}` 
          });
          
          if (!code || code === '0x') {
            logger.warn(`Contract ${token.symbol} not found at ${token.sonic} on Sonic`);
            continue;
          }
          
          // Get events (Sonic might not have all events, focus on transfers)
          const transfers = await this.sonicClient.getLogs({
            address: token.sonic as Address,
            event: EVENTS.Transfer,
            fromBlock,
            toBlock,
          });
          
          await this.processTransferEvents(transfers, token.symbol, 146);
          
          if (transfers.length > 0) {
            logger.info(`Processed ${transfers.length} transfers for ${token.symbol} on Sonic`);
          }
        } catch (error: any) {
          logger.error(`Error processing ${token.symbol} on Sonic:`, error);
        }
      }
      
      // Update cursor
      await this.updateCursor(146, Number(toBlock));
      this.lastSonicBlock = toBlock;
    } catch (error: any) {
      logger.error('Error processing Sonic blocks:', error);
    }
  }

  private async processStakeEvents(events: Log[], asset: string, chainId: number) {
    for (const event of events) {
      if (!event.args) continue;
      const { account, amount, round } = event.args as any;
      
      // Skip excluded addresses
      if (isExcludedAddress(account)) continue;
      
      await this.db('share_events').insert({
        chain_id: chainId,
        vault: asset,
        address: account.toLowerCase(),
        event_type: 'stake',
        delta_shares: '0', // Stake doesn't immediately give shares
        pending_amount: amount.toString(),
        round: Number(round),
        block: Number(event.blockNumber),
        ts: new Date(),
        tx_hash: event.transactionHash,
        log_idx: event.logIndex,
      }).onConflict(['tx_hash', 'log_idx']).ignore();
    }
  }

  private async processUnstakeEvents(events: Log[], asset: string, chainId: number) {
    for (const event of events) {
      if (!event.args) continue;
      const { account, amount, round } = event.args as any;
      
      // Skip excluded addresses
      if (isExcludedAddress(account)) continue;
      
      await this.db('share_events').insert({
        chain_id: chainId,
        vault: asset,
        address: account.toLowerCase(),
        event_type: 'unstake',
        delta_shares: `-${amount}`, // Negative for unstake
        round: Number(round),
        block: Number(event.blockNumber),
        ts: new Date(),
        tx_hash: event.transactionHash,
        log_idx: event.logIndex,
      }).onConflict(['tx_hash', 'log_idx']).ignore();
      
      // Mark that user unstaked in this round (for droplet exclusion)
      await this.db('unstake_events').insert({
        address: account.toLowerCase(),
        asset,
        round: Number(round),
        amount: amount.toString(),
        block: Number(event.blockNumber),
      }).onConflict(['address', 'asset', 'round']).ignore();
    }
  }

  private async processRedeemEvents(events: Log[], asset: string, chainId: number) {
    for (const event of events) {
      if (!event.args) continue;
      const { account, share, round } = event.args as any;
      
      // Skip excluded addresses
      if (isExcludedAddress(account)) continue;
      
      await this.db('share_events').insert({
        chain_id: chainId,
        vault: asset,
        address: account.toLowerCase(),
        event_type: 'redeem',
        delta_shares: share.toString(),
        round: Number(round),
        block: Number(event.blockNumber),
        ts: new Date(),
        tx_hash: event.transactionHash,
        log_idx: event.logIndex,
      }).onConflict(['tx_hash', 'log_idx']).ignore();
    }
  }

  private async processInstantUnstakeEvents(events: Log[], asset: string, chainId: number) {
    for (const event of events) {
      if (!event.args) continue;
      const { account, amount, round } = event.args as any;
      
      // Skip excluded addresses
      if (isExcludedAddress(account)) continue;
      
      await this.db('share_events').insert({
        chain_id: chainId,
        vault: asset,
        address: account.toLowerCase(),
        event_type: 'instant_unstake',
        delta_shares: '0',
        pending_amount: `-${amount}`, // Negative for removal
        round: Number(round),
        block: Number(event.blockNumber),
        ts: new Date(),
        tx_hash: event.transactionHash,
        log_idx: event.logIndex,
      }).onConflict(['tx_hash', 'log_idx']).ignore();
    }
  }

  private async processRoundRollEvents(events: Log[], asset: string, chainId: number) {
    for (const event of events) {
      if (!event.args) continue;
      const { round, pricePerShare, sharesMinted, wrappedTokensMinted, wrappedTokensBurned, yield: yieldAmount, isYieldPositive } = event.args as any;
      
      // Store round information
      await this.db('rounds').insert({
        round_id: Number(round),
        asset,
        chain_id: chainId,
        start_block: Number(event.blockNumber),
        start_ts: new Date(),
        pps: pricePerShare.toString(),
        pps_scale: 18,
        shares_minted: sharesMinted.toString(),
        yield: yieldAmount.toString(),
        is_yield_positive: isYieldPositive,
        tx_hash: event.transactionHash,
      }).onConflict(['round_id', 'asset', 'chain_id']).merge({
        pps: pricePerShare.toString(),
        shares_minted: sharesMinted.toString(),
        yield: yieldAmount.toString(),
        is_yield_positive: isYieldPositive,
        tx_hash: event.transactionHash,
      });
      
      // Take balance snapshots at round boundary
      await this.snapshotBalancesAtRound(Number(round), asset, chainId, Number(event.blockNumber));
    }
  }

  private async processTransferEvents(events: Log[], asset: string, chainId: number) {
    for (const event of events) {
      if (!event.args) continue;
      const { from, to, value } = event.args as any;
      
      // Update balances (but don't exclude addresses here - we track all transfers)
      await this.db.transaction(async (trx) => {
        // Update sender
        if (from !== '0x0000000000000000000000000000000000000000') {
          const existing = await trx('current_balances')
            .where({ 
              address: from.toLowerCase(), 
              asset, 
              chain_id: chainId 
            })
            .first();
          
          const newBalance = existing 
            ? BigInt(existing.shares) - BigInt(value)
            : -BigInt(value);
          
          if (newBalance >= 0n) {
            await trx('current_balances')
              .insert({
                address: from.toLowerCase(),
                asset,
                chain_id: chainId,
                shares: newBalance.toString(),
                last_update_block: Number(event.blockNumber),
              })
              .onConflict(['address', 'asset', 'chain_id'])
              .merge({
                shares: newBalance.toString(),
                last_update_block: Number(event.blockNumber),
              });
          }
        }
        
        // Update receiver
        if (to !== '0x0000000000000000000000000000000000000000') {
          const existing = await trx('current_balances')
            .where({ 
              address: to.toLowerCase(), 
              asset, 
              chain_id: chainId 
            })
            .first();
          
          const newBalance = existing 
            ? BigInt(existing.shares) + BigInt(value)
            : BigInt(value);
          
          await trx('current_balances')
            .insert({
              address: to.toLowerCase(),
              asset,
              chain_id: chainId,
              shares: newBalance.toString(),
              last_update_block: Number(event.blockNumber),
            })
            .onConflict(['address', 'asset', 'chain_id'])
            .merge({
              shares: newBalance.toString(),
              last_update_block: Number(event.blockNumber),
            });
        }
      });
      
      // Store transfer event
      await this.db('share_events').insert({
        chain_id: chainId,
        vault: asset,
        address: from.toLowerCase(),
        event_type: 'transfer',
        delta_shares: `-${value}`,
        meta: JSON.stringify({ to: to.toLowerCase() }),
        block: Number(event.blockNumber),
        ts: new Date(),
        tx_hash: event.transactionHash,
        log_idx: event.logIndex,
      }).onConflict(['tx_hash', 'log_idx']).ignore();
    }
  }

  private async snapshotBalancesAtRound(round: number, asset: string, chainId: number, blockNumber: number) {
    // Get all addresses with balances for this asset
    const balances = await this.db('current_balances')
      .where({ asset, chain_id: chainId })
      .where('shares', '>', '0');
    
    for (const balance of balances) {
      // Skip excluded addresses from snapshots
      if (isExcludedAddress(balance.address)) continue;
      
      // Check if user unstaked in this round
      const unstaked = await this.db('unstake_events')
        .where({ 
          address: balance.address, 
          asset, 
          round 
        })
        .first();
      
      await this.db('balance_snapshots').insert({
        address: balance.address,
        asset,
        round_id: round,
        shares_at_start: balance.shares,
        had_unstake_in_round: !!unstaked,
        snapshot_block: blockNumber,
      }).onConflict(['address', 'asset', 'round_id']).merge({
        shares_at_start: balance.shares,
        had_unstake_in_round: !!unstaked,
      });
    }
  }

  private async updateCursor(chainId: number, blockNumber: number) {
    await this.db('cursors')
      .insert({
        chain_id: chainId,
        contract: 'stream_vault',
        last_block: blockNumber,
        last_tx_index: 0,
      })
      .onConflict(['chain_id', 'contract'])
      .merge({
        last_block: blockNumber,
        updated_at: this.db.fn.now(),
      });
  }

  async start() {
    await this.initialize();
    this.isRunning = true;
    
    logger.info('🚀 StreamVault indexer started');
    
    // Main indexing loop
    while (this.isRunning) {
      try {
        // Process both chains in parallel
        await Promise.all([
          this.processEthereumBlocks(),
          this.processSonicBlocks(),
        ]);
        
        // Wait before next poll
        await new Promise(resolve => setTimeout(resolve, config.indexer.pollInterval));
      } catch (error) {
        logger.error('Error in indexing loop:', error);
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
  const indexer = new StreamVaultIndexer();
  
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

export { StreamVaultIndexer };