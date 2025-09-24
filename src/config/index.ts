import dotenv from 'dotenv';
import { z } from 'zod';
import { CONSTANTS } from './constants';

dotenv.config();

const configSchema = z.object({
  // Database - only password comes from env, rest from constants
  database: z.object({
    host: z.string(),
    port: z.number(),
    name: z.string(),
    user: z.string(),
    password: z.string(),
  }),
  
  // API Keys - sensitive values from environment
  apiKeys: z.object({
    alchemy: z.string(),
    alchemyFallback: z.string().optional(),
    royco: z.string(),
  }),
  
  // API - configuration from constants
  api: z.object({
    port: z.number(),
    host: z.string(),
    rateLimit: z.number(),
  }),
  
  // Indexer - configuration from constants
  indexer: z.object({
    batchSize: z.number(),
    pollInterval: z.number(),
    ethConfirmations: z.number(),
    sonicConfirmations: z.number(),
  }),
  
  // Logging - configuration from constants
  logging: z.object({
    level: z.enum(['debug', 'info', 'warn', 'error']),
    pretty: z.boolean(),
  }),
});

export type Config = z.infer<typeof configSchema>;

function loadConfig(): Config {
  const config = {
    database: process.env.DATABASE_URL ? {
      // Use dummy values when DATABASE_URL is set since they won't be used
      host: 'using-database-url',
      port: 5432,
      name: 'using-database-url',
      user: 'using-database-url',
      password: 'using-database-url',
    } : {
      // Read all database config from environment variables, fall back to constants
      host: process.env.DB_HOST || CONSTANTS.DATABASE.HOST,
      port: parseInt(process.env.DB_PORT || '') || CONSTANTS.DATABASE.PORT,
      name: process.env.DB_NAME || CONSTANTS.DATABASE.NAME,
      user: process.env.DB_USER || CONSTANTS.DATABASE.USER,
      password: process.env.DB_PASSWORD || '',
    },
    apiKeys: {
      alchemy: process.env.ALCHEMY_API_KEY || '',
      alchemyFallback: process.env.ALCHEMY_API_KEY_2,
      royco: process.env.ROYCO_API_KEY || '',
    },
    api: {
      port: parseInt(process.env.PORT || '') || CONSTANTS.API.PORT,
      host: CONSTANTS.API.HOST,
      rateLimit: CONSTANTS.API.RATE_LIMIT,
    },
    indexer: {
      batchSize: CONSTANTS.INDEXER.BATCH_SIZE,
      pollInterval: CONSTANTS.INDEXER.POLL_INTERVAL,
      ethConfirmations: CONSTANTS.INDEXER.ETH_CONFIRMATIONS,
      sonicConfirmations: CONSTANTS.INDEXER.SONIC_CONFIRMATIONS,
    },
    logging: {
      level: (process.env.LOG_LEVEL as any) || CONSTANTS.LOGGING.LEVEL,
      pretty: process.env.LOG_PRETTY === 'true' || CONSTANTS.LOGGING.PRETTY,
    },
  };
  
  return configSchema.parse(config);
}

export const config = loadConfig();