export const CONSTANTS = {
  // Scaling factors
  ORACLE_SCALE: 8n, // Chainlink uses 8 decimals
  PPS_SCALE: 18n, // Price per share uses 18 decimals
  DROPLETS_SCALE: 18n, // Droplets use 18 decimals
  
  // Asset decimals
  ASSET_DECIMALS: {
    xETH: 18n,
    xBTC: 18n,
    xUSD: 6n,
    xEUR: 18n,
  },
  
  // Chain IDs
  CHAIN_IDS: {
    ETHEREUM: 1,
    SONIC: 146,
    BASE: 8453,
    ARBITRUM: 42161,
    AVALANCHE: 43114,
    BERACHAIN: 81457, // Mainnet chain ID
  },
  
  // Event types
  EVENT_TYPES: {
    STAKE: 'stake',
    UNSTAKE: 'unstake',
    REDEEM: 'redeem',
    TRANSFER: 'transfer',
    ROUND_ROLLED: 'round_rolled',
    INSTANT_UNSTAKE: 'instant_unstake',
  },
  
  // Event classifications
  EVENT_CLASSIFICATIONS: {
    STAKE: 'stake',
    REDEEM: 'redeem',
    UNSTAKE_BURN: 'unstake_burn',
    BRIDGE_BURN: 'bridge_burn',
    BRIDGE_MINT: 'bridge_mint',
    TRANSFER: 'transfer',
  },
  
  // Method selectors
  METHOD_SELECTORS: {
    UNSTAKE: '0x2e17de78', // unstake(uint256,uint256)
    UNSTAKE_AND_WITHDRAW: '0x7a6c5e00', // unstakeAndWithdraw(uint256,uint256)
    INSTANT_UNSTAKE: '0x0f089b4c', // instantUnstake(uint104)
    INSTANT_UNSTAKE_AND_WITHDRAW: '0x6c5e7b3a', // instantUnstakeAndWithdraw(uint104)
  },
  
  // Zero address
  ZERO_ADDRESS: '0x0000000000000000000000000000000000000000',
  
  // Minimum valid round
  MINIMUM_VALID_ROUND: 2,
  
  // Batch sizes
  BATCH_SIZE: 100,
  
  // Cache TTL
  CACHE_TTL: 60 * 5, // 5 minutes in seconds
} as const;

export type AssetType = keyof typeof CONSTANTS.ASSET_DECIMALS;
export type ChainId = typeof CONSTANTS.CHAIN_IDS[keyof typeof CONSTANTS.CHAIN_IDS];
export type EventType = typeof CONSTANTS.EVENT_TYPES[keyof typeof CONSTANTS.EVENT_TYPES];
export type EventClassification = typeof CONSTANTS.EVENT_CLASSIFICATIONS[keyof typeof CONSTANTS.EVENT_CLASSIFICATIONS];