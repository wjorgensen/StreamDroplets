require('dotenv').config();

// Check if we're in production environment
const isProduction = process.env.NODE_ENV === 'production';

if (!isProduction) {
  // Development: use ts-node to load TypeScript files
  require('ts-node/register');
  module.exports = require('./src/knexfile.ts').default;
} else {
  // Production: use compiled JavaScript
  const config = {
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
  };
  
  module.exports = config;
}