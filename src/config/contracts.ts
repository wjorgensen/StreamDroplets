import { getDb } from '../db/connection';
import { Network } from 'alchemy-sdk';
import { NetworkName } from './constants';

/************************************************************************
 * TYPE DEFINITIONS
 ************************************************************************/

export interface ChainConfig {
  chainId: number;
  name: string;
  alchemyNetwork: Network;
}

export interface ContractConfig {
  ethereum: string;
  sonic: string;
  base: string;
  arbitrum: string;
  avalanche: string;
  berachain: string;
  linea: string;
  polygon: string;
  bnb: string;
  plasma: string;
  oracleFeed: string;
  decimals: bigint;
  ppsScale: bigint;
}

/************************************************************************
 * CHAIN CONFIGURATION
 ************************************************************************/

export const SUPPORTED_CHAINS: Record<string, ChainConfig> = {
  ethereum: {
    chainId: 1,
    name: 'Ethereum',
    alchemyNetwork: Network.ETH_MAINNET,
  },
  sonic: {
    chainId: 146,
    name: 'Sonic',
    alchemyNetwork: Network.SONIC_MAINNET,
  },
  base: {
    chainId: 8453,
    name: 'Base',
    alchemyNetwork: Network.BASE_MAINNET,
  },
  arbitrum: {
    chainId: 42161,
    name: 'Arbitrum',
    alchemyNetwork: Network.ARB_MAINNET,
  },
  avalanche: {
    chainId: 43114,
    name: 'Avalanche',
    alchemyNetwork: Network.AVAX_MAINNET,
  },
  berachain: {
    chainId: 80094,
    name: 'Berachain',
    alchemyNetwork: Network.BERACHAIN_MAINNET,
  },
  linea: {
    chainId: 59144,
    name: 'Linea',
    alchemyNetwork: Network.LINEA_MAINNET,
  },
  polygon: {
    chainId: 137,
    name: 'Polygon',
    alchemyNetwork: Network.MATIC_MAINNET,
  },
  bnb: {
    chainId: 56,
    name: 'BNB Smart Chain',
    alchemyNetwork: Network.BNB_MAINNET,
  },
  plasma: {
    chainId: 9745,
    name: 'Plasma',
    alchemyNetwork: 'plasma-mainnet' as Network,
  },
} as const;

/**
 * Get all supported chain IDs from the contracts configuration
 */
export function getSupportedChainIds(): number[] {
  return Object.values(SUPPORTED_CHAINS).map(chain => chain.chainId);
}

/**
 * Get chain configuration by chain ID
 */
export function getChainConfig(chainId: number): ChainConfig | undefined {
  return Object.values(SUPPORTED_CHAINS).find(chain => chain.chainId === chainId);
}

/**
 * Get chain configuration by chain name
 */
export function getChainConfigByName(chainName: string): ChainConfig | undefined {
  return SUPPORTED_CHAINS[chainName];
}

/**
 * Convert Alchemy Network enum to network name string used by blockTime API
 */
export function networkToNetworkName(network: Network): NetworkName {
  // Handle Plasma network (not yet in SDK)
  if (network === ('plasma-mainnet' as any)) {
    return 'plasma-mainnet';
  }
  
  const networkMapping: Partial<Record<Network, NetworkName>> = {
    [Network.ETH_MAINNET]: 'eth-mainnet',
    [Network.SONIC_MAINNET]: 'sonic-mainnet',
    [Network.BASE_MAINNET]: 'base-mainnet',
    [Network.ARB_MAINNET]: 'arb-mainnet',
    [Network.AVAX_MAINNET]: 'avax-mainnet',
    [Network.BERACHAIN_MAINNET]: 'berachain-mainnet',
    [Network.LINEA_MAINNET]: 'linea-mainnet',
    [Network.MATIC_MAINNET]: 'polygon-mainnet',
    [Network.BNB_MAINNET]: 'bnb-mainnet',
  };
  
  const networkName = networkMapping[network];
  if (!networkName) {
    throw new Error(`Unsupported network: ${network}`);
  }
  
  return networkName;
}

