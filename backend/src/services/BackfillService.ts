/**
 * Backfill Service
 * Handles historical data backfilling with progress tracking
 */

import { createPublicClient, http, Address, Log, decodeEventLog, parseAbiItem } from 'viem';
import { getDb } from '../db/connection';
import { createLogger } from '../utils/logger';
import { CHAIN_CONFIGS, ChainConfig, getEarliestDeploymentBlock } from '../config/chains';
import { AssetType } from '../config/constants';
import EventEmitter from 'events';

const logger = createLogger('BackfillService');

// StreamVault Events
const EVENTS = {
  Stake: parseAbiItem('event Stake(address indexed account, uint256 amount, uint256 round)'),
  Unstake: parseAbiItem('event Unstake(address indexed account, uint256 amount, uint256 round)'),
  Redeem: parseAbiItem('event Redeem(address indexed account, uint256 share, uint256 round)'),
  InstantUnstake: parseAbiItem('event InstantUnstake(address indexed account, uint256 amount, uint256 round)'),
  RoundRolled: parseAbiItem('event RoundRolled(uint256 round, uint256 pricePerShare, uint256 sharesMinted, uint256 wrappedTokensMinted, uint256 wrappedTokensBurned, uint256 yield, bool isYieldPositive)'),
};

export interface BackfillOptions {
  chain?: string;
  asset?: AssetType;
  fromBlock?: number;
  toBlock?: number;
  clearData?: boolean;
  batchSize?: number;
}

export interface BackfillProgress {
  blocksProcessed: number;
  eventsProcessed: number;
  currentBlock: number;
  totalBlocks: number;
  percentComplete: number;
}

export interface BackfillSummary {
  blocksProcessed: number;
  eventsProcessed: number;
  roundsFound: number;
  uniqueUsers: number;
  duration: number;
  errors: number;
}

export class BackfillService extends EventEmitter {
  private db = getDb();
  private options: BackfillOptions;
  private summary: BackfillSummary = {
    blocksProcessed: 0,
    eventsProcessed: 0,
    roundsFound: 0,
    uniqueUsers: 0,
    duration: 0,
    errors: 0,
  };
  private uniqueUsers = new Set<string>();
  private startTime = Date.now();

  constructor(options: BackfillOptions = {}) {
    super();
    this.options = {
      batchSize: 1000,
      ...options,
    };
  }

