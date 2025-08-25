/**
 * Production-ready Indexer Service
 * Handles all blockchain indexing operations with proper error handling,
 * monitoring, and recovery mechanisms
 */

import { createPublicClient, http, PublicClient, Address, Log, parseAbiItem } from 'viem';
import { getDb } from '../db/connection';
import { createLogger } from '../utils/logger';
import { ChainConfig, getEarliestDeploymentBlock } from '../config/chains';
import { AssetType } from '../config/constants';
import EventEmitter from 'events';

const logger = createLogger('IndexerService');

// Event ABIs for StreamVault contracts
const EVENTS = {
  Stake: parseAbiItem('event Stake(address indexed account, uint256 amount, uint256 round)'),
  Unstake: parseAbiItem('event Unstake(address indexed account, uint256 amount, uint256 round)'),
  Redeem: parseAbiItem('event Redeem(address indexed account, uint256 share, uint256 round)'),
  InstantUnstake: parseAbiItem('event InstantUnstake(address indexed account, uint256 amount, uint256 round)'),
  RoundRolled: parseAbiItem('event RoundRolled(uint256 round, uint256 pricePerShare, uint256 sharesMinted, uint256 wrappedTokensMinted, uint256 wrappedTokensBurned, uint256 yield, bool isYieldPositive)'),
} as const;

export interface IndexerMetrics {
  blocksProcessed: number;
  eventsProcessed: number;
  lastBlockProcessed: number;
  errors: number;
  startTime: Date;
  chainId: number;
}

export class IndexerService extends EventEmitter {
  private client: PublicClient;
  private db = getDb();
  private config: ChainConfig;
  private isRunning = false;
  private lastProcessedBlock: bigint = 0n;
  private metrics: IndexerMetrics;
  private errorCount = 0;
  private maxConsecutiveErrors = 10;
  private healthCheckInterval?: NodeJS.Timeout;

  constructor(config: ChainConfig) {
    super();
    this.config = config;
    this.metrics = {
      blocksProcessed: 0,
      eventsProcessed: 0,
      lastBlockProcessed: 0,
      errors: 0,
      startTime: new Date(),
      chainId: config.chainId,
    };

    // Initialize client with fallback RPC endpoints
    this.client = this.createClientWithFallback();
    
    logger.info(`IndexerService initialized for ${config.name} (Chain ID: ${config.chainId})`);
  }

  /**
   * Creates a viem client with fallback RPC endpoints
   */
  private createClientWithFallback(): PublicClient {
    const [primaryRpc] = this.config.rpcEndpoints;
    
    return createPublicClient({
      chain: this.config.chain,
      transport: http(primaryRpc, {
        retryCount: this.config.retryConfig.retryCount,
        retryDelay: this.config.retryConfig.retryDelay,
        timeout: 30000,
      }),
    });
  }

  /**
   * Initialize the indexer - load last processed block from DB
   */
  async initialize(): Promise<void> {
    try {
      // Get last processed block from database
      const cursor = await this.db('cursors')
        .where({
          chain_id: this.config.chainId,
          contract: 'stream_vault',
        })
        .first();

      if (cursor) {
        this.lastProcessedBlock = BigInt(cursor.last_block);
        logger.info(`Resuming from block ${this.lastProcessedBlock}`);
      } else {
        // Start from earliest deployment block
        const earliestBlock = getEarliestDeploymentBlock(this.config);
        this.lastProcessedBlock = BigInt(earliestBlock) - 1n;
        logger.info(`Starting fresh from block ${this.lastProcessedBlock + 1n}`);
      }

      // Verify RPC connection
      const currentBlock = await this.client.getBlockNumber();
      logger.info(`Current chain height: ${currentBlock}`);

      // Start health monitoring
      this.startHealthMonitoring();
    } catch (error) {
      logger.error('Failed to initialize indexer:', error);
      throw error;
    }
  }

  /**
   * Start the indexing process
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Indexer already running');
      return;
    }

    await this.initialize();
    this.isRunning = true;
    this.emit('started', { chainId: this.config.chainId });
    
    logger.info(`🚀 Indexer started for ${this.config.name}`);
    
    // Start indexing loop
    this.indexingLoop();
  }

  /**
   * Main indexing loop with error recovery
   */
  private async indexingLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        const processed = await this.processNextBatch();
        
        if (processed > 0) {
          this.errorCount = 0; // Reset error count on success
          this.emit('progress', this.metrics);
        }
        
