import knex, { Knex } from 'knex';
import knexConfig from '../knexfile';

let db: Knex | null = null;

export function getDb(): Knex {
  if (!db) {
    const environment = process.env.NODE_ENV || 'development';
    const config = knexConfig[environment as keyof typeof knexConfig];
    
    console.log('Database connection config:', {
      environment,
      hasDATABASE_URL: !!process.env.DATABASE_URL,
      connectionType: typeof config.connection,
      // Log connection string pattern without sensitive data
      connectionPattern: process.env.DATABASE_URL 
        ? process.env.DATABASE_URL.replace(/:[^:@]+@/, ':***@').substring(0, 50) + '...'
        : 'Using individual config'
    });
    
    db = knex(config);
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