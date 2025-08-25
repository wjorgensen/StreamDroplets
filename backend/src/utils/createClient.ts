import { createPublicClient, http, PublicClient } from 'viem';
import { mainnet } from 'viem/chains';
import { config } from '../config';
import { getRPCManager } from './rpcManager';

/**
 * Create a viem public client with RPC configuration
 * Automatically uses RPC manager if multiple API keys are configured
 */
export function createClient(chain: 'ethereum' | 'sonic' = 'ethereum'): PublicClient {
  // Check if multiple API keys are configured
  if (config.rpc.apiKeys && config.rpc.apiKeys.length > 0) {
    // Use RPC manager for automatic key rotation
    return getRPCManager().createClient(chain);
  }
  
  // Fallback to single RPC URL
  const rpcUrl = chain === 'ethereum' ? config.rpc.ethereum : config.rpc.sonic;
  
  return createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl),
    batch: {
      multicall: true,
    }
  });
}

/**
 * Create multiple clients for parallel requests
 * Uses all available API keys simultaneously
 */
export function createParallelClients(chain: 'ethereum' | 'sonic' = 'ethereum'): PublicClient[] {
  // Check if multiple API keys are configured
  if (config.rpc.apiKeys && config.rpc.apiKeys.length > 1) {
    // Use RPC manager to create parallel clients
    return getRPCManager().createParallelClients(chain);
  }
  
  // Fallback to single client
  return [createClient(chain)];
}