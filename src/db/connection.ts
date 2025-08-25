import knex, { Knex } from 'knex';
import { config } from '../config';

let db: Knex | null = null;

export function getDb(): Knex {
  if (!db) {
    // Support Railway's DATABASE_URL or individual config
    let connection: any = process.env.DATABASE_URL;
    
    if (connection) {
      // Railway PostgreSQL requires SSL
      if (process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT) {
        connection = {
          connectionString: process.env.DATABASE_URL,
          ssl: {
            rejectUnauthorized: false
          }
        };
      }
    } else {
      // Fallback to individual config
      connection = {
        host: config.database.host,
        port: config.database.port,
        database: config.database.name,
        user: config.database.user,
        password: config.database.password,
      };
    }
    
    console.log('Database connection config:', {
      hasDATABASE_URL: !!process.env.DATABASE_URL,
      isProduction: process.env.NODE_ENV === 'production',
      isRailway: !!process.env.RAILWAY_ENVIRONMENT,
      connectionType: typeof connection,
      // Log connection string pattern without sensitive data
      connectionPattern: process.env.DATABASE_URL 
        ? process.env.DATABASE_URL.replace(/:[^:@]+@/, ':***@').substring(0, 50) + '...'
        : 'Using individual config'
    });
    
    db = knex({
      client: 'postgresql',
      connection,
      pool: {
        min: 2,
        max: 10,
      },
      // Add connection timeout for Railway
      acquireConnectionTimeout: 60000,
    });
  }
  return db;
}

export async function closeDb(): Promise<void> {
  if (db) {
    await db.destroy();
    db = null;
  }
}

export async function testConnection(): Promise<boolean> {
  try {
    const db = getDb();
    await db.raw('SELECT 1');
    console.log('Database connection test successful');
    return true;
  } catch (error: any) {
    console.error('Database connection failed:', {
      message: error.message,
      code: error.code,
      stack: error.stack?.split('\n').slice(0, 3).join('\n')
    });
    return false;
  }
}