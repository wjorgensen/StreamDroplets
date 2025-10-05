import { Alchemy, Network } from 'alchemy-sdk';
import { createPublicClient, http, PublicClient } from 'viem';
import { createLogger } from './logger';
import { SUPPORTED_CHAINS } from '../config/contracts';
import { CONSTANTS } from '../config/constants';
import { config } from '../config';

const logger = createLogger('AlchemyService');

/**
 * Centralized Alchemy instance management service
 * Creates and manages Alchemy SDK instances for all supported chains
 */
export class AlchemyService {
  private static instance: AlchemyService;
  private alchemyInstances = new Map<number, Alchemy>();
  private fallbackAlchemyInstances = new Map<number, Alchemy>();
  private viemClients = new Map<number, PublicClient>();
  private fallbackViemClients = new Map<number, PublicClient>();
  private usingFallback = false;

  private constructor() {
    this.initializeAlchemyInstances();
  }

  public static getInstance(): AlchemyService {
    if (!AlchemyService.instance) {
      AlchemyService.instance = new AlchemyService();
    }
    return AlchemyService.instance;
  }

  /**
   * Initializes Alchemy instances and viem clients for all supported chains
   */
  private initializeAlchemyInstances(): void {
    const apiKey = config.apiKeys.alchemy;
    if (!apiKey) {
      throw new Error('ALCHEMY_API_KEY environment variable is required');
    }

    const chainNetworkMap = Object.values(SUPPORTED_CHAINS).reduce((acc, chainConfig) => {
      acc[chainConfig.chainId] = chainConfig.alchemyNetwork;
      return acc;
    }, {} as Record<number, Network>);

    for (const [chainId, network] of Object.entries(chainNetworkMap)) {
      const chainIdNum = parseInt(chainId);
      
      this.alchemyInstances.set(chainIdNum, new Alchemy({
        apiKey,
        network: network as Network,
      }));

      const rpcUrl = this.getAlchemyRpcUrl(network, apiKey);
      try {
        this.viemClients.set(chainIdNum, createPublicClient({
          transport: http(rpcUrl)
        }));
      } catch (error) {
        logger.warn(`Failed to create viem client for chainId ${chainIdNum}:`, error);
      }
    }

    const fallbackApiKey = config.apiKeys.alchemyFallback;
    if (fallbackApiKey) {
      for (const [chainId, network] of Object.entries(chainNetworkMap)) {
        const chainIdNum = parseInt(chainId);
        
        this.fallbackAlchemyInstances.set(chainIdNum, new Alchemy({
          apiKey: fallbackApiKey,
          network: network as Network,
        }));

        const rpcUrl = this.getAlchemyRpcUrl(network, fallbackApiKey);
        try {
          this.fallbackViemClients.set(chainIdNum, createPublicClient({
            transport: http(rpcUrl)
          }));
        } catch (error) {
          logger.warn(`Failed to create fallback viem client for chainId ${chainIdNum}:`, error);
        }
      }
      
      logger.info(`Initialized Alchemy instances and viem clients for ${this.alchemyInstances.size} chains with fallback support`);
    } else {
      logger.info(`Initialized Alchemy instances and viem clients for ${this.alchemyInstances.size} chains (no fallback key provided)`);
    }
  }

  /**
   * Gets Alchemy RPC URL for a given network
   */
  private getAlchemyRpcUrl(network: Network, apiKey: string): string {
    if (network === ('plasma-mainnet' as any)) {
      return `${CONSTANTS.ALCHEMY_BASE_URLS.PLASMA}${apiKey}`;
    }
    
    const rpcUrls: Partial<Record<Network, string>> = {
      [Network.ETH_MAINNET]: `${CONSTANTS.ALCHEMY_BASE_URLS.ETHEREUM}${apiKey}`,
      [Network.SONIC_MAINNET]: `${CONSTANTS.ALCHEMY_BASE_URLS.SONIC}${apiKey}`,
      [Network.AVAX_MAINNET]: `${CONSTANTS.ALCHEMY_BASE_URLS.AVALANCHE}${apiKey}`,
      [Network.BASE_MAINNET]: `${CONSTANTS.ALCHEMY_BASE_URLS.BASE}${apiKey}`,
      [Network.ARB_MAINNET]: `${CONSTANTS.ALCHEMY_BASE_URLS.ARBITRUM}${apiKey}`,
      [Network.BERACHAIN_MAINNET]: `${CONSTANTS.ALCHEMY_BASE_URLS.BERACHAIN}${apiKey}`,
      [Network.LINEA_MAINNET]: `${CONSTANTS.ALCHEMY_BASE_URLS.LINEA}${apiKey}`,
      [Network.MATIC_MAINNET]: `${CONSTANTS.ALCHEMY_BASE_URLS.POLYGON}${apiKey}`,
      [Network.BNB_MAINNET]: `${CONSTANTS.ALCHEMY_BASE_URLS.BNB}${apiKey}`,
    };
    
    const rpcUrl = rpcUrls[network];
    if (!rpcUrl) {
      throw new Error(`No RPC URL configured for network ${network}`);
    }
    
    return rpcUrl;
  }

  /**
   * Switches to fallback API key if available
   */
  public switchToFallback(): boolean {
    if (this.fallbackAlchemyInstances.size === 0) {
      logger.warn('No fallback API key available, cannot switch');
      return false;
    }
    
    this.usingFallback = true;
    logger.info('Switched to fallback Alchemy API key');
    return true;
  }

  /**
   * Switches back to primary API key
   */
  public switchToPrimary(): void {
    this.usingFallback = false;
    logger.info('Switched back to primary Alchemy API key');
  }

  /**
   * Checks if currently using fallback
   */
  public isUsingFallback(): boolean {
    return this.usingFallback;
  }

  /**
   * Gets Alchemy instance for a specific chain
   */
  public getAlchemyInstance(chainId: number): Alchemy {
    const instanceMap = this.usingFallback ? this.fallbackAlchemyInstances : this.alchemyInstances;
    const instance = instanceMap.get(chainId);
    if (!instance) {
      if (this.usingFallback) {
        const primaryInstance = this.alchemyInstances.get(chainId);
        if (primaryInstance) {
          logger.warn(`Fallback Alchemy instance not found for chain ${chainId}, using primary`);
          return primaryInstance;
        }
      }
      throw new Error(`No Alchemy instance configured for chain ${chainId}`);
    }
    return instance;
  }

  /**
   * Gets viem PublicClient for a specific chain
   */
  public getViemClient(chainId: number): PublicClient {
    const clientMap = this.usingFallback ? this.fallbackViemClients : this.viemClients;
    const client = clientMap.get(chainId);
    if (!client) {
      if (this.usingFallback) {
        const primaryClient = this.viemClients.get(chainId);
        if (primaryClient) {
          logger.warn(`Fallback viem client not found for chain ${chainId}, using primary`);
          return primaryClient;
        }
      }
      throw new Error(`No viem client configured for chain ${chainId}`);
    }
    return client;
  }

  /**
   * Gets all Alchemy instances as a Map
   */
  public getAllAlchemyInstances(): Map<number, Alchemy> {
    return new Map(this.alchemyInstances);
  }

  /**
   * Gets all viem clients as a Map
   */
  public getAllViemClients(): Map<number, PublicClient> {
    return new Map(this.viemClients);
  }

  /**
   * Gets supported chain IDs
   */
  public getSupportedChainIds(): number[] {
    return Array.from(this.alchemyInstances.keys());
  }
}