  /**
   * Run the backfill process
   */
  async run(): Promise<void> {
    logger.info('Starting backfill process...');
    this.startTime = Date.now();

    try {
      // Clear data if requested
      if (this.options.clearData) {
        await this.clearExistingData();
      }

      // Add excluded addresses
      await this.setupExcludedAddresses();

      // Determine which chains to backfill
      const chains = this.options.chain 
        ? [this.options.chain]
        : Object.keys(CHAIN_CONFIGS);

      // Backfill each chain
      for (const chainName of chains) {
        const config = CHAIN_CONFIGS[chainName as keyof typeof CHAIN_CONFIGS];
        if (!config) {
          logger.warn(`Unknown chain: ${chainName}`);
          continue;
        }

        await this.backfillChain(chainName, config);
      }

      // Reconstruct balance history
      await this.reconstructBalances();

      // Calculate summary
      this.summary.duration = Date.now() - this.startTime;
      this.summary.uniqueUsers = this.uniqueUsers.size;

      logger.info('Backfill completed successfully');
      logger.info(`Summary: ${JSON.stringify(this.summary)}`);

      this.emit('completed', this.summary);
    } catch (error) {
      logger.error('Backfill failed:', error);
      this.summary.errors++;
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Clear existing data
   */
  private async clearExistingData(): Promise<void> {
    logger.info('Clearing existing data...');
    
    await this.db.transaction(async (trx) => {
      await trx('balance_snapshots').delete();
      await trx('rounds').delete();
      await trx('share_events').delete();
      await trx('unstake_events').delete();
      await trx('droplets_cache').delete();
      await trx('current_balances').delete();
      await trx('cursors').delete();
    });
    
    logger.info('Existing data cleared');
  }

  /**
   * Setup excluded addresses
   */
  private async setupExcludedAddresses(): Promise<void> {
    logger.info('Setting up excluded addresses...');

    // Add vault contracts as excluded
    for (const config of Object.values(CHAIN_CONFIGS)) {
      for (const [asset, vault] of Object.entries(config.vaults)) {
        await this.db('excluded_addresses').insert({
          address: vault.address.toLowerCase(),
          reason: `${asset} vault contract on ${config.name}`,
        }).onConflict('address').ignore();
      }
    }

    // Add zero address
    await this.db('excluded_addresses').insert({
      address: '0x0000000000000000000000000000000000000000',
      reason: 'Zero address',
    }).onConflict('address').ignore();
  }

  /**
   * Backfill a specific chain
   */
  private async backfillChain(chainName: string, config: ChainConfig): Promise<void> {
    logger.info(`Backfilling ${chainName}...`);

    const client = createPublicClient({
      chain: config.chain,
      transport: http(config.rpcEndpoints[0], {
        retryCount: config.retryConfig.retryCount,
        retryDelay: config.retryConfig.retryDelay,
      }),
    });

    // Determine block range
    const fromBlock = BigInt(
      this.options.fromBlock || getEarliestDeploymentBlock(config)
    );
    const currentBlock = await client.getBlockNumber();
    const toBlock = this.options.toBlock 
      ? BigInt(this.options.toBlock)
      : currentBlock;

    const totalBlocks = Number(toBlock - fromBlock);
    logger.info(`Processing ${totalBlocks} blocks (${fromBlock} to ${toBlock})`);

    // Process in batches
    const batchSize = BigInt(this.options.batchSize || 1000);
    let processedBlocks = 0;

    for (let startBlock = fromBlock; startBlock < toBlock; startBlock += batchSize) {
      const endBlock = startBlock + batchSize > toBlock 
        ? toBlock 
        : startBlock + batchSize;

      // Process assets
      const assets = this.options.asset 
        ? [this.options.asset]
        : Object.keys(config.vaults) as AssetType[];

      for (const asset of assets) {
        const vault = config.vaults[asset];
        
        // Skip if before deployment
        if (Number(startBlock) < vault.deploymentBlock) {
          continue;
        }

        await this.processVaultEvents(
          client,
          asset,
          vault.address as Address,
          startBlock,
          endBlock,
          config.chainId
        );
      }

      processedBlocks += Number(endBlock - startBlock);
      this.summary.blocksProcessed += Number(endBlock - startBlock);

      // Emit progress
      const progress: BackfillProgress = {
        blocksProcessed: processedBlocks,
        eventsProcessed: this.summary.eventsProcessed,
        currentBlock: Number(endBlock),
        totalBlocks,
        percentComplete: (processedBlocks / totalBlocks) * 100,
      };

      this.emit('progress', progress);

      if (processedBlocks % 10000 === 0) {
        logger.info(`Progress: ${processedBlocks}/${totalBlocks} blocks (${progress.percentComplete.toFixed(1)}%)`);
      }
    }
  }

  /**
   * Process events for a vault
   */
  private async processVaultEvents(
    client: any,
    asset: AssetType,
    vaultAddress: Address,
    fromBlock: bigint,
    toBlock: bigint,
    chainId: number
  ): Promise<void> {
    try {
      // Fetch all events in parallel
      const [stakes, unstakes, redeems, roundRolls] = await Promise.all([
        client.getLogs({
          address: vaultAddress,
          event: EVENTS.Stake,
          fromBlock,
          toBlock,
        }),
        client.getLogs({
          address: vaultAddress,
          event: EVENTS.Unstake,
          fromBlock,
          toBlock,
        }),
        client.getLogs({
          address: vaultAddress,
          event: EVENTS.Redeem,
          fromBlock,
          toBlock,
        }),
        client.getLogs({
          address: vaultAddress,
          event: EVENTS.RoundRolled,
          fromBlock,
          toBlock,
        }),
      ]);

      // Process in transaction
      await this.db.transaction(async (trx) => {
        // Process rounds first
        for (const log of roundRolls) {
          const decoded = decodeEventLog({
            abi: [EVENTS.RoundRolled],
            data: log.data,
            topics: log.topics,
          });

          await trx('rounds').insert({
            round_id: Number(decoded.args.round),
            asset,
            chain_id: chainId,
            start_block: Number(log.blockNumber),
            start_ts: new Date(),
            pps: decoded.args.pricePerShare.toString(),
            pps_scale: 18,
            shares_minted: decoded.args.sharesMinted.toString(),
            yield: decoded.args.yield.toString(),
            is_yield_positive: decoded.args.isYieldPositive,
            tx_hash: log.transactionHash,
          }).onConflict(['round_id', 'asset', 'chain_id']).merge();

          this.summary.roundsFound++;
        }

        // Process stake events
        for (const log of stakes) {
          const decoded = decodeEventLog({
            abi: [EVENTS.Stake],
            data: log.data,
            topics: log.topics,
          });

          const address = decoded.args.account.toLowerCase();
          this.uniqueUsers.add(address);

          await trx('share_events').insert({
            chain_id: chainId,
            asset,
            address,
            event_type: 'stake',
            event_classification: 'share_change',
            shares_delta: decoded.args.amount.toString(),
            round: Number(decoded.args.round),
            block: Number(log.blockNumber),
            timestamp: new Date(),
            tx_hash: log.transactionHash,
            log_index: log.logIndex,
          }).onConflict(['tx_hash', 'log_index']).ignore();
        }

        // Process unstake events
        for (const log of unstakes) {
          const decoded = decodeEventLog({
            abi: [EVENTS.Unstake],
            data: log.data,
            topics: log.topics,
          });

          const address = decoded.args.account.toLowerCase();
          this.uniqueUsers.add(address);

          await trx('share_events').insert({
            chain_id: chainId,
            asset,
            address,
            event_type: 'unstake',
            event_classification: 'share_change',
            shares_delta: `-${decoded.args.amount}`,
            round: Number(decoded.args.round),
            block: Number(log.blockNumber),
            timestamp: new Date(),
            tx_hash: log.transactionHash,
            log_index: log.logIndex,
          }).onConflict(['tx_hash', 'log_index']).ignore();

          // Track unstake for round exclusion
          await trx('unstake_events').insert({
            address,
            asset,
            round: Number(decoded.args.round),
            amount: decoded.args.amount.toString(),
            block: Number(log.blockNumber),
          }).onConflict(['address', 'asset', 'round']).ignore();
        }

        // Process redeem events
        for (const log of redeems) {
          const decoded = decodeEventLog({
            abi: [EVENTS.Redeem],
            data: log.data,
            topics: log.topics,
          });

          const address = decoded.args.account.toLowerCase();
          this.uniqueUsers.add(address);

          await trx('share_events').insert({
            chain_id: chainId,
            asset,
            address,
            event_type: 'redeem',
            event_classification: 'share_change',
            shares_delta: decoded.args.share.toString(),
            round: Number(decoded.args.round),
            block: Number(log.blockNumber),
            timestamp: new Date(),
            tx_hash: log.transactionHash,
            log_index: log.logIndex,
          }).onConflict(['tx_hash', 'log_index']).ignore();
        }
      });

      // Update event count
      const totalEvents = stakes.length + unstakes.length + redeems.length + roundRolls.length;
      this.summary.eventsProcessed += totalEvents;

      if (totalEvents > 0) {
        logger.debug(`Processed ${totalEvents} events for ${asset} in blocks ${fromBlock}-${toBlock}`);
      }
    } catch (error) {
      logger.error(`Error processing events for ${asset}:`, error);
      this.summary.errors++;
      throw error;
    }
  }

  /**
   * Reconstruct balance history from events
   */
  private async reconstructBalances(): Promise<void> {
    logger.info('Reconstructing balance history...');

    const events = await this.db('share_events')
      .select('address', 'asset', 'event_type', 'shares_delta', 'round', 'block', 'chain_id')
      .orderBy(['address', 'asset', 'block']);

    const balances: Record<string, Record<string, bigint>> = {};
    let snapshotCount = 0;

    // Build running balances
    for (const event of events) {
      const key = `${event.address}-${event.asset}`;
      
      if (!balances[key]) {
        balances[key] = {};
      }
      
      if (!balances[key][event.round]) {
        balances[key][event.round] = 0n;
      }

      // Update balance
      const delta = BigInt(event.shares_delta);
      balances[key][event.round] += delta;

      // Create snapshot
      await this.db('balance_snapshots').insert({
        address: event.address,
        asset: event.asset,
        round_id: event.round,
        shares_at_start: balances[key][event.round].toString(),
        had_unstake_in_round: event.event_type === 'unstake',
      }).onConflict(['address', 'asset', 'round_id']).merge();

      snapshotCount++;
    }

    logger.info(`Created ${snapshotCount} balance snapshots`);
  }

  /**
   * Get summary of backfill operation
   */
  getSummary(): BackfillSummary {
    return { ...this.summary };
  }
}

export default BackfillService;