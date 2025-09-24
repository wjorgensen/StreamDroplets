import dotenv from 'dotenv';
import type { Knex } from 'knex';

dotenv.config();

const knexConfig: { [key: string]: Knex.Config } = {
  development: {
    client: 'postgresql',
    connection: process.env.DATABASE_URL || {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432'),
      database: process.env.DB_NAME || 'stream_droplets',
      user: process.env.DB_USER || 'stream',
      password: process.env.DB_PASSWORD || '',
    },
    pool: {
      min: 2,
      max: 10,
    },
    migrations: {
      directory: './src/db/migrations',
      extension: 'ts',
    },
    seeds: {
      directory: './src/db/seeds',
      extension: 'ts',
    },
  },
  
  production: {
    client: 'postgresql',
    connection: process.env.DATABASE_URL 
      ? {
          connectionString: process.env.DATABASE_URL,
          ssl: { rejectUnauthorized: false }
        }
      : {
          host: process.env.DB_HOST || 'localhost',
          port: parseInt(process.env.DB_PORT || '5432'),
          database: process.env.DB_NAME || 'stream_droplets',
          user: process.env.DB_USER || 'stream',
          password: process.env.DB_PASSWORD || '',
        },
    pool: {
      min: 2,
      max: 10,
    },
    migrations: {
      directory: './dist/db/migrations',
      extension: 'js',
    },
  },
};

export default knexConfig;
