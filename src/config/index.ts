import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const configSchema = z.object({
  // Database
  database: z.object({
    host: z.string().default('localhost'),
    port: z.number().default(5432),
    name: z.string().default('stream_droplets'),
    user: z.string().default('postgres'),
    password: z.string().default('postgres'),
  }),
  
  // RPC
  rpc: z.object({
    ethereum: z.string().url(),
    sonic: z.string().url(),
    // Multi-key support
    apiKeys: z.array(z.string()).optional(),
    ethBaseUrl: z.string().optional(),
    sonicBaseUrl: z.string().optional(),
  }),
  
  // API
  api: z.object({
    port: z.number().default(3000),
    host: z.string().default('0.0.0.0'),
    rateLimit: z.number().default(100),
    adminKey: z.string().optional(),
  }),
  
  // Indexer
  indexer: z.object({
    batchSize: z.number().default(100),
    pollInterval: z.number().default(10000),
    ethConfirmations: z.number().default(12),
    sonicConfirmations: z.number().default(32),
  }),
  
  // Droplets
  droplets: z.object({
    ratePerUsdPerRound: z.string().default('1000000000000000000'),
  }),
  
  // Logging
  logging: z.object({
    level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    pretty: z.boolean().default(true),
  }),
});

export type Config = z.infer<typeof configSchema>;

function loadConfig(): Config {
  // If DATABASE_URL is set, ignore individual DB_* variables
  const config = {
    database: process.env.DATABASE_URL ? {
      // Use dummy values when DATABASE_URL is set since they won't be used
      host: 'using-database-url',
      port: 5432,
      name: 'using-database-url',
      user: 'using-database-url',
      password: 'using-database-url',
    } : {
      // Only use individual variables if DATABASE_URL is not set
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432'),
      name: process.env.DB_NAME || 'stream_droplets',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres',
    },
    rpc: {
      ethereum: process.env.ALCHEMY_ETH_RPC || 'https://eth-mainnet.g.alchemy.com/v2/demo',
      sonic: process.env.ALCHEMY_SONIC_RPC || 'https://sonic-mainnet.g.alchemy.com/v2/demo',
      apiKeys: [
        process.env.ALCHEMY_API_KEY_1,
        process.env.ALCHEMY_API_KEY_2,
        process.env.ALCHEMY_API_KEY_3,
      ].filter(key => key && key !== 'your_second_api_key_here' && key !== 'your_third_api_key_here') as string[],
      ethBaseUrl: process.env.ALCHEMY_ETH_BASE_URL,
      sonicBaseUrl: process.env.ALCHEMY_SONIC_BASE_URL,
    },
    api: {
      port: parseInt(process.env.API_PORT || '3000'),
      host: process.env.API_HOST || '0.0.0.0',
      rateLimit: parseInt(process.env.API_RATE_LIMIT || '100'),
      adminKey: process.env.ADMIN_API_KEY,
    },
    indexer: {
      batchSize: parseInt(process.env.INDEXER_BATCH_SIZE || '100'),
      pollInterval: parseInt(process.env.INDEXER_POLL_INTERVAL || '10000'),
      ethConfirmations: parseInt(process.env.ETH_CONFIRMATIONS || '12'),
      sonicConfirmations: parseInt(process.env.SONIC_CONFIRMATIONS || '32'),
    },
    droplets: {
      ratePerUsdPerRound: process.env.RATE_PER_USD_PER_ROUND || '1000000000000000000',
    },
    logging: {
      level: (process.env.LOG_LEVEL as any) || 'info',
      pretty: process.env.LOG_PRETTY === 'true',
    },
  };
  
  return configSchema.parse(config);
}

export const config = loadConfig();