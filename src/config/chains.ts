/**
 * Chain-specific configurations for Stream Droplets Tracker
 * Production-ready chain configurations with deployment information
 */

import { Chain } from 'viem';
import { mainnet, sonic } from 'viem/chains';

export interface VaultDeployment {
  address: string;
  deploymentBlock: number;
  firstRound: number;
}

export interface ChainConfig {
  chain: Chain;
  chainId: number;
  name: string;
  rpcEndpoints: string[];
  vaults: Record<string, VaultDeployment>;
  confirmations: number;
  batchSize: number;
  retryConfig: {
    retryCount: number;
    retryDelay: number;
    backoffMultiplier: number;
  };
}

// Ethereum Mainnet Configuration
export const ethereumConfig: ChainConfig = {
  chain: mainnet,
  chainId: 1,
  name: 'Ethereum',
  rpcEndpoints: [
    process.env.ALCHEMY_ETH_RPC || `${process.env.ALCHEMY_ETH_BASE_URL}${process.env.ALCHEMY_API_KEY_1}`,
    // Add fallback endpoints for production resilience
    `${process.env.ALCHEMY_ETH_BASE_URL}${process.env.ALCHEMY_API_KEY_2}`,
    `${process.env.ALCHEMY_ETH_BASE_URL}${process.env.ALCHEMY_API_KEY_3}`,
  ].filter(Boolean),
  vaults: {
    xETH: {
      address: process.env.XETH_VAULT_ETH || '0x7E586fBaF3084C0be7aB5C82C04FfD7592723153',
      deploymentBlock: 21872329,
      firstRound: 1,
    },
    xBTC: {
      address: process.env.XBTC_VAULT_ETH || '0x12fd502e2052CaFB41eccC5B596023d9978057d6',
      deploymentBlock: 21872534,
      firstRound: 1,
    },
    xUSD: {
      address: process.env.XUSD_VAULT_ETH || '0xE2Fc85BfB48C4cF147921fBE110cf92Ef9f26F94',
      deploymentBlock: 21871574,
      firstRound: 1,
    },
    xEUR: {
      address: process.env.XEUR_VAULT_ETH || '0xc15697f61170Fc3Bb4e99Eb7913b4C7893F64F13',
      deploymentBlock: 22999283,
      firstRound: 1,
    },
  },
  confirmations: parseInt(process.env.ETH_CONFIRMATIONS || '12'),
  batchSize: 1000,
  retryConfig: {
    retryCount: 5,
    retryDelay: 2000,
    backoffMultiplier: 1.5,
  },
};

// Sonic Chain Configuration
export const sonicConfig: ChainConfig = {
  chain: sonic as Chain,
  chainId: 146,
  name: 'Sonic',
  rpcEndpoints: [
    process.env.ALCHEMY_SONIC_RPC || 'https://rpc.soniclabs.com',
    'https://rpc.soniclabs.com', // Public RPC as fallback
  ].filter(Boolean),
  vaults: {
    xETH: {
      address: process.env.XETH_VAULT_SONIC || '0x16af6b1315471Dc306D47e9CcEfEd6e5996285B6',
      deploymentBlock: 100000000, // TODO: Find actual deployment blocks for Sonic
      firstRound: 1,
    },
    xBTC: {
      address: process.env.XBTC_VAULT_SONIC || '0xB88fF15ae5f82c791e637b27337909BcF8065270',
      deploymentBlock: 100000000,
      firstRound: 1,
    },
    xUSD: {
      address: process.env.XUSD_VAULT_SONIC || '0x6202B9f02E30E5e1c62Cc01E4305450E5d83b926',
      deploymentBlock: 100000000,
      firstRound: 1,
    },
    xEUR: {
      address: process.env.XEUR_VAULT_SONIC || '0x931383c1bCA6a41E931f2519BAe8D716857F156c',
      deploymentBlock: 100000000,
      firstRound: 1,
    },
  },
  confirmations: parseInt(process.env.SONIC_CONFIRMATIONS || '32'),
  batchSize: 500,
  retryConfig: {
    retryCount: 3,
    retryDelay: 3000,
    backoffMultiplier: 2,
  },
};

// Get the earliest deployment block across all vaults for a chain
export function getEarliestDeploymentBlock(config: ChainConfig): number {
  return Math.min(...Object.values(config.vaults).map(v => v.deploymentBlock));
}

// Export all chain configurations
export const CHAIN_CONFIGS = {
  ethereum: ethereumConfig,
  sonic: sonicConfig,
} as const;

// Get chain config by ID
export function getChainConfig(chainId: number): ChainConfig | undefined {
  return Object.values(CHAIN_CONFIGS).find(config => config.chainId === chainId);
}

// Get all supported chain IDs
export function getSupportedChainIds(): number[] {
  return Object.values(CHAIN_CONFIGS).map(config => config.chainId);
}