/**
 * Get all supported network names for blockTime API
 */
export function getSupportedNetworkNames(): NetworkName[] {
  return Object.values(SUPPORTED_CHAINS).map(chain => networkToNetworkName(chain.alchemyNetwork));
}

/**
 * Get mapping from chain ID to network name
 */
export function getChainIdToNetworkNameMapping(): Record<number, NetworkName> {
  const mapping: Record<number, NetworkName> = {};
  for (const chain of Object.values(SUPPORTED_CHAINS)) {
    mapping[chain.chainId] = networkToNetworkName(chain.alchemyNetwork);
  }
  return mapping;
}

/************************************************************************
 * CONTRACT ABIS
 ************************************************************************/

// Re-export ABIs from dedicated files for backwards compatibility
export { STREAM_VAULT_ABI } from './abis/streamVault';
export { OFT_ABI } from './abis/oft';
export { CHAINLINK_AGGREGATOR_ABI } from './abis/chainlink';

// Integration contract ABIs
export { EULER_VAULT_ABI } from './abis/eulerVault';
export { SILO_VAULT_ABI } from './abis/siloVault';
export { SILO_ROUTER_ABI } from './abis/siloRouter';
export { ENCLABS_VTOKEN_ABI } from './abis/enclabsVToken';
export { STABILITY_POOL_ABI } from './abis/stabilityPool';
export { STABILITY_ATOKEN_ABI } from './abis/stabilityAToken';
export { SHADOW_PAIR_ABI, SHADOW_ROUTER_ABI } from './abis/shadowPair';






/************************************************************************
 * INTEGRATION CONTRACT ADDRESSES
 ************************************************************************/

export const INTEGRATION_CONTRACTS = {
  EULER_FINANCE: {
    SONIC: {
      XUSD_VAULT: '0xdEBdAB749330bb976fD10dc52f9A452aaF029028',
    },
  },
  SILO_FINANCE: {
    SONIC: {
      XUSD_VAULT_1: '0x596aeF68A03a0E35c4D8e624fBbdB0df0862F172',
      XUSD_VAULT_2: '0x172a687c397E315DBE56ED78aB347D7743D0D4fa',
      ROUTER: '0x9Fa3C1E843d8eb1387827E5d77c07E8BB97B1e50',
    },
    AVALANCHE: {
      XUSD_VAULT: '0xc380E5250d9718f8d9116Bc9d787A0229044e2EB', 
      ROUTER: '0x4576fa3e2E061376431619B5631C25c99fFa27bd',
    },
  },
  ENCLABS: {
    SONIC: {
      XUSD_VTOKEN: '0x13d79435F306D155CA2b9Af77234c84f80506045',
    },
  },
  STABILITY: {
    SONIC: {
      POOL: '0x1f672BD230D0FC2Ee9A75D2037a92CC1225A4Ad8',
      XUSD_ATOKEN: '0xD56cA83ad45976b3590B53AdE167DE27b89683D8', 
    },
  },
  SHADOW_EXCHANGE: {
    SONIC: {
      XUSD_HLP0_POOL: '0xdee813f080f9128e52e38e9ffef8b997f9544332',
      XUSD_ASONUSDC_POOL: '0xfead02fb16ec3b2f6318dca230198db73e99428c',
      ROUTER: '0x1d368773735ee1e678950b7a97bca2cafb330cdc',
    },
  },
} as const;

/**
 * Token position metadata for integration contracts that need it
 * Maps contract address to xUSD token position (0 = token0, 1 = token1)
 */
export const INTEGRATION_TOKEN_POSITIONS: Record<string, number> = {
  [INTEGRATION_CONTRACTS.SHADOW_EXCHANGE.SONIC.XUSD_HLP0_POOL.toLowerCase()]: 1,
} as const;

