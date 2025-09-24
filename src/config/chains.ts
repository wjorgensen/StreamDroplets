/**
 * Chain-specific configurations for Stream Droplets Tracker
 * Production-ready chain configurations with deployment information
 */

import { Chain } from 'viem';
import { mainnet, base, arbitrum, avalanche } from 'viem/chains';

// Validate required environment variables at startup
function validateEnvVar(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value;
}

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
    `${process.env.ALCHEMY_ETH_BASE_URL}${process.env.ALCHEMY_API_KEY_1}`,
    `${process.env.ALCHEMY_ETH_BASE_URL}${process.env.ALCHEMY_API_KEY_2}`,
    `${process.env.ALCHEMY_ETH_BASE_URL}${process.env.ALCHEMY_API_KEY_3}`,
  ].filter(url => {
    if (!url || url.includes('undefined')) {
      throw new Error('Missing ALCHEMY_ETH_BASE_URL or ALCHEMY_API_KEY in environment');
    }
    return true;
  }),
  vaults: {
    xETH: {
      address: validateEnvVar('XETH_VAULT_ETH'),
      deploymentBlock: parseInt(validateEnvVar('XETH_VAULT_ETH_DEPLOY_BLOCK')),
      firstRound: 1,
    },
    xBTC: {
      address: validateEnvVar('XBTC_VAULT_ETH'),
      deploymentBlock: parseInt(validateEnvVar('XBTC_VAULT_ETH_DEPLOY_BLOCK')),
      firstRound: 1,
    },
    xUSD: {
      address: validateEnvVar('XUSD_VAULT_ETH'),
      deploymentBlock: parseInt(validateEnvVar('XUSD_VAULT_ETH_DEPLOY_BLOCK')),
      firstRound: 1,
    },
    xEUR: {
      address: validateEnvVar('XEUR_VAULT_ETH'),
      deploymentBlock: parseInt(validateEnvVar('XEUR_VAULT_ETH_DEPLOY_BLOCK')),
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
const sonicChain = {
  id: 146,
  name: 'Sonic',
  nativeCurrency: {
    decimals: 18,
    name: 'Sonic',
    symbol: 'S',
  },
  rpcUrls: {
    default: { http: [] }, // Will be populated from config rpcEndpoints
    public: { http: [] },   // Will be populated from config rpcEndpoints
  },
} as const;

export const sonicConfig: ChainConfig = {
  chain: sonicChain,
  chainId: 146,
  name: 'Sonic',
  rpcEndpoints: [
    `${process.env.ALCHEMY_SONIC_BASE_URL}${process.env.ALCHEMY_API_KEY_1}`,
    `${process.env.ALCHEMY_SONIC_BASE_URL}${process.env.ALCHEMY_API_KEY_2}`,
    `${process.env.ALCHEMY_SONIC_BASE_URL}${process.env.ALCHEMY_API_KEY_3}`,
  ].filter(url => {
    if (!url || url.includes('undefined')) {
      throw new Error('Missing ALCHEMY_SONIC_BASE_URL or ALCHEMY_API_KEY in environment');
    }
    return true;
  }),
  vaults: {
    xETH: {
      address: validateEnvVar('XETH_OFT_SONIC'),
      deploymentBlock: parseInt(validateEnvVar('XETH_OFT_SONIC_DEPLOY_BLOCK')),
      firstRound: 1,
    },
    xBTC: {
      address: validateEnvVar('XBTC_OFT_SONIC'),
      deploymentBlock: parseInt(validateEnvVar('XBTC_OFT_SONIC_DEPLOY_BLOCK')),
      firstRound: 1,
    },
    xUSD: {
      address: validateEnvVar('XUSD_OFT_SONIC'),
      deploymentBlock: parseInt(validateEnvVar('XUSD_OFT_SONIC_DEPLOY_BLOCK')),
      firstRound: 1,
    },
    xEUR: {
      address: validateEnvVar('XEUR_OFT_SONIC'),
      deploymentBlock: parseInt(validateEnvVar('XEUR_OFT_SONIC_DEPLOY_BLOCK')),
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

// Base Chain Configuration
export const baseConfig: ChainConfig = {
  chain: base,
  chainId: 8453,
  name: 'Base',
  rpcEndpoints: [
    `${process.env.ALCHEMY_BASE_URL}${process.env.ALCHEMY_API_KEY_1}`,
    `${process.env.ALCHEMY_BASE_URL}${process.env.ALCHEMY_API_KEY_2}`,
    `${process.env.ALCHEMY_BASE_URL}${process.env.ALCHEMY_API_KEY_3}`,
  ].filter(url => {
    if (!url || url.includes('undefined')) {
      throw new Error('Missing ALCHEMY_BASE_URL or ALCHEMY_API_KEY in environment');
    }
    return true;
  }),
  vaults: {
    xETH: {
      address: validateEnvVar('XETH_OFT_BASE'),
      deploymentBlock: parseInt(validateEnvVar('XETH_OFT_BASE_DEPLOY_BLOCK')),
      firstRound: 1,
    },
    xBTC: {
      address: validateEnvVar('XBTC_OFT_BASE'),
      deploymentBlock: parseInt(validateEnvVar('XBTC_OFT_BASE_DEPLOY_BLOCK')),
      firstRound: 1,
    },
    xUSD: {
      address: validateEnvVar('XUSD_OFT_BASE'),
      deploymentBlock: parseInt(validateEnvVar('XUSD_OFT_BASE_DEPLOY_BLOCK')),
      firstRound: 1,
    },
    xEUR: {
      address: validateEnvVar('XEUR_OFT_BASE'),
      deploymentBlock: parseInt(validateEnvVar('XEUR_OFT_BASE_DEPLOY_BLOCK')),
      firstRound: 1,
    },
  },
  confirmations: parseInt(process.env.BASE_CONFIRMATIONS || '6'),
  batchSize: 1000,
  retryConfig: {
    retryCount: 3,
    retryDelay: 2000,
    backoffMultiplier: 1.5,
  },
};

// Arbitrum Chain Configuration
export const arbitrumConfig: ChainConfig = {
  chain: arbitrum,
  chainId: 42161,
  name: 'Arbitrum',
  rpcEndpoints: [
    `${process.env.ALCHEMY_ARB_URL}${process.env.ALCHEMY_API_KEY_1}`,
    `${process.env.ALCHEMY_ARB_URL}${process.env.ALCHEMY_API_KEY_2}`,
    `${process.env.ALCHEMY_ARB_URL}${process.env.ALCHEMY_API_KEY_3}`,
  ].filter(url => {
    if (!url || url.includes('undefined')) {
      throw new Error('Missing ALCHEMY_ARB_URL or ALCHEMY_API_KEY in environment');
    }
    return true;
  }),
  vaults: {
    xETH: {
      address: validateEnvVar('XETH_OFT_ARB'),
      deploymentBlock: parseInt(validateEnvVar('XETH_OFT_ARB_DEPLOY_BLOCK')),
      firstRound: 1,
    },
    xBTC: {
      address: validateEnvVar('XBTC_OFT_ARB'),
      deploymentBlock: parseInt(validateEnvVar('XBTC_OFT_ARB_DEPLOY_BLOCK')),
      firstRound: 1,
    },
    xUSD: {
      address: validateEnvVar('XUSD_OFT_ARB'),
      deploymentBlock: parseInt(validateEnvVar('XUSD_OFT_ARB_DEPLOY_BLOCK')),
      firstRound: 1,
    },
    xEUR: {
      address: validateEnvVar('XEUR_OFT_ARB'),
      deploymentBlock: parseInt(validateEnvVar('XEUR_OFT_ARB_DEPLOY_BLOCK')),
      firstRound: 1,
    },
  },
  confirmations: parseInt(process.env.ARB_CONFIRMATIONS || '6'),
  batchSize: 1000,
  retryConfig: {
    retryCount: 3,
    retryDelay: 2000,
    backoffMultiplier: 1.5,
  },
};

// Avalanche Chain Configuration
export const avalancheConfig: ChainConfig = {
  chain: avalanche,
  chainId: 43114,
  name: 'Avalanche',
  rpcEndpoints: [
    `${process.env.ALCHEMY_AVAX_URL}${process.env.ALCHEMY_API_KEY_1}`,
    `${process.env.ALCHEMY_AVAX_URL}${process.env.ALCHEMY_API_KEY_2}`,
    `${process.env.ALCHEMY_AVAX_URL}${process.env.ALCHEMY_API_KEY_3}`,
  ].filter(url => {
    if (!url || url.includes('undefined')) {
      throw new Error('Missing ALCHEMY_AVAX_URL or ALCHEMY_API_KEY in environment');
    }
    return true;
  }),
  vaults: {
    xETH: {
      address: validateEnvVar('XETH_OFT_AVAX'),
      deploymentBlock: parseInt(validateEnvVar('XETH_OFT_AVAX_DEPLOY_BLOCK')),
      firstRound: 1,
    },
    xBTC: {
      address: validateEnvVar('XBTC_OFT_AVAX'),
      deploymentBlock: parseInt(validateEnvVar('XBTC_OFT_AVAX_DEPLOY_BLOCK')),
      firstRound: 1,
    },
    xUSD: {
      address: validateEnvVar('XUSD_OFT_AVAX'),
      deploymentBlock: parseInt(validateEnvVar('XUSD_OFT_AVAX_DEPLOY_BLOCK')),
      firstRound: 1,
    },
    xEUR: {
      address: validateEnvVar('XEUR_OFT_AVAX'),
      deploymentBlock: parseInt(validateEnvVar('XEUR_OFT_AVAX_DEPLOY_BLOCK')),
      firstRound: 1,
    },
  },
  confirmations: parseInt(process.env.AVAX_CONFIRMATIONS || '2'),
  batchSize: 500,
  retryConfig: {
    retryCount: 3,
    retryDelay: 1000,
    backoffMultiplier: 1.5,
  },
};

// Berachain Configuration (Mainnet)
const berachainChain = {
  id: 80094,
  name: 'Berachain',
  nativeCurrency: {
    decimals: 18,
    name: 'BERA',
    symbol: 'BERA',
  },
  rpcUrls: {
    default: { http: [] }, // Will be populated from config rpcEndpoints
    public: { http: [] },   // Will be populated from config rpcEndpoints
  },
} as const;

export const berachainConfig: ChainConfig = {
  chain: berachainChain,
  chainId: 80094,
  name: 'Berachain',
  rpcEndpoints: (() => {
    const baseUrl = process.env.ALCHEMY_BERA_RPC;
    // Handle the case where BERA URL already includes /v2/
    const needsV2 = baseUrl && !baseUrl.endsWith('/v2/');
    const finalBase = needsV2 ? `${baseUrl}/` : baseUrl;
    
    return [
      `${finalBase}${process.env.ALCHEMY_API_KEY_1}`,
      `${finalBase}${process.env.ALCHEMY_API_KEY_2}`,
      `${finalBase}${process.env.ALCHEMY_API_KEY_3}`,
    ].filter(url => {
      if (!url || url.includes('undefined')) {
        throw new Error('Missing ALCHEMY_BERA_RPC or ALCHEMY_API_KEY in environment');
      }
      return true;
    });
  })(),
  vaults: {
    xETH: {
      address: validateEnvVar('XETH_OFT_BERA'),
      deploymentBlock: parseInt(validateEnvVar('XETH_OFT_BERA_DEPLOY_BLOCK')),
      firstRound: 1,
    },
    xBTC: {
      address: validateEnvVar('XBTC_OFT_BERA'),
      deploymentBlock: parseInt(validateEnvVar('XBTC_OFT_BERA_DEPLOY_BLOCK')),
      firstRound: 1,
    },
    xUSD: {
      address: validateEnvVar('XUSD_OFT_BERA'),
      deploymentBlock: parseInt(validateEnvVar('XUSD_OFT_BERA_DEPLOY_BLOCK')),
      firstRound: 1,
    },
    xEUR: {
      address: validateEnvVar('XEUR_OFT_BERA'),
      deploymentBlock: parseInt(validateEnvVar('XEUR_OFT_BERA_DEPLOY_BLOCK')),
      firstRound: 1,
    },
  },
  confirmations: parseInt(process.env.BERA_CONFIRMATIONS || '32'),
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
  base: baseConfig,
  arbitrum: arbitrumConfig,
  avalanche: avalancheConfig,
  berachain: berachainConfig,
} as const;

// Get chain config by ID
export function getChainConfig(chainId: number): ChainConfig | undefined {
  return Object.values(CHAIN_CONFIGS).find(config => config.chainId === chainId);
}

// Get all supported chain IDs
export function getSupportedChainIds(): number[] {
  return Object.values(CHAIN_CONFIGS).map(config => config.chainId);
}