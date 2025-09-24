import { getDb } from '../../db/connection';
import { createLogger } from '../../utils/logger';
import { EventProcessor } from './EventProcessor';
import { BalanceTracker } from './BalanceTracker';
import { BlockRange, IndexerContractConfig } from '../../config/constants';
import { AlchemyService } from '../../utils/AlchemyService';
import { CONTRACTS, SUPPORTED_CHAINS, checkZeroAddress } from '../../config/contracts';
import { withAlchemyRetry } from '../../utils/retryUtils';

const logger = createLogger('VaultIndexer');

// Max batch sizes by chain ID (discovered through testing)
const MAX_BATCHES: Record<number, number> = {
  1: 100000,     // Ethereum
  146: 10000,    // Sonic
  8453: 100000,  // Base
  42161: 100000, // Arbitrum
  43114: 10000,  // Avalanche
  80094: 10000,  // Berachain
};

/**
 * Simplified vault indexer for daily event processing
 * Processes events for specific day ranges without cursor management
 */
export class VaultIndexer {
  private alchemyService: AlchemyService;
  private db = getDb();
  private contracts: IndexerContractConfig[];
  private eventProcessor: EventProcessor;
  private balanceTracker: BalanceTracker;
  
  constructor() {
    this.alchemyService = AlchemyService.getInstance();
    this.contracts = this.buildVaultContracts();
    
    this.balanceTracker = new BalanceTracker();
    this.eventProcessor = new EventProcessor();
    
    logger.info(`Initialized vault indexer with ${this.contracts.length} contracts`);
  }

  /**
   * Build vault contract configurations from the CONTRACTS object
   * Only includes vault addresses (not oracle feeds)
   */
  private buildVaultContracts(): IndexerContractConfig[] {
    const contractConfigs: IndexerContractConfig[] = [];
    
    // Iterate through each vault type (xETH, xBTC, xUSD, xEUR)
    for (const [symbol, contractConfig] of Object.entries(CONTRACTS)) {
      // Iterate through each supported chain
      for (const [chainName, chainConfig] of Object.entries(SUPPORTED_CHAINS)) {
        const chainId = chainConfig.chainId;
        const vaultAddress = contractConfig[chainName as keyof typeof contractConfig] as string;
        
        // Skip if address is not set or is zero address
        if (vaultAddress && !checkZeroAddress(vaultAddress)) {
          contractConfigs.push({
            address: vaultAddress,
            symbol,
            chainId,
            // startBlock can be added later if needed from deployment data
          });
          
          logger.debug(`Added vault contract: ${symbol} on ${chainConfig.name} (${vaultAddress})`);
        }
      }
    }
    
    return contractConfigs;
  }

  /**
   * Get Alchemy instance for a specific chain
   */
  private getAlchemyInstance(chainId: number) {
    return this.alchemyService.getAlchemyInstance(chainId);
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
   * Fetch and process vault events for multiple chains and block ranges
   * Only processes contracts for chains present in the blockRanges
   * Handles batching internally for Alchemy rate limits but passes full ranges to BalanceTracker
   * Processes batches in parallel for improved performance
   */
  async fetchAndProcessVaults(blockRanges: BlockRange[]): Promise<void> {
    logger.info(`Processing vault events for ${blockRanges.length} block ranges`);
    
    // Create batched ranges for event fetching to respect Alchemy limits
    logger.info(`Creating batched ranges for vault processing`);
    const batchedVaultRanges = this.createBatchedRanges(blockRanges);
    logger.info(`Created ${batchedVaultRanges.length} batched vault ranges from ${blockRanges.length} original ranges`);
    
    // Phase 1: Process all event logs for all chains and contracts using batched ranges IN PARALLEL
    logger.info(`Starting parallel processing of ${batchedVaultRanges.length} batched ranges`);
    
    const batchPromises = batchedVaultRanges.map(async (blockRange) => {
      const { chainId, fromBlock, toBlock } = blockRange;
      logger.debug(`Starting parallel processing for chain ${chainId} from block ${fromBlock} to ${toBlock}`);
      
      // Only get contracts for this specific chain, ensuring contracts are deployed
      const chainContracts = this.contracts.filter(c => c.chainId === chainId);
      
      if (chainContracts.length === 0) {
        logger.debug(`No vault contracts configured for chain ${chainId}`);
        return;
      }
      
      // Process events for each contract IN PARALLEL (EventProcessor phase only)
      const contractPromises = chainContracts.map(async (contract) => {
        try {
          await this.processEventLogsForContract(contract, fromBlock, toBlock);
          logger.debug(`Completed event processing for ${contract.symbol} on chain ${chainId} (blocks ${fromBlock}-${toBlock})`);
        } catch (error) {
          logger.error(`Error processing events for ${contract.symbol} on chain ${chainId} (blocks ${fromBlock}-${toBlock}):`, error);
          throw error;
        }
      });
      
      await Promise.all(contractPromises);
      logger.info(`Completed all contract processing for chain ${chainId} (blocks ${fromBlock}-${toBlock})`);
    });
    
    // Wait for all batches to complete
    await Promise.all(batchPromises);
    logger.info(`Completed parallel processing of all ${batchedVaultRanges.length} batched ranges`);
    
    // Phase 2: After all chains and contracts are processed, run BalanceTracker with ORIGINAL full block ranges
    // This ensures cross-chain transfers are properly accounted for before balance calculations
    logger.info(`Running balance tracker for all chains with original full block ranges`);
    await this.balanceTracker.processEventsFromDatabase(blockRanges);
  }

  /**
   * Process event logs for a single contract within a block range
   * Only handles EventProcessor phase - BalanceTracker runs once for all chains afterwards
   */
  private async processEventLogsForContract(
    contract: IndexerContractConfig,
    fromBlock: number,
    toBlock: number
  ): Promise<void> {
    try {
      const alchemy = this.getAlchemyInstance(contract.chainId);
      
      const logs = await withAlchemyRetry(async () => {
        return await alchemy.core.getLogs({
          address: contract.address,
          fromBlock: fromBlock,
          toBlock: toBlock,
        });
      }, `getLogs for ${contract.symbol} on chain ${contract.chainId} (blocks ${fromBlock}-${toBlock})`);
      
      logger.info(`Found ${logs.length} events for ${contract.symbol} on chain ${contract.chainId} (${contract.address}) from blocks ${fromBlock}-${toBlock}`);
      
      for (const log of logs) {
        await this.eventProcessor.processEventLog(log, contract);
      }
      
      if (logs.length > 0) {
        logger.info(`Successfully processed ${logs.length} event logs for ${contract.symbol} on chain ${contract.chainId}`);
      }
      
    } catch (error: any) {
      logger.error(`CRITICAL: Failed processing event logs for ${contract.symbol} on chain ${contract.chainId}: ${error.message}`);
      throw error;
    }
  }


  /**
   * Returns indexing metrics for monitoring and debugging
   */
  async getMetrics(): Promise<any> {
    const metrics: any = {};
    
    for (const contract of this.contracts) {
      const eventCount = await this.db('daily_events')
        .where({
          chain_id: contract.chainId,
        })
        .count('* as count')
        .first();
      
      metrics[contract.symbol] = {
        events: eventCount?.count || 0,
      };
    }
    
    return metrics;
  }
}

export default VaultIndexer;