/************************************************************************
 * STREAM VAULT CONTRACTS
 ************************************************************************/

export const CONTRACTS: Record<string, ContractConfig> = {
  xETH: {
    ethereum: '0x7E586fBaF3084C0be7aB5C82C04FfD7592723153',
    sonic: '0x16af6b1315471Dc306D47e9CcEfEd6e5996285B6',
    base: '0x6202B9f02E30E5e1c62Cc01E4305450E5d83b926',
    arbitrum: '0x94f9bB5c972285728DCee7EAece48BeC2fF341ce',
    avalanche: '0x413bF752b33e76562dc876182141e2329716f250',
    berachain: '0x94f9bB5c972285728DCee7EAece48BeC2fF341ce',
    linea: '0x1e39413d695a9EEF1fB6dBe298D9ce0b7A9a065a',
    polygon: '0x94f9bB5c972285728DCee7EAece48BeC2fF341ce',
    bnb: '0x94f9bB5c972285728DCee7EAece48BeC2fF341ce',
    plasma: '0x94f9bB5c972285728DCee7EAece48BeC2fF341ce',
    oracleFeed: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419',
    decimals: 18n,
    ppsScale: 18n,
  },
  xBTC: {
    ethereum: '0x12fd502e2052CaFB41eccC5B596023d9978057d6',
    sonic: '0xB88fF15ae5f82c791e637b27337909BcF8065270',
    base: '0x09Aed31D66903C8295129aebCBc45a32E9244a1f',
    arbitrum: '0xa791082be08B890792c558F1292Ac4a2Dad21920',
    avalanche: '0x6eAf19b2FC24552925dB245F9Ff613157a7dbb4C',
    berachain: '0xa791082be08B890792c558F1292Ac4a2Dad21920',
    linea: '0x94f9bB5c972285728DCee7EAece48BeC2fF341ce',
    polygon: '0xa791082be08B890792c558F1292Ac4a2Dad21920',
    bnb: '0xa791082be08B890792c558F1292Ac4a2Dad21920',
    plasma: '0xa791082be08B890792c558F1292Ac4a2Dad21920',
    oracleFeed: '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c',
    decimals: 8n, 
    ppsScale: 8n, 
  },
  xUSD: {
    ethereum: '0xE2Fc85BfB48C4cF147921fBE110cf92Ef9f26F94',
    sonic: '0x6202B9f02E30E5e1c62Cc01E4305450E5d83b926', 
    base: '0xa791082be08B890792c558F1292Ac4a2Dad21920', 
    arbitrum: '0x6eAf19b2FC24552925dB245F9Ff613157a7dbb4C', 
    avalanche: '0x94f9bB5c972285728DCee7EAece48BeC2fF341ce', 
    berachain: '0x6eAf19b2FC24552925dB245F9Ff613157a7dbb4C',
    linea: '0x413bF752b33e76562dc876182141e2329716f250',
    polygon: '0x6eAf19b2FC24552925dB245F9Ff613157a7dbb4C',
    bnb: '0x6eAf19b2FC24552925dB245F9Ff613157a7dbb4C',
    plasma: '0x6eAf19b2FC24552925dB245F9Ff613157a7dbb4C',
    oracleFeed: '0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6',
    decimals: 6n,
    ppsScale: 6n, 
  },
  xEUR: {
    ethereum: '0xc15697f61170Fc3Bb4e99Eb7913b4C7893F64F13',
    sonic: '0x931383c1bCA6a41E931f2519BAe8D716857F156c',
    base: '0xC69BfBdd43bCe760A12635d881c8d70B4542CBeB',
    arbitrum: '0x8e81A7dC7c13CDf4b2BC1BBf3dD30CbC1a3E10bA',
    avalanche: '0x54e7C2acFd23Cbf40B993EA16f974886BF892EA4',
    berachain: '0x28F1b853c98557a207479904465bc97469Ca889E',
    linea: '0xB4329eeE0cEa38d83817034621109C87a0a6eECb',
    polygon: '0x413bF752b33e76562dc876182141e2329716f250',
    bnb: '0x0000000000000000000000000000000000000000',
    plasma: '0x413bF752b33e76562dc876182141e2329716f250',
    oracleFeed: '0x04F84020Fdf10d9ee64D1dcC2986EDF2F556DA11',
    decimals: 6n,
    ppsScale: 6n,
  },
};

