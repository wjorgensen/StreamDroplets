import { createPublicClient, http, PublicClient } from 'viem';
import { mainnet } from 'viem/chains';
import { createLogger } from './logger';

const logger = createLogger('RPCManager');

export class RPCManager {
  private apiKeys: string[] = [];
  private currentKeyIndex = 0;
  private requestCounts: Map<string, number> = new Map();
  private resetInterval: NodeJS.Timeout;
  private ethBaseUrl: string;
  private sonicBaseUrl: string;
  
  constructor() {
    // Load API keys from environment
    const key1 = process.env.ALCHEMY_API_KEY_1;
    const key2 = process.env.ALCHEMY_API_KEY_2;
    const key3 = process.env.ALCHEMY_API_KEY_3;
    
    if (key1) this.apiKeys.push(key1);
    if (key2 && key2 !== 'your_second_api_key_here') this.apiKeys.push(key2);
    if (key3 && key3 !== 'your_third_api_key_here') this.apiKeys.push(key3);
    
    if (this.apiKeys.length === 0) {
      // Fallback to legacy RPC URLs
      logger.warn('No API keys configured, using legacy RPC URLs');
      this.apiKeys = [''];
    }
    
    this.ethBaseUrl = process.env.ALCHEMY_ETH_BASE_URL || 'https://eth-mainnet.g.alchemy.com/v2/';
    this.sonicBaseUrl = process.env.ALCHEMY_SONIC_BASE_URL || 'https://sonic-mainnet.g.alchemy.com/v2/';
    
    // Reset request counts every minute
    this.resetInterval = setInterval(() => {
      this.requestCounts.clear();
    }, 60000);
    
    logger.info(`Initialized with ${this.apiKeys.length} API key(s)`);
  }
  
  /**
   * Get the next available RPC URL with load balancing
   */
  private getNextRpcUrl(chain: 'ethereum' | 'sonic'): string {
    if (this.apiKeys.length === 1) {
      // Single key or legacy mode
      if (this.apiKeys[0] === '') {
        // Legacy mode - use full URLs from env
        return chain === 'ethereum' 
          ? process.env.ALCHEMY_ETH_RPC || ''
          : process.env.ALCHEMY_SONIC_RPC || '';
      }
      const baseUrl = chain === 'ethereum' ? this.ethBaseUrl : this.sonicBaseUrl;
      return `${baseUrl}${this.apiKeys[0]}`;
    }
    
    // Multiple keys - rotate based on usage
    const key = this.apiKeys[this.currentKeyIndex];
    const keyCount = this.requestCounts.get(key) || 0;
    
    // If current key has high usage, try to rotate
    if (keyCount > 100) {
      const nextIndex = (this.currentKeyIndex + 1) % this.apiKeys.length;
      const nextKey = this.apiKeys[nextIndex];
      const nextCount = this.requestCounts.get(nextKey) || 0;
      
      // Only rotate if next key has lower usage
      if (nextCount < keyCount) {
        this.currentKeyIndex = nextIndex;
        logger.debug(`Rotating to API key ${nextIndex + 1}`);
      }
    }
    
    // Track usage
    const selectedKey = this.apiKeys[this.currentKeyIndex];
    this.requestCounts.set(selectedKey, (this.requestCounts.get(selectedKey) || 0) + 1);
    
    const baseUrl = chain === 'ethereum' ? this.ethBaseUrl : this.sonicBaseUrl;
    return `${baseUrl}${selectedKey}`;
  }
  
  /**
   * Create a public client with automatic key rotation
   */
  createClient(chain: 'ethereum' | 'sonic' = 'ethereum'): PublicClient {
    const rpcUrl = this.getNextRpcUrl(chain);
    
    return createPublicClient({
      chain: chain === 'ethereum' ? mainnet : mainnet, // Update when Sonic chain is available
      transport: http(rpcUrl, {
        retryCount: 3,
        retryDelay: 1000,
      }),
      batch: {
        multicall: true,
      }
    }) as PublicClient;
  }
  
  /**
   * Get all available RPC URLs for parallel requests
   */
  getAllRpcUrls(chain: 'ethereum' | 'sonic' = 'ethereum'): string[] {
    if (this.apiKeys.length === 1 && this.apiKeys[0] === '') {
      // Legacy mode
      return [chain === 'ethereum' 
        ? process.env.ALCHEMY_ETH_RPC || ''
        : process.env.ALCHEMY_SONIC_RPC || ''];
    }
    
    const baseUrl = chain === 'ethereum' ? this.ethBaseUrl : this.sonicBaseUrl;
    return this.apiKeys.map(key => `${baseUrl}${key}`);
  }
  
  /**
   * Create multiple clients for parallel requests
   */
  createParallelClients(chain: 'ethereum' | 'sonic' = 'ethereum'): PublicClient[] {
    const urls = this.getAllRpcUrls(chain);
    
    return urls.map(url => 
      createPublicClient({
        chain: chain === 'ethereum' ? mainnet : mainnet,
        transport: http(url, {
          retryCount: 2,
          retryDelay: 500,
        }),
        batch: {
          multicall: true,
        }
      }) as PublicClient
    );
  }
  
  /**
   * Get current usage statistics
   */
  getStats() {
    const stats: any = {
      totalKeys: this.apiKeys.length,
      currentKeyIndex: this.currentKeyIndex,
      requestCounts: {}
    };
    
    this.apiKeys.forEach((key, index) => {
      const maskedKey = key ? `${key.substring(0, 6)}...` : 'legacy';
      stats.requestCounts[`key${index + 1}_${maskedKey}`] = this.requestCounts.get(key) || 0;
    });
    
    return stats;
  }
  
  /**
   * Cleanup
   */
  destroy() {
    if (this.resetInterval) {
      clearInterval(this.resetInterval);
    }
  }
}

// Singleton instance
let rpcManager: RPCManager | null = null;

export function getRPCManager(): RPCManager {
  if (!rpcManager) {
    rpcManager = new RPCManager();
  }
  return rpcManager;
}

export function destroyRPCManager() {
  if (rpcManager) {
    rpcManager.destroy();
    rpcManager = null;
  }
}