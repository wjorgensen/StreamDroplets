/**
 * Indexer Orchestrator
 * Manages multiple chain indexers with monitoring and recovery
 */

import { CHAIN_CONFIGS, ChainConfig } from '../config/chains';
import { IndexerService, IndexerMetrics } from './IndexerService';
import { createLogger } from '../utils/logger';
import EventEmitter from 'events';

const logger = createLogger('IndexerOrchestrator');

export interface OrchestratorStatus {
  running: boolean;
  startTime: Date;
  indexers: {
    [chainName: string]: {
      status: 'running' | 'stopped' | 'error';
      metrics: IndexerMetrics;
      lastError?: string;
    };
  };
}

export class IndexerOrchestrator extends EventEmitter {
  private indexers: Map<string, IndexerService> = new Map();
  private startTime: Date = new Date();
  private isRunning = false;
  private monitoringInterval?: NodeJS.Timeout;

  constructor() {
    super();
    logger.info('IndexerOrchestrator initialized');
  }

  /**
   * Start all configured indexers
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Orchestrator already running');
      return;
    }

    logger.info('Starting Indexer Orchestrator...');
    this.isRunning = true;
    this.startTime = new Date();

    // Start indexers for each configured chain
    for (const [chainName, config] of Object.entries(CHAIN_CONFIGS)) {
      await this.startIndexer(chainName, config);
    }

    // Start monitoring
    this.startMonitoring();

    logger.info(`✅ Orchestrator started with ${this.indexers.size} indexers`);
    this.emit('started', this.getStatus());
  }

  /**
   * Start a single indexer
   */
  private async startIndexer(chainName: string, config: ChainConfig): Promise<void> {
    try {
      logger.info(`Starting indexer for ${chainName}...`);
      
      const indexer = new IndexerService(config);
      
      // Set up event listeners
      indexer.on('progress', (metrics) => {
        this.emit('indexer:progress', { chain: chainName, metrics });
      });

      indexer.on('error', (error) => {
        logger.error(`Indexer error on ${chainName}:`, error);
        this.emit('indexer:error', { chain: chainName, error });
        this.handleIndexerError(chainName, error);
      });

      indexer.on('stopped', () => {
        logger.warn(`Indexer stopped for ${chainName}`);
        this.emit('indexer:stopped', { chain: chainName });
      });

      // Start the indexer
      await indexer.start();
      this.indexers.set(chainName, indexer);
      
      logger.info(`✅ Indexer started for ${chainName}`);
    } catch (error) {
      logger.error(`Failed to start indexer for ${chainName}:`, error);
      this.emit('indexer:failed', { chain: chainName, error });
    }
  }

  /**
   * Handle indexer errors with recovery logic
   */
  private async handleIndexerError(chainName: string, error: any): Promise<void> {
    const indexer = this.indexers.get(chainName);
    if (!indexer) return;

    // Log the error
    logger.error(`Handling error for ${chainName} indexer:`, error);

    // Attempt to restart after delay
    setTimeout(async () => {
      if (!this.isRunning) return;
      
      logger.info(`Attempting to restart ${chainName} indexer...`);
      const config = CHAIN_CONFIGS[chainName as keyof typeof CHAIN_CONFIGS];
      if (config) {
        await this.startIndexer(chainName, config);
      }
    }, 30000); // Wait 30 seconds before restart
  }

  /**
   * Start monitoring all indexers
   */
  private startMonitoring(): void {
    this.monitoringInterval = setInterval(() => {
      const status = this.getStatus();
      
      // Log overall status
      const runningCount = Object.values(status.indexers)
        .filter(i => i.status === 'running').length;
      const totalBlocks = Object.values(status.indexers)
        .reduce((sum, i) => sum + (i.metrics?.blocksProcessed || 0), 0);
      const totalEvents = Object.values(status.indexers)
        .reduce((sum, i) => sum + (i.metrics?.eventsProcessed || 0), 0);

      logger.info(
        `Orchestrator Status: ${runningCount}/${this.indexers.size} indexers running, ` +
        `${totalBlocks} blocks processed, ${totalEvents} events processed`
      );

      this.emit('status', status);
    }, 60000); // Every minute
  }

  /**
   * Stop all indexers gracefully
   */
  async stop(): Promise<void> {
    logger.info('Stopping Indexer Orchestrator...');
    this.isRunning = false;

    // Stop monitoring
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
    }

    // Stop all indexers
    const stopPromises = Array.from(this.indexers.entries()).map(
      async ([chainName, indexer]) => {
        logger.info(`Stopping indexer for ${chainName}...`);
        await indexer.stop();
      }
    );

    await Promise.all(stopPromises);
    this.indexers.clear();

    logger.info('✅ Orchestrator stopped');
    this.emit('stopped');
  }

  /**
   * Get current status of all indexers
   */
  getStatus(): OrchestratorStatus {
    const indexers: OrchestratorStatus['indexers'] = {};

    for (const [chainName, indexer] of this.indexers.entries()) {
      indexers[chainName] = {
        status: 'running', // TODO: Track actual status
        metrics: indexer.getMetrics(),
      };
    }

    return {
      running: this.isRunning,
      startTime: this.startTime,
      indexers,
    };
  }

  /**
   * Get metrics for a specific chain
   */
  getChainMetrics(chainName: string): IndexerMetrics | undefined {
    const indexer = this.indexers.get(chainName);
    return indexer?.getMetrics();
  }

  /**
   * Restart a specific indexer
   */
  async restartIndexer(chainName: string): Promise<void> {
    logger.info(`Restarting indexer for ${chainName}...`);
    
    const indexer = this.indexers.get(chainName);
    if (indexer) {
      await indexer.stop();
      this.indexers.delete(chainName);
    }

    const config = CHAIN_CONFIGS[chainName as keyof typeof CHAIN_CONFIGS];
    if (config) {
      await this.startIndexer(chainName, config);
    }
  }
}

// Singleton instance
let orchestratorInstance: IndexerOrchestrator | null = null;

export function getOrchestrator(): IndexerOrchestrator {
  if (!orchestratorInstance) {
    orchestratorInstance = new IndexerOrchestrator();
  }
  return orchestratorInstance;
}

export default IndexerOrchestrator;