/************************************************************************
 * UTILITY FUNCTIONS
 ************************************************************************/

/**
 * Checks if an address is a zero or dead address
 */
export function checkZeroAddress(address: string): boolean {
  const addr = address.toLowerCase();
  return addr === '0x0000000000000000000000000000000000000000' || 
         addr === '0x000000000000000000000000000000000000dead';
}

/**
 * Checks if an address is a Shadow Exchange contract address
 */
export function isShadowAddress(address: string): boolean {
  const addr = address.toLowerCase();
  
  const shadowContracts = [
    INTEGRATION_CONTRACTS.SHADOW_EXCHANGE.SONIC.XUSD_HLP0_POOL,
    INTEGRATION_CONTRACTS.SHADOW_EXCHANGE.SONIC.XUSD_ASONUSDC_POOL
  ];
  
  return shadowContracts.some(contract => contract && contract.toLowerCase() === addr);
}

/**
 * Gets the xUSD token position for a given integration contract address
 */
export function getTokenPosition(address: string): number | undefined {
  return INTEGRATION_TOKEN_POSITIONS[address.toLowerCase()];
}

/**
 * Checks if an address is an integration contract address on the specified chain (excludes Shadow Exchange)
 */
export async function isIntegrationAddress(address: string, chainId: number): Promise<boolean> {
  const addr = address.toLowerCase();
  
  const integrationChains = {
    [146]: [ // copied from SUPPORTED_CHAINS.sonic.chainId
      INTEGRATION_CONTRACTS.EULER_FINANCE.SONIC.XUSD_VAULT,
      INTEGRATION_CONTRACTS.SILO_FINANCE.SONIC.XUSD_VAULT_1,
      INTEGRATION_CONTRACTS.SILO_FINANCE.SONIC.XUSD_VAULT_2,
      INTEGRATION_CONTRACTS.SILO_FINANCE.SONIC.ROUTER,
      INTEGRATION_CONTRACTS.ENCLABS.SONIC.XUSD_VTOKEN,
      INTEGRATION_CONTRACTS.STABILITY.SONIC.XUSD_ATOKEN
    ],
    [43114]: [ // copied from SUPPORTED_CHAINS.avalanche.chainId
      INTEGRATION_CONTRACTS.SILO_FINANCE.AVALANCHE.XUSD_VAULT,
      INTEGRATION_CONTRACTS.SILO_FINANCE.AVALANCHE.ROUTER
    ]
  };
  
  const chainContracts = integrationChains[chainId as keyof typeof integrationChains];
  if (chainContracts) {
    const isHardcodedIntegration = chainContracts.some(contract => contract.toLowerCase() === addr);
    if (isHardcodedIntegration) {
      return true;
    }
  }
  
  try {
    const db = getDb();
    const roycoWallet = await db('royco_deposits')
      .where('weiroll_wallet', addr)
      .andWhere('active', true)
      .first();
    
    if (roycoWallet) {
      return true;
    }
  } catch (error) {
    console.error('Error checking Royco weiroll addresses:', error);
  }
  
  return false;
}

/**
 * Synchronous version for cases where async is not possible
 * Only checks hardcoded addresses, not dynamic Royco wallets
 */
