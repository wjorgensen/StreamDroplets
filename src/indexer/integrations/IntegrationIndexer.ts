/**
 * Integration Protocol Indexer - Coordinator
 * Orchestrates event fetching and balance updates across all integration protocols
 */

import { createLogger } from '../../utils/logger';
import { CONSTANTS, BlockRange } from '../../config/constants';
import { ShadowBalanceTracker } from './shadowBalanceTracker';
import { EulerBalanceTracker } from './eulerBalanceTracker';
import { EnclabsBalanceTracker } from './enclabsBalanceTracker';
import { StabilityBalanceTracker } from './stabilityBalanceTracker';
import { RoycoBalanceTracker } from './roycoBalanceTracker';
import { SiloBalanceTracker } from './siloBalanceTracker';

const logger = createLogger('IntegrationIndexer');

const MAX_BATCHES: Record<number, number> = {
  1: 100000,
  146: 10000,
  8453: 100000,
  42161: 100000,
  43114: 10000,
  80094: 10000,
};

export class IntegrationIndexer {
  private shadowBalanceTracker = new ShadowBalanceTracker();
  private eulerBalanceTracker = new EulerBalanceTracker();
  private enclabsBalanceTracker = new EnclabsBalanceTracker();
  private stabilityBalanceTracker = new StabilityBalanceTracker();
  private roycoBalanceTracker = new RoycoBalanceTracker();
  private siloBalanceTracker = new SiloBalanceTracker();
  private roycoInitialized = false;

  constructor() {
    logger.info(`Initialized Integration Indexer`);
  }

  /**
   * Create batched ranges based on chain-specific MAX_BATCHES limits
   */
  private createBatchedRanges(blockRanges: BlockRange[]): BlockRange[] {
    const batchedRanges: BlockRange[] = [];
    
    for (const range of blockRanges) {
      const maxBatchSize = MAX_BATCHES[range.chainId];
      if (!maxBatchSize) {
        logger.warn(`No max batch size configured for chain ${range.chainId}, using range as-is`);
        batchedRanges.push(range);
        continue;
      }
      
      const blockRangeSize = range.toBlock - range.fromBlock + 1;
      
      if (blockRangeSize <= maxBatchSize) {
        batchedRanges.push(range);
      } else {
        logger.info(`Breaking range for chain ${range.chainId} (${blockRangeSize} blocks) into chunks of max ${maxBatchSize} blocks`);
        
        const chunks = Math.ceil(blockRangeSize / maxBatchSize);
        for (let i = 0; i < chunks; i++) {
          const chunkFromBlock = range.fromBlock + (i * maxBatchSize);
          const chunkToBlock = Math.min(chunkFromBlock + maxBatchSize - 1, range.toBlock);
          
          batchedRanges.push({
            chainId: range.chainId,
            fromBlock: chunkFromBlock,
            toBlock: chunkToBlock,
            dateString: range.dateString,
          });
          
          logger.debug(`Created chunk ${i + 1}/${chunks} for chain ${range.chainId}: blocks ${chunkFromBlock} to ${chunkToBlock}`);
        }
      }
    }
    
    return batchedRanges;
  }

  /**
   * Initialize Royco sync to ensure all historical data is available before processing
   */
  async initializeRoycoSync(): Promise<void> {
    if (this.roycoInitialized) {
      logger.info('Royco already initialized, skipping');
      return;
    }

    try {
      await this.roycoBalanceTracker.syncRoycoDeposits();
      this.roycoInitialized = true;
      logger.info('Royco deposits synced successfully on initialization');
    } catch (error) {
      logger.error('CRITICAL: Failed to sync Royco deposits on initialization:', error);
      throw new Error(`Royco initialization failed: ${error}. Cannot proceed with potentially corrupted state.`);
    }
  }

  /**
   * Fetch and process integration events for multiple chains and block ranges
   */
  async fetchAndProcessIntegrations(
    blockRanges: BlockRange[]
  ): Promise<void> {
    logger.info(`Processing integration events for ${blockRanges.length} block ranges`);

    logger.info(`Creating batched ranges for integration processing`);
    const batchedIntegrationRanges = this.createBatchedRanges(blockRanges);
    logger.info(`Created ${batchedIntegrationRanges.length} batched integration ranges from ${blockRanges.length} original ranges`);

    await this.fetchIntegrationEvents(batchedIntegrationRanges);
    await this.processIntegrationEventBalances(blockRanges);
  }

  private async fetchIntegrationEvents(
    batchedRanges: BlockRange[]
  ): Promise<void> {
    if (batchedRanges.length === 0) {
      logger.info('No batched ranges provided for integration event fetching');
      return;
    }

    logger.info(`Fetching integration events for ${batchedRanges.length} batched ranges`);

    const fetchTasks: Promise<void>[] = [];

    for (const range of batchedRanges) {
      const perRangeTasks: Promise<void>[] = [];

      switch (range.chainId) {
        case CONSTANTS.CHAIN_IDS.SONIC:
          perRangeTasks.push(
            this.shadowBalanceTracker.fetchEventsForRange(range.fromBlock, range.toBlock, range.dateString),
            this.eulerBalanceTracker.fetchEventsForRange(range.fromBlock, range.toBlock, range.dateString),
            this.enclabsBalanceTracker.fetchEventsForRange(range.fromBlock, range.toBlock, range.dateString),
            this.stabilityBalanceTracker.fetchEventsForRange(range.fromBlock, range.toBlock, range.dateString),
            this.siloBalanceTracker.fetchEventsForRange(CONSTANTS.CHAIN_IDS.SONIC, range.fromBlock, range.toBlock, range.dateString)
          );
          break;

        case CONSTANTS.CHAIN_IDS.AVALANCHE:
          perRangeTasks.push(
            this.siloBalanceTracker.fetchEventsForRange(CONSTANTS.CHAIN_IDS.AVALANCHE, range.fromBlock, range.toBlock, range.dateString)
          );
          break;

        default:
          logger.warn(`No integration fetchers configured for chain ${range.chainId}`);
      }

      if (perRangeTasks.length > 0) {
        fetchTasks.push(
          Promise.all(perRangeTasks).then(() => {
            logger.debug(`Completed fetch tasks for chain ${range.chainId} blocks ${range.fromBlock}-${range.toBlock}`);
          })
        );
      }
    }

    await Promise.all(fetchTasks);

    logger.info('Integration event fetching completed');
  }

  /**
   * Process integration event balances for fetched events
   */
  private async processIntegrationEventBalances(
    blockRanges: BlockRange[]
  ): Promise<void> {
    logger.info('Starting integration balance processing for stored events');

    const processingTasks: Promise<void>[] = [];

    const sonicRange = blockRanges.find(range => range.chainId === CONSTANTS.CHAIN_IDS.SONIC);
    if (sonicRange) {
      if (!this.roycoInitialized) {
        await this.initializeRoycoSync();
      }

      processingTasks.push(
        this.shadowBalanceTracker.processEventsForRange(sonicRange, sonicRange.dateString),
        this.eulerBalanceTracker.processEventsForRange(sonicRange, sonicRange.dateString),
        this.enclabsBalanceTracker.processEventsForRange(sonicRange, sonicRange.dateString),
        this.stabilityBalanceTracker.processEventsForRange(sonicRange, sonicRange.dateString),
        this.siloBalanceTracker.processEventsForRange(sonicRange, sonicRange.dateString),
        this.roycoBalanceTracker.processRoycoEvents(sonicRange.fromBlock, sonicRange.toBlock, sonicRange.dateString)
      );
    } else {
      logger.warn('No Sonic block range available for integration balance processing');
    }

    const avalancheRange = blockRanges.find(range => range.chainId === CONSTANTS.CHAIN_IDS.AVALANCHE);
    if (avalancheRange) {
      processingTasks.push(
        this.siloBalanceTracker.processEventsForRange(avalancheRange, avalancheRange.dateString)
      );
    }

    if (processingTasks.length === 0) {
      logger.warn('No integration balance processing tasks were scheduled');
      return;
    }

    await Promise.all(processingTasks);

    logger.info('Integration balance processing completed');
  }

  /**
   * Sync Royco deposits from API
   */
  async syncRoycoDeposits(): Promise<void> {
    try {
      await this.roycoBalanceTracker.syncRoycoDeposits();
      logger.info('Successfully synced Royco deposits from API');
    } catch (error) {
      logger.error('Failed to sync Royco deposits from API:', error);
      throw error;
    }
  }

  /**
   * Update integration balances based on price per share at specific block
   */
  async updateIntegrationBalances(blockRanges: BlockRange[]): Promise<void> {
    logger.info(`Starting integration balance updates with block ranges`);

    const sonicRange = blockRanges.find(range => range.chainId === CONSTANTS.CHAIN_IDS.SONIC);
    if (sonicRange) {
      const sonicBlock = sonicRange.toBlock;
      logger.info(`Using Sonic block ${sonicBlock} for Sonic-based protocols`);
      
      await this.eulerBalanceTracker.updateBalancesWithPricePerShare(sonicBlock);
      logger.info('Successfully updated Euler balances');

      await this.enclabsBalanceTracker.updateBalancesWithExchangeRate(sonicBlock);
      logger.info('Successfully updated Enclabs balances');

      await this.stabilityBalanceTracker.updateBalancesWithLiquidityIndex(sonicBlock);
      logger.info('Successfully updated Stability balances');

      await this.siloBalanceTracker.updateBalancesWithPricePerShare(CONSTANTS.CHAIN_IDS.SONIC, sonicBlock);
      logger.info('Successfully updated Silo Finance balances on Sonic');
    } else {
      logger.warn('No Sonic block range found for integration balance updates');
    }

    const avalancheRange = blockRanges.find(range => range.chainId === CONSTANTS.CHAIN_IDS.AVALANCHE);
    if (avalancheRange) {
      const avalancheBlock = avalancheRange.toBlock;
      logger.info(`Using Avalanche block ${avalancheBlock} for Silo Finance on Avalanche`);
      
      await this.siloBalanceTracker.updateBalancesWithPricePerShare(CONSTANTS.CHAIN_IDS.AVALANCHE, avalancheBlock);
      logger.info('Successfully updated Silo Finance balances on Avalanche');
    } else {
      logger.warn('No Avalanche block range found for Silo Finance on Avalanche');
    }

    logger.info('Integration balance updates completed successfully');
  }

}
