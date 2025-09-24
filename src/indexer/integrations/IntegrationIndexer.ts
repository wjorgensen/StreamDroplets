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

// Max batch sizes by chain ID (discovered through testing)
const MAX_BATCHES: Record<number, number> = {
  1: 100000,     // Ethereum
  146: 10000,    // Sonic
  8453: 100000,  // Base
  42161: 100000, // Arbitrum
  43114: 10000,  // Avalanche
  80094: 10000,  // Berachain
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
        // Range is within limits, use as-is
        batchedRanges.push(range);
      } else {
        // Range exceeds limit, break into chunks
        logger.info(`Breaking range for chain ${range.chainId} (${blockRangeSize} blocks) into chunks of max ${maxBatchSize} blocks`);
        
        const chunks = Math.ceil(blockRangeSize / maxBatchSize);
        for (let i = 0; i < chunks; i++) {
          const chunkFromBlock = range.fromBlock + (i * maxBatchSize);
          const chunkToBlock = Math.min(chunkFromBlock + maxBatchSize - 1, range.toBlock);
          
          batchedRanges.push({
            chainId: range.chainId,
            fromBlock: chunkFromBlock,
            toBlock: chunkToBlock
          });
          
          logger.debug(`Created chunk ${i + 1}/${chunks} for chain ${range.chainId}: blocks ${chunkFromBlock} to ${chunkToBlock}`);
        }
      }
    }
    
    return batchedRanges;
  }

  /**
   * Initialize Royco sync - MUST complete successfully to prevent corrupted tracking
   * This ensures all historical Royco data is available before processing begins
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
   * This is the main function called by DailySnapshotService
   * Handles batching internally for Alchemy rate limits
   */
  async fetchAndProcessIntegrations(
    blockRanges: BlockRange[],
    eventDate: string
  ): Promise<void> {
    logger.info(`Processing integration events for ${blockRanges.length} block ranges`);

    // Create batched ranges for event fetching to respect Alchemy limits
    logger.info(`Creating batched ranges for integration processing`);
    const batchedIntegrationRanges = this.createBatchedRanges(blockRanges);
    logger.info(`Created ${batchedIntegrationRanges.length} batched integration ranges from ${blockRanges.length} original ranges`);

    // Process Sonic chain integrations using batched ranges
    const sonicBatchedRanges = batchedIntegrationRanges.filter(range => range.chainId === CONSTANTS.CHAIN_IDS.SONIC);
    if (sonicBatchedRanges.length > 0) {
      logger.info(`Processing ${sonicBatchedRanges.length} batched Sonic integration ranges`);

      try {
        for (const range of sonicBatchedRanges) {
          const { fromBlock, toBlock } = range;
          logger.info(`Processing Sonic integration events from block ${fromBlock} to ${toBlock}`);
          await this.processSonicIntegrations(fromBlock, toBlock, eventDate);
        }
        logger.info('Successfully processed all Sonic integration events');
      } catch (error) {
        logger.error('Failed to process Sonic integration events:', error);
        throw error;
      }
    }

    // Process Avalanche chain integrations using batched ranges
    const avalancheBatchedRanges = batchedIntegrationRanges.filter(range => range.chainId === CONSTANTS.CHAIN_IDS.AVALANCHE);
    if (avalancheBatchedRanges.length > 0) {
      logger.info(`Processing ${avalancheBatchedRanges.length} batched Avalanche integration ranges`);

      try {
        for (const range of avalancheBatchedRanges) {
          const { fromBlock, toBlock } = range;
          logger.info(`Processing Avalanche integration events from block ${fromBlock} to ${toBlock}`);
          await this.processAvalancheIntegrations(fromBlock, toBlock, eventDate);
        }
        logger.info('Successfully processed all Avalanche integration events');
      } catch (error) {
        logger.error('Failed to process Avalanche integration events:', error);
        throw error;
      }
    }
  }

  /**
   * Process Sonic integration events for a given block range
   */
  private async processSonicIntegrations(
    fromBlock: number,
    toBlock: number,
    eventDate: string
  ): Promise<void> {
    await this.processSonicIntegrationsForRange(fromBlock, toBlock, eventDate);
  }

  /**
   * Process Sonic integration events for a specific block range
   */
  private async processSonicIntegrationsForRange(
    fromBlock: number,
    toBlock: number,
    eventDate: string
  ): Promise<void> {
    logger.info(`Processing Sonic integration events sequentially from block ${fromBlock} to ${toBlock}`);
    
    // Ensure Royco is initialized before processing events
    if (!this.roycoInitialized) {
      await this.initializeRoycoSync();
    }
    
    await this.shadowBalanceTracker.processShadowEvents(fromBlock, toBlock, eventDate);
    await this.eulerBalanceTracker.processEulerEvents(fromBlock, toBlock, eventDate);
    await this.enclabsBalanceTracker.processEnclabsEvents(fromBlock, toBlock, eventDate);
    await this.stabilityBalanceTracker.processStabilityEvents(fromBlock, toBlock, eventDate);
    await this.roycoBalanceTracker.processRoycoEvents(fromBlock, toBlock, eventDate);
    await this.siloBalanceTracker.processSiloEvents(CONSTANTS.CHAIN_IDS.SONIC, fromBlock, toBlock, eventDate);
  }

  /**
   * Process Avalanche integration events for a given block range
   */
  private async processAvalancheIntegrations(
    fromBlock: number,
    toBlock: number,
    eventDate: string
  ): Promise<void> {
    await this.processAvalancheIntegrationsForRange(fromBlock, toBlock, eventDate);
  }

  /**
   * Process Avalanche integration events for a specific block range
   */
  private async processAvalancheIntegrationsForRange(
    fromBlock: number,
    toBlock: number,
    eventDate: string
  ): Promise<void> {
    logger.info(`Processing Avalanche integration events sequentially from block ${fromBlock} to ${toBlock}`);
    
    await this.siloBalanceTracker.processSiloEvents(CONSTANTS.CHAIN_IDS.AVALANCHE, fromBlock, toBlock, eventDate);
  }

  /**
   * Sync Royco deposits from API - smart sync based on existing data
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
   * Update integration balances based on price per share at specific block for protocols with APY
   */
  async updateIntegrationBalances(blockRanges: BlockRange[]): Promise<void> {
    logger.info(`Starting integration balance updates with block ranges`);

    // Find Sonic block range for all Sonic-based protocols
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

    // Find Avalanche block range for Silo on Avalanche (only integration on Avalanche)
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

  /**
   * Process events for a specific integration protocol
   * Used for retry logic when validation fails
   */
  async processSpecificIntegration(
    protocolName: string,
    chainId: number,
    fromBlock: number,
    toBlock: number,
    eventDate: string
  ): Promise<void> {
    logger.info(`Processing specific integration: ${protocolName} on chain ${chainId} from block ${fromBlock} to ${toBlock}`);

    // Ensure Royco is initialized if needed
    if (protocolName === 'royco' && !this.roycoInitialized) {
      await this.initializeRoycoSync();
    }

    switch (protocolName) {
      case 'shadow_exchange':
        if (chainId === CONSTANTS.CHAIN_IDS.SONIC) {
          await this.shadowBalanceTracker.processShadowEvents(fromBlock, toBlock, eventDate);
        } else {
          logger.warn(`Shadow Exchange not supported on chain ${chainId}`);
        }
        break;

      case 'euler_finance':
        if (chainId === CONSTANTS.CHAIN_IDS.SONIC) {
          await this.eulerBalanceTracker.processEulerEvents(fromBlock, toBlock, eventDate);
        } else {
          logger.warn(`Euler Finance not supported on chain ${chainId}`);
        }
        break;

      case 'enclabs':
        if (chainId === CONSTANTS.CHAIN_IDS.SONIC) {
          await this.enclabsBalanceTracker.processEnclabsEvents(fromBlock, toBlock, eventDate);
        } else {
          logger.warn(`Enclabs not supported on chain ${chainId}`);
        }
        break;

      case 'stability':
        if (chainId === CONSTANTS.CHAIN_IDS.SONIC) {
          await this.stabilityBalanceTracker.processStabilityEvents(fromBlock, toBlock, eventDate);
        } else {
          logger.warn(`Stability Protocol not supported on chain ${chainId}`);
        }
        break;

      case 'royco':
        if (chainId === CONSTANTS.CHAIN_IDS.SONIC) {
          await this.roycoBalanceTracker.processRoycoEvents(fromBlock, toBlock, eventDate);
        } else {
          logger.warn(`Royco not supported on chain ${chainId}`);
        }
        break;

      case 'silo_finance':
        if (chainId === CONSTANTS.CHAIN_IDS.SONIC || chainId === CONSTANTS.CHAIN_IDS.AVALANCHE) {
          await this.siloBalanceTracker.processSiloEvents(chainId, fromBlock, toBlock, eventDate);
        } else {
          logger.warn(`Silo Finance not supported on chain ${chainId}`);
        }
        break;

      default:
        throw new Error(`Unknown protocol name: ${protocolName}`);
    }

    logger.info(`Successfully processed specific integration: ${protocolName}`);
  }

  /**
   * Update balances for a specific integration protocol  
   * Used for retry logic when validation fails
   */
  async updateSpecificIntegrationBalances(protocolName: string, blockRanges: BlockRange[]): Promise<void> {
    logger.info(`Updating balances for specific integration: ${protocolName}`);

    // Find Sonic and Avalanche block ranges
    const sonicRange = blockRanges.find(range => range.chainId === CONSTANTS.CHAIN_IDS.SONIC);
    const avalancheRange = blockRanges.find(range => range.chainId === CONSTANTS.CHAIN_IDS.AVALANCHE);

    switch (protocolName) {
      case 'euler_finance':
        if (sonicRange) {
          await this.eulerBalanceTracker.updateBalancesWithPricePerShare(sonicRange.toBlock);
        } else {
          logger.warn('No Sonic block range available for Euler Finance update');
        }
        break;

      case 'enclabs':
        if (sonicRange) {
          await this.enclabsBalanceTracker.updateBalancesWithExchangeRate(sonicRange.toBlock);
        } else {
          logger.warn('No Sonic block range available for Enclabs update');
        }
        break;

      case 'stability':
        if (sonicRange) {
          await this.stabilityBalanceTracker.updateBalancesWithLiquidityIndex(sonicRange.toBlock);
        } else {
          logger.warn('No Sonic block range available for Stability update');
        }
        break;

      case 'silo_finance':
        // Silo is on both Sonic and Avalanche
        if (sonicRange) {
          await this.siloBalanceTracker.updateBalancesWithPricePerShare(CONSTANTS.CHAIN_IDS.SONIC, sonicRange.toBlock);
        } else {
          logger.warn('No Sonic block range available for Silo Finance on Sonic update');
        }
        if (avalancheRange) {
          await this.siloBalanceTracker.updateBalancesWithPricePerShare(CONSTANTS.CHAIN_IDS.AVALANCHE, avalancheRange.toBlock);
        } else {
          logger.warn('No Avalanche block range available for Silo Finance on Avalanche update');
        }
        break;

      case 'shadow_exchange':
      case 'royco':
        // These protocols don't have balance updates with price per share
        logger.info(`Protocol ${protocolName} does not require balance updates`);
        break;

      default:
        throw new Error(`Unknown protocol name: ${protocolName}`);
    }

    logger.info(`Successfully updated balances for specific integration: ${protocolName}`);
  }
}