export function isIntegrationAddressSync(address: string, chainId: number): boolean {
  const addr = address.toLowerCase();
  
  const integrationChains = { // copied from isIntegrationAddress function
    [146]: [ // copied from SUPPORTED_CHAINS.sonic.chainId
      INTEGRATION_CONTRACTS.EULER_FINANCE.SONIC.XUSD_VAULT,
      INTEGRATION_CONTRACTS.SILO_FINANCE.SONIC.XUSD_VAULT_1,
      INTEGRATION_CONTRACTS.SILO_FINANCE.SONIC.XUSD_VAULT_2,
      INTEGRATION_CONTRACTS.SILO_FINANCE.SONIC.ROUTER,
      INTEGRATION_CONTRACTS.ENCLABS.SONIC.XUSD_VTOKEN,
      INTEGRATION_CONTRACTS.STABILITY.SONIC.XUSD_ATOKEN
    ],
    [43114]: [ // copied from SUPPORTED_CHAINS.avalanche.chainId
      INTEGRATION_CONTRACTS.SILO_FINANCE.AVALANCHE.XUSD_VAULT,
      INTEGRATION_CONTRACTS.SILO_FINANCE.AVALANCHE.ROUTER
    ]
  };
  
  const chainContracts = integrationChains[chainId as keyof typeof integrationChains];
  if (chainContracts) {
    return chainContracts.some(contract => contract.toLowerCase() === addr);
  }
  
  return false;
}

/************************************************************************
 * DEPLOYMENT INFORMATION
 ************************************************************************/

export const DEPLOYMENT_INFO = {
  OVERALL_START_DATE: '2025-02-18',
  CHAIN_DEPLOYMENTS: {
    ETH: {
      chainId: 1,
      earliestBlock: 21870476,
      earliestDate: '2025-02-18', 
    },
    SONIC: {
      chainId: 146,
      earliestBlock: 8757379,
      earliestDate: '2025-02-19',
    },
    BASE: {
      chainId: 8453,
      earliestBlock: 26529547,
      earliestDate: '2025-02-18', 
    },
    ARB: {
      chainId: 42161,
      earliestBlock: 307879463,
      earliestDate: '2025-02-20',
    },
    AVAX: {
      chainId: 43114,
      earliestBlock: 57581229,
      earliestDate: '2025-02-20', 
    },
    BERA: {
      chainId: 80094,
      earliestBlock: 1362868,
      earliestDate: '2025-02-20', 
    },
    LINEA: {
      chainId: 59144,
      earliestBlock: 22989730,
      earliestDate: '2025-09-06',
    },
    POLYGON: {
      chainId: 137,
      earliestBlock: 76451683,
      earliestDate: '2025-09-14',
    },
    BNB: {
      chainId: 56,
      earliestBlock: 46812629,
      earliestDate: '2025-02-20',
    },
    PLASMA: {
      chainId: 9745,
      earliestBlock: 1296517,
      earliestDate: '2025-09-18',
    },
  },
} as const;

/************************************************************************
 * BLOCK TIME CONFIGURATION
 ************************************************************************/

/**
 * Typical block times (seconds) by chainId for binary search fallback.
 * Used when Alchemy blocks-by-timestamp API doesn't support the network.
 * 
 * Sources:
 * - Ethereum: ~12s (Etherscan/YCharts)
 * - Base: ~2s (Token Terminal / Base explorers) 
 * - Arbitrum: ~0.25s (Token Terminal + explorers; sequencer-level blocks)
 * - Avalanche: ~2s (Avax docs)
 * - Sonic: ~1s (Sonic explorers / Token Terminal)
 * - Berachain: ~2s (Core docs; using 2s default)
 */
export const TYPICAL_BLOCK_TIME_SEC: Record<number, number> = {
  1: 12,      // Ethereum
  8453: 2,    // Base
  42161: 0.25, // Arbitrum
  43114: 2,   // Avalanche  
  146: 1,     // Sonic
  80094: 2,   // Berachain
  59144: 2,   // Linea
  137: 2,     // Polygon
  56: 3,      // BNB Smart Chain
  9745: 2,    // Plasma
} as const;