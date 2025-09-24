/*************************************************
 * SETTINGS
 * Configurable values that may need adjustment
 *************************************************/

export const CONSTANTS = {
  
  /** Droplet calculation settings */
  DROPLET_USD_RATIO: parseFloat(process.env.DROPLET_USD_RATIO || '') || 1, // 1 droplet per USD per day
  
  /** Live fill timing configuration (EST timezone) */
  LIVE_FILL_TIME: {
    HOURS: 0,   // 24-hour format (0 = midnight)
    MINUTES: 5, // Minutes past the hour
  },
  
  /** Alchemy and Royco API retry configuration */
  MAX_ALCHEMY_RETRIES: 5,
  MAX_ROYCO_API_RETRIES: 10,
  RETRY_DELAY_MS: 1000, // Base delay between retries
  RETRY_BACKOFF_MULTIPLIER: 2, // Exponential backoff multiplier
  MAX_RETRY_DELAY_SECONDS: 30, // Maximum delay between retries in seconds

  /** Alchemy RPC base URLs */
  ALCHEMY_BASE_URLS: {
    ETHEREUM: 'https://eth-mainnet.g.alchemy.com/v2/',
    SONIC: 'https://sonic-mainnet.g.alchemy.com/v2/',
    BASE: 'https://base-mainnet.g.alchemy.com/v2/',
    ARBITRUM: 'https://arb-mainnet.g.alchemy.com/v2/',
    AVALANCHE: 'https://avax-mainnet.g.alchemy.com/v2/',
    BERACHAIN: 'https://berachain-mainnet.g.alchemy.com/v2/',
  },

  /** Database configuration defaults */
  DATABASE: {
    HOST: process.env.DB_HOST || 'localhost',
    PORT: parseInt(process.env.DB_PORT || '') || 5432,
    NAME: process.env.DB_NAME || 'stream_droplets',
    USER: process.env.DB_USER || 'stream',
    POOL_MIN: 2,
    POOL_MAX: 10,
    ACQUIRE_CONNECTION_TIMEOUT: 60000,
  },

  /** API server configuration */
  API: {
    PORT: parseInt(process.env.API_PORT || '') || 3000,
    HOST: process.env.API_HOST || '0.0.0.0',
    RATE_LIMIT: 100,
    RATE_LIMIT_WINDOW: '1 minute',
  },

  /** Indexer configuration */
  INDEXER: {
    BATCH_SIZE: 100,
    POLL_INTERVAL: 10000,
    ETH_CONFIRMATIONS: 12,
    SONIC_CONFIRMATIONS: 32,
  },

  /** Logging configuration */
  LOGGING: {
    LEVEL: (process.env.LOG_LEVEL as any) || 'info',
    PRETTY: process.env.LOG_PRETTY !== 'false', // defaults to true unless explicitly set to 'false'
  },

  /*************************************************
   * SCALING FACTORS
   *************************************************/

  /** Decimal precision for various numeric types */
  ORACLE_SCALE: 8n,
  DROPLETS_SCALE: 18n,

  /*************************************************
   * ASSET CONFIGURATION
   *************************************************/

  /** Decimal precision for supported assets */
  ASSET_DECIMALS: {
    xETH: 18n,
    xBTC: 8n,
    xUSD: 6n,
    xEUR: 6n,
  },

  /** USD balance decimal precision */
  USD_DECIMALS: 6n,

  /*************************************************
   * CHAIN CONFIGURATION
   *************************************************/

  /** Supported blockchain network IDs */
  CHAIN_IDS: {
    ETHEREUM: 1,
    SONIC: 146,
    BASE: 8453,
    ARBITRUM: 42161,
    AVALANCHE: 43114,
    BERACHAIN: 80094,
  },

  /** LayerZero Endpoint IDs to Chain ID mapping */
  LAYERZERO_EID_TO_CHAIN_ID: {
    30101: 1,     // Ethereum
    30272: 146,   // Sonic 
    30184: 8453,  // Base
    30110: 42161, // Arbitrum
    30106: 43114, // Avalanche
    30309: 80094, // Berachain (estimated)
  } as const,


  /*************************************************
   * ADDRESS CONSTANTS
   *************************************************/

  /** Standard blockchain addresses */
  ZERO_ADDRESS: '0x0000000000000000000000000000000000000000',
  DEAD_ADDRESS: '0x000000000000000000000000000000000000dead',

  /*************************************************
   * EXTERNAL API CONFIGURATION
   *************************************************/

  /** Royco Protocol configuration */
  ROYCO: {
    SONIC: {
      MARKET_REF_ID: '146_0_0xfcd798abefe4f9784e8f7ce3019c5e567e85687235ce0ce61c27271ba97d26cd', 
      API_BASE_URL: 'https://api.royco.org/api/v1',
    },
  },

  /** Alchemy API configuration */
  ALCHEMY: {
    DATA_BASE_URL: 'https://api.g.alchemy.com/data/v1',
  },

} as const;

/*************************************************
 * TYPE DEFINITIONS
 *************************************************/

export type AssetType = keyof typeof CONSTANTS.ASSET_DECIMALS;
export type ChainId = typeof CONSTANTS.CHAIN_IDS[keyof typeof CONSTANTS.CHAIN_IDS];
export type NetworkName = string;

export type BlockByTimestampItem = {
  network: string;
  block: { number: number; timestamp: string } | null;
};

export type BlockByTimestampResponse = {
  data: BlockByTimestampItem[];
};

/*************************************************
 * INTERFACE DEFINITIONS
 *************************************************/

/** Block range specification for indexing operations */
export interface BlockRange {
  chainId: number;
  fromBlock: number;
  toBlock: number;
}

/** User daily snapshot data structure */
export interface UserDailySnapshot {
  address: string;
  snapshot_date: string; 
  total_usd_value: string;
  xeth_shares_total: string;
  xeth_usd_value: string;
  xbtc_shares_total: string;
  xbtc_usd_value: string; 
  xusd_shares_total: string;
  xusd_usd_value: string;
  xeur_shares_total: string; 
  xeur_usd_value: string; 
  integration_breakdown: string;
  daily_droplets_earned: string;
  total_droplets: string;
  snapshot_timestamp: Date;
}

/** Protocol daily snapshot data structure */
export interface ProtocolDailySnapshot {
  snapshot_date: string;
  total_protocol_usd: string;
  total_xeth_shares: string;
  total_xeth_usd: string;
  total_xbtc_shares: string;
  total_xbtc_usd: string;
  total_xusd_shares: string;
  total_xusd_usd: string;
  total_xeur_shares: string;
  total_xeur_usd: string;
  total_integration_breakdown: string;
  total_users: number;
  daily_protocol_droplets: string;
  total_protocol_droplets: string;
  eth_usd_price: string;
  btc_usd_price: string;
  eur_usd_price: string;
  snapshot_timestamp: Date;
}

/** Integration breakdown data structure */
export interface IntegrationBreakdown {
  [integrationName: string]: {
    USD: string;
    [assetType: string]: string;
  };
}

/** Indexer contract configuration */
export interface IndexerContractConfig {
  address: string;
  symbol: string;
  chainId: number;
  startBlock?: number;
}