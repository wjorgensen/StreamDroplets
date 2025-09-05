import { Network } from 'alchemy-sdk';
import { AlchemyOptimizedIndexer } from './indexer/AlchemyOptimizedIndexer';
import { IntegrationIndexer } from './indexer/IntegrationIndexer';
import { startServer } from './api/server';
import { createLogger } from './utils/logger';
import { testConnection } from './db/connection';
import dotenv from 'dotenv';

dotenv.config();

const logger = createLogger('Main');

// Helper to get network enum or string for Alchemy
function getAlchemyNetwork(chainId: number): Network | string {
  switch (chainId) {
    case 1: return Network.ETH_MAINNET;
    case 146: return 'sonic-mainnet'; // Sonic not in SDK enum yet
    case 8453: return Network.BASE_MAINNET;
    case 42161: return Network.ARB_MAINNET;
    case 43114: return 'avalanche-mainnet'; // Avalanche string
    case 81457: return 'berachain-mainnet'; // Berachain string
    default: throw new Error(`Unsupported chain ID: ${chainId}`);
  }
}

// Build contract configurations for each chain
function buildChainContracts(chainId: number): any[] {
  const contracts = [];
  
  // Helper to add contract if address exists and not zero
  const addContract = (address: string | undefined, symbol: string, startBlock: number) => {
    if (address && address !== '0x0000000000000000000000000000000000000000') {
      contracts.push({
        address,
        symbol,
        chainId,
        startBlock,
      });
    }
  };

  switch (chainId) {
    case 1: // Ethereum - Vault contracts
      addContract(process.env.XETH_VAULT_ETH, 'xETH', 19000000);
      addContract(process.env.XBTC_VAULT_ETH, 'xBTC', 19000000);
      addContract(process.env.XUSD_VAULT_ETH, 'xUSD', 19000000);
      addContract(process.env.XEUR_VAULT_ETH, 'xEUR', 19000000);
      break;
      
    case 146: // Sonic - OFT contracts
      addContract(process.env.XETH_OFT_SONIC, 'xETH', 0);
      addContract(process.env.XBTC_OFT_SONIC, 'xBTC', 0);
      addContract(process.env.XUSD_OFT_SONIC, 'xUSD', 0);
      addContract(process.env.XEUR_OFT_SONIC, 'xEUR', 0);
      break;
      
    case 8453: // Base - OFT contracts
      addContract(process.env.XETH_OFT_BASE, 'xETH', 0);
      addContract(process.env.XBTC_OFT_BASE, 'xBTC', 0);
      addContract(process.env.XUSD_OFT_BASE, 'xUSD', 0);
      addContract(process.env.XEUR_OFT_BASE, 'xEUR', 0);
      break;
      
    case 42161: // Arbitrum - OFT contracts
      addContract(process.env.XETH_OFT_ARB, 'xETH', 0);
      addContract(process.env.XBTC_OFT_ARB, 'xBTC', 0);
      addContract(process.env.XUSD_OFT_ARB, 'xUSD', 0);
      addContract(process.env.XEUR_OFT_ARB, 'xEUR', 0);
      break;
      
    case 43114: // Avalanche - OFT contracts
      addContract(process.env.XETH_OFT_AVAX, 'xETH', 0);
      addContract(process.env.XBTC_OFT_AVAX, 'xBTC', 0);
      addContract(process.env.XUSD_OFT_AVAX, 'xUSD', 0);
      addContract(process.env.XEUR_OFT_AVAX, 'xEUR', 0);
      break;
      
    case 81457: // Berachain - OFT contracts
      addContract(process.env.XETH_OFT_BERA, 'xETH', 0);
      addContract(process.env.XBTC_OFT_BERA, 'xBTC', 0);
      addContract(process.env.XUSD_OFT_BERA, 'xUSD', 0);
      addContract(process.env.XEUR_OFT_BERA, 'xEUR', 0);
      break;
  }
  
  return contracts;
}

async function main() {
  try {
    logger.info('Starting Stream Droplets - Multi-Chain Indexer');
    
    // Test database connection
    const dbConnected = await testConnection();
    if (!dbConnected) {
      logger.error('Failed to connect to database');
      process.exit(1);
    }
    
    logger.info('Database connected');
    
    // Array to hold all indexers for cleanup
    const allIndexers: any[] = [];
    
    // Chain configurations
    const chains = [
      { id: 1, name: 'Ethereum', apiKeyEnv: 'ALCHEMY_API_KEY_1' },
      { id: 146, name: 'Sonic', apiKeyEnv: 'ALCHEMY_API_KEY_146' },
      { id: 8453, name: 'Base', apiKeyEnv: 'ALCHEMY_API_KEY_8453' },
      { id: 42161, name: 'Arbitrum', apiKeyEnv: 'ALCHEMY_API_KEY_42161' },
      { id: 43114, name: 'Avalanche', apiKeyEnv: 'ALCHEMY_API_KEY_43114' },
      { id: 81457, name: 'Berachain', apiKeyEnv: 'ALCHEMY_API_KEY_81457' },
    ];
    
    // Start indexer for each chain
    for (const chain of chains) {
      const apiKey = process.env[chain.apiKeyEnv];
      
      if (!apiKey) {
        logger.warn(`${chain.apiKeyEnv} not configured, skipping ${chain.name} indexer`);
        continue;
      }
      
      const contracts = buildChainContracts(chain.id);
      
      if (contracts.length === 0) {
        logger.warn(`No valid contracts configured for ${chain.name}`);
        continue;
      }
      
      logger.info(`Starting ${chain.name} indexer with ${contracts.length} contracts...`);
      
      try {
        const network = getAlchemyNetwork(chain.id);
        const indexer = new AlchemyOptimizedIndexer({
          apiKey,
          network: network as Network,
          contracts,
          batchSize: 5000,
          realtime: true,
        });
        
        // Setup event listeners
        indexer.on('started', () => {
          logger.info(`${chain.name} indexer started successfully`);
        });
        
        indexer.on('eventProcessed', ({ eventName, contract, blockNumber }) => {
          logger.debug(`[${chain.name}] Processed ${eventName} for ${contract} at block ${blockNumber}`);
        });
        
        indexer.on('pendingTransaction', ({ contract, hash }) => {
          logger.info(`[${chain.name}] Pending transaction for ${contract}: ${hash}`);
        });
        
        indexer.on('transactionMined', ({ contract, hash, status }) => {
          logger.info(`[${chain.name}] Transaction mined for ${contract}: ${hash} (status: ${status ? 'success' : 'failed'})`);
        });
        
        indexer.on('error', ({ contract, error }) => {
          logger.error(`[${chain.name}] Error indexing ${contract.symbol}:`, error);
        });
        
        // Start the indexer
        await indexer.start();
        allIndexers.push(indexer);
        
        logger.info(`${chain.name} indexer running with contracts:`, contracts.map(c => c.symbol).join(', '));
        
      } catch (error) {
        logger.error(`Failed to start ${chain.name} indexer:`, error);
      }
    }
    
    // Start Integration Indexers for supported chains
    const integrationIndexers: IntegrationIndexer[] = [];
    
    // Sonic chain integration indexer
    if (process.env.ALCHEMY_API_KEY_146) {
      logger.info('Starting Sonic integration indexer...');
      const sonicIntegrationIndexer = new IntegrationIndexer(146, process.env.ALCHEMY_API_KEY_146);
      
      sonicIntegrationIndexer.on('started', () => {
        logger.info('Sonic integration indexer started successfully');
      });
      
      sonicIntegrationIndexer.on('error', (error) => {
        logger.error('Sonic integration indexer error:', error);
      });
      
      await sonicIntegrationIndexer.start();
      integrationIndexers.push(sonicIntegrationIndexer);
    }
    
    // Avalanche chain integration indexer
    if (process.env.ALCHEMY_API_KEY_43114) {
      logger.info('Starting Avalanche integration indexer...');
      const avalancheIntegrationIndexer = new IntegrationIndexer(43114, process.env.ALCHEMY_API_KEY_43114);
      
      avalancheIntegrationIndexer.on('started', () => {
        logger.info('Avalanche integration indexer started successfully');
      });
      
      avalancheIntegrationIndexer.on('error', (error) => {
        logger.error('Avalanche integration indexer error:', error);
      });
      
      await avalancheIntegrationIndexer.start();
      integrationIndexers.push(avalancheIntegrationIndexer);
    }
    
    // Start the scheduler for daily snapshots
    const { SchedulerService } = await import('./services/SchedulerService');
    const scheduler = new SchedulerService();
    await scheduler.start();
    logger.info('Daily snapshot scheduler started');
    
    // Start the API server
    await startServer();
    
    // Log metrics periodically
    setInterval(async () => {
      for (const indexer of allIndexers) {
        try {
          const metrics = await indexer.getMetrics();
          logger.info('Indexer metrics:', metrics);
        } catch (error) {
          logger.error('Error getting metrics:', error);
        }
      }
      
      // Also log scheduler status
      const schedulerStatus = await scheduler.getStatus();
      logger.info('Scheduler status:', schedulerStatus);
    }, 60000); // Every minute
    
    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      logger.info('Shutting down gracefully...');
      scheduler.stop();
      for (const indexer of allIndexers) {
        await indexer.stop();
      }
      for (const integrationIndexer of integrationIndexers) {
        await integrationIndexer.stop();
      }
      process.exit(0);
    });
    
    process.on('SIGTERM', async () => {
      logger.info('Shutting down gracefully...');
      scheduler.stop();
      for (const indexer of allIndexers) {
        await indexer.stop();
      }
      for (const integrationIndexer of integrationIndexers) {
        await integrationIndexer.stop();
      }
      process.exit(0);
    });
    
    // Summary
    logger.info('=================================');
    logger.info('Stream Droplets is running!');
    logger.info(`API server: http://localhost:${process.env.API_PORT || 3000}`);
    logger.info(`Active chain indexers: ${allIndexers.length}`);
    logger.info(`Active integration indexers: ${integrationIndexers.length}`);
    logger.info('=================================');
    
  } catch (error: any) {
    logger.error('Failed to start application:', {
      message: error.message,
      stack: error.stack,
      error
    });
    process.exit(1);
  }
}

// Start the application
if (require.main === module) {
  main();
}