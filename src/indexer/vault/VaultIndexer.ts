import { getDb } from '../../db/connection';
import { createLogger } from '../../utils/logger';
import { EventProcessor } from './EventProcessor';
import { BalanceTracker } from './BalanceTracker';
import { BlockRange, IndexerContractConfig, CONSTANTS } from '../../config/constants';
import { AlchemyService } from '../../utils/AlchemyService';
import { CONTRACTS, SUPPORTED_CHAINS, checkZeroAddress } from '../../config/contracts';
import { withAlchemyRetry } from '../../utils/retryUtils';

const logger = createLogger('VaultIndexer');

const MAX_BATCHES: Record<number, number> = {
  1: 100000,
  146: 10000,
  8453: 100000,
  42161: 100000,
  43114: 10000,
  80094: 10000,
  59144: 10000,
  137: 100000,
  56: 10000,
  9745: 10000,
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
   */
  private buildVaultContracts(): IndexerContractConfig[] {
    const contractConfigs: IndexerContractConfig[] = [];
    
    for (const [symbol, contractConfig] of Object.entries(CONTRACTS)) {
      for (const [chainName, chainConfig] of Object.entries(SUPPORTED_CHAINS)) {
        const chainId = chainConfig.chainId;
        const vaultAddress = contractConfig[chainName as keyof typeof contractConfig] as string;
        
        if (vaultAddress && !checkZeroAddress(vaultAddress)) {
          contractConfigs.push({
            address: vaultAddress,
            symbol,
            chainId,
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
   * Fetch and process vault events for multiple chains and block ranges
   */
  async fetchAndProcessVaults(blockRanges: BlockRange[]): Promise<void> {
    logger.info(`Processing vault events for ${blockRanges.length} block ranges`);
    
    logger.info(`Creating batched ranges for vault processing`);
    const batchedVaultRanges = this.createBatchedRanges(blockRanges);
    logger.info(`Created ${batchedVaultRanges.length} batched vault ranges from ${blockRanges.length} original ranges`);
    
    logger.info(`Starting parallel processing of ${batchedVaultRanges.length} batched ranges`);
    
    const batchPromises = batchedVaultRanges.map(async (blockRange) => {
      const { chainId, fromBlock, toBlock, dateString } = blockRange;
      logger.debug(`Starting parallel processing for chain ${chainId} from block ${fromBlock} to ${toBlock} (${dateString})`);
      
      const chainContracts = this.contracts.filter(c => c.chainId === chainId);
      
      if (chainContracts.length === 0) {
        logger.debug(`No vault contracts configured for chain ${chainId}`);
        return;
      }
      
      const contractPromises = chainContracts.map(async (contract) => {
        try {
          await this.processEventLogsForContract(contract, blockRange);
          logger.debug(`Completed event processing for ${contract.symbol} on chain ${chainId} (blocks ${fromBlock}-${toBlock})`);
        } catch (error) {
          logger.error(`Error processing events for ${contract.symbol} on chain ${chainId} (blocks ${fromBlock}-${toBlock}):`, error);
          throw error;
        }
      });
      
      await Promise.all(contractPromises);
      logger.info(`Completed all contract processing for chain ${chainId} (blocks ${fromBlock}-${toBlock})`);
    });
    
    await Promise.all(batchPromises);
    logger.info(`Completed parallel processing of all ${batchedVaultRanges.length} batched ranges`);
    
    logger.info(`Running balance tracker for all chains with original full block ranges`);
    await this.balanceTracker.processEventsFromDatabase(blockRanges);
  }

  /**
   * Process event logs for a single contract within a block range
   */
  private async processEventLogsForContract(
    contract: IndexerContractConfig,
    range: BlockRange
  ): Promise<void> {
    try {
      const { fromBlock, toBlock, dateString } = range;
      const useViemClient = contract.chainId === CONSTANTS.CHAIN_IDS.PLASMA;
      
      let logs: any[];
      
      if (useViemClient) {
        logs = await withAlchemyRetry(async () => {
          const viemClient = this.alchemyService.getViemClient(contract.chainId);
          const viemLogs = await viemClient.getLogs({
            address: contract.address as `0x${string}`,
            fromBlock: BigInt(fromBlock),
            toBlock: BigInt(toBlock),
          });

          return viemLogs.map(log => ({
            blockNumber: Number(log.blockNumber),
            blockHash: log.blockHash,
            transactionIndex: log.transactionIndex,
            removed: log.removed,
            address: log.address,
            data: log.data,
            topics: log.topics,
            transactionHash: log.transactionHash,
            logIndex: log.logIndex,
          }));
        }, `getLogs for ${contract.symbol} on chain ${contract.chainId} (blocks ${fromBlock}-${toBlock})`);
      } else {
        const alchemy = this.getAlchemyInstance(contract.chainId);
        
        logs = await withAlchemyRetry(async () => {
          return await alchemy.core.getLogs({
            address: contract.address,
            fromBlock: fromBlock,
            toBlock: toBlock,
          });
        }, `getLogs for ${contract.symbol} on chain ${contract.chainId} (blocks ${fromBlock}-${toBlock})`);
      }
      
      logger.info(`Found ${logs.length} events for ${contract.symbol} on chain ${contract.chainId} (${contract.address}) from blocks ${fromBlock}-${toBlock} (${dateString})`);
      
      for (const log of logs) {
        await this.eventProcessor.processEventLog(log, contract, dateString);
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