        // Dynamic delay based on whether we're caught up
        const delay = processed === 0 ? 10000 : 1000;
        await this.sleep(delay);
        
      } catch (error) {
        this.errorCount++;
        this.metrics.errors++;
        
        logger.error(`Indexing error (${this.errorCount}/${this.maxConsecutiveErrors}):`, error);
        this.emit('error', { error, chainId: this.config.chainId });
        
        if (this.errorCount >= this.maxConsecutiveErrors) {
          logger.error('Max consecutive errors reached, stopping indexer');
          await this.stop();
          break;
        }
        
        // Exponential backoff on errors
        const backoffDelay = this.config.retryConfig.retryDelay * 
          Math.pow(this.config.retryConfig.backoffMultiplier, this.errorCount);
        await this.sleep(backoffDelay);
      }
    }
  }

  /**
   * Process the next batch of blocks
   */
  private async processNextBatch(): Promise<number> {
    const currentBlock = await this.client.getBlockNumber();
    
    if (currentBlock <= this.lastProcessedBlock) {
      return 0; // No new blocks
    }

    const fromBlock = this.lastProcessedBlock + 1n;
    const batchSize = BigInt(this.config.batchSize);
    const toBlock = fromBlock + batchSize > currentBlock 
      ? currentBlock 
      : fromBlock + batchSize;

    logger.debug(`Processing blocks ${fromBlock} to ${toBlock}`);

    // Process each vault's events
    let totalEvents = 0;
    for (const [asset, vaultConfig] of Object.entries(this.config.vaults)) {
      // Skip if vault hasn't been deployed yet
      if (Number(fromBlock) < vaultConfig.deploymentBlock) {
        continue;
      }

      const eventsProcessed = await this.processVaultEvents(
        asset as AssetType,
        vaultConfig.address as Address,
        fromBlock,
        toBlock
      );
      totalEvents += eventsProcessed;
    }

    // Update cursor
    await this.updateCursor(Number(toBlock));
    this.lastProcessedBlock = toBlock;
    
    // Update metrics
    this.metrics.blocksProcessed += Number(toBlock - fromBlock + 1n);
    this.metrics.eventsProcessed += totalEvents;
    this.metrics.lastBlockProcessed = Number(toBlock);

    logger.info(
      `Processed blocks ${fromBlock}-${toBlock}: ${totalEvents} events ` +
      `(${this.metrics.blocksProcessed} total blocks, ${this.metrics.eventsProcessed} total events)`
    );

    return Number(toBlock - fromBlock + 1n);
  }

  /**
   * Process events for a specific vault
   */
  private async processVaultEvents(
    asset: AssetType,
    vaultAddress: Address,
    fromBlock: bigint,
    toBlock: bigint
  ): Promise<number> {
    // Fetch all event types in parallel
    const [stakes, unstakes, redeems, instantUnstakes, roundRolls] = await Promise.all([
      this.fetchEvents(vaultAddress, EVENTS.Stake, fromBlock, toBlock),
      this.fetchEvents(vaultAddress, EVENTS.Unstake, fromBlock, toBlock),
      this.fetchEvents(vaultAddress, EVENTS.Redeem, fromBlock, toBlock),
      this.fetchEvents(vaultAddress, EVENTS.InstantUnstake, fromBlock, toBlock),
      this.fetchEvents(vaultAddress, EVENTS.RoundRolled, fromBlock, toBlock),
    ]);

    // Process events in database transaction
    await this.db.transaction(async (trx) => {
      await this.processStakeEvents(trx, stakes, asset);
      await this.processUnstakeEvents(trx, unstakes, asset);
      await this.processRedeemEvents(trx, redeems, asset);
      await this.processInstantUnstakeEvents(trx, instantUnstakes, asset);
      await this.processRoundRollEvents(trx, roundRolls, asset);
    });

    return stakes.length + unstakes.length + redeems.length + 
           instantUnstakes.length + roundRolls.length;
  }

  /**
   * Fetch events with retry logic
   */
  private async fetchEvents(
    address: Address,
    event: any,
    fromBlock: bigint,
    toBlock: bigint
  ): Promise<Log[]> {
    let retries = 0;
    while (retries < this.config.retryConfig.retryCount) {
      try {
        return await this.client.getLogs({
          address,
          event,
          fromBlock,
          toBlock,
        });
      } catch (error: any) {
        retries++;
        if (retries >= this.config.retryConfig.retryCount) {
          throw error;
        }
        
        const delay = this.config.retryConfig.retryDelay * 
          Math.pow(this.config.retryConfig.backoffMultiplier, retries);
        
        logger.warn(`Event fetch failed, retry ${retries}/${this.config.retryConfig.retryCount} in ${delay}ms`);
        await this.sleep(delay);
      }
    }
    return [];
  }

  /**
   * Process stake events
   */
  private async processStakeEvents(trx: any, events: any[], asset: AssetType): Promise<void> {
    for (const event of events) {
      if (!event.args) continue;
      const { account, amount, round } = event.args;
      
      await trx('share_events').insert({
        chain_id: this.config.chainId,
        asset,
        address: account.toLowerCase(),
        event_type: 'stake',
        event_classification: 'share_change',
        shares_delta: amount.toString(),
        round: Number(round),
        block: Number(event.blockNumber),
        timestamp: new Date(),
        tx_hash: event.transactionHash,
        log_index: event.logIndex,
      }).onConflict(['tx_hash', 'log_index']).ignore();
    }
  }

  /**
   * Process unstake events
   */
  private async processUnstakeEvents(trx: any, events: any[], asset: AssetType): Promise<void> {
    for (const event of events) {
      if (!event.args) continue;
      const { account, amount, round } = event.args;
      
      const address = account.toLowerCase();
      
      await trx('share_events').insert({
        chain_id: this.config.chainId,
        asset,
        address,
        event_type: 'unstake',
        event_classification: 'share_change',
        shares_delta: `-${amount}`,
        round: Number(round),
        block: Number(event.blockNumber),
        timestamp: new Date(),
        tx_hash: event.transactionHash,
        log_index: event.logIndex,
      }).onConflict(['tx_hash', 'log_index']).ignore();

      // Track unstake for round exclusion
      await trx('unstake_events').insert({
        address,
        asset,
        round: Number(round),
        amount: amount.toString(),
        block: Number(event.blockNumber),
      }).onConflict(['address', 'asset', 'round']).ignore();
    }
  }

  /**
   * Process redeem events
   */
  private async processRedeemEvents(trx: any, events: any[], asset: AssetType): Promise<void> {
    for (const event of events) {
      if (!event.args) continue;
      const { account, share, round } = event.args;
      
      await trx('share_events').insert({
        chain_id: this.config.chainId,
        asset,
        address: account.toLowerCase(),
        event_type: 'redeem',
        event_classification: 'share_change',
        shares_delta: share.toString(),
        round: Number(round),
        block: Number(event.blockNumber),
        timestamp: new Date(),
        tx_hash: event.transactionHash,
        log_index: event.logIndex,
      }).onConflict(['tx_hash', 'log_index']).ignore();
    }
  }

  /**
   * Process instant unstake events
   */
  private async processInstantUnstakeEvents(trx: any, events: any[], asset: AssetType): Promise<void> {
    for (const event of events) {
      if (!event.args) continue;
      const { account, amount, round } = event.args;
      
      await trx('share_events').insert({
        chain_id: this.config.chainId,
        asset,
        address: account.toLowerCase(),
        event_type: 'instant_unstake',
        event_classification: 'share_change',
        shares_delta: `-${amount}`,
        round: Number(round),
        block: Number(event.blockNumber),
        timestamp: new Date(),
        tx_hash: event.transactionHash,
        log_index: event.logIndex,
      }).onConflict(['tx_hash', 'log_index']).ignore();
    }
  }

  /**
   * Process round roll events
   */
  private async processRoundRollEvents(trx: any, events: any[], asset: AssetType): Promise<void> {
    for (const event of events) {
      if (!event.args) continue;
      const { 
        round, 
        pricePerShare, 
        sharesMinted, 
        yield: yieldAmount, 
        isYieldPositive 
      } = event.args;
      
      await trx('rounds').insert({
        round_id: Number(round),
        asset,
        chain_id: this.config.chainId,
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
      });

      // Trigger balance snapshot for this round
      await this.createBalanceSnapshots(trx, Number(round), asset);
    }
  }

  /**
   * Create balance snapshots for a round
   */
  private async createBalanceSnapshots(trx: any, round: number, asset: AssetType): Promise<void> {
    // Get all addresses with shares for this asset
    const balances = await trx('current_balances')
      .where({ asset, chain_id: this.config.chainId })
      .where('shares', '>', '0');

    for (const balance of balances) {
      // Check if user unstaked in this round
      const unstaked = await trx('unstake_events')
        .where({ 
          address: balance.address, 
          asset, 
          round 
        })
        .first();

      await trx('balance_snapshots').insert({
        address: balance.address,
        asset,
        round_id: round,
        shares_at_start: balance.shares,
        had_unstake_in_round: !!unstaked,
        snapshot_block: 0, // Will be updated later
      }).onConflict(['address', 'asset', 'round_id']).merge({
        shares_at_start: balance.shares,
        had_unstake_in_round: !!unstaked,
      });
    }
  }

  /**
   * Update the cursor to track progress
   */
  private async updateCursor(blockNumber: number): Promise<void> {
    await this.db('cursors')
      .insert({
        chain_id: this.config.chainId,
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

  /**
   * Start health monitoring
   */
  private startHealthMonitoring(): void {
    this.healthCheckInterval = setInterval(() => {
      const uptime = Date.now() - this.metrics.startTime.getTime();
      const blocksPerSecond = this.metrics.blocksProcessed / (uptime / 1000);
      
      logger.debug(`Health: ${this.config.name} - Blocks: ${this.metrics.blocksProcessed}, ` +
                  `Events: ${this.metrics.eventsProcessed}, ` +
                  `BPS: ${blocksPerSecond.toFixed(2)}, ` +
                  `Errors: ${this.metrics.errors}`);
      
      this.emit('health', this.metrics);
    }, 30000); // Every 30 seconds
  }

  /**
   * Stop the indexer gracefully
   */
  async stop(): Promise<void> {
    logger.info(`Stopping indexer for ${this.config.name}...`);
    this.isRunning = false;
    
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    
    this.emit('stopped', { chainId: this.config.chainId });
    logger.info(`Indexer stopped for ${this.config.name}`);
  }

  /**
   * Get current metrics
   */
  getMetrics(): IndexerMetrics {
    return { ...this.metrics };
  }

  /**
   * Helper to sleep for a given duration
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default IndexerService;