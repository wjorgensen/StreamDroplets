require('dotenv').config();
require('ts-node/register');

module.exports = {
  development: {
    client: 'postgresql',
    connection: {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432'),
      database: process.env.DB_NAME || 'stream_droplets',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres',
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
          user: process.env.DB_USER || 'postgres',
          password: process.env.DB_PASSWORD || 'postgres',
        },
    pool: {
      min: 2,
      max: 10,
    },
    migrations: {
      directory: './src/db/migrations',
      extension: 'ts',
    },
  },
};