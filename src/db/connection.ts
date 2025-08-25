import knex, { Knex } from 'knex';
import { config } from '../config';

let db: Knex | null = null;

export function getDb(): Knex {
  if (!db) {
    // Support Railway's DATABASE_URL or individual config
    const connection = process.env.DATABASE_URL
      ? process.env.DATABASE_URL
      : {
          host: config.database.host,
          port: config.database.port,
          database: config.database.name,
          user: config.database.user,
          password: config.database.password,
        };
    
    db = knex({
      client: 'postgresql',
      connection,
      pool: {
        min: 2,
        max: 10,
      },
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
    return true;
  } catch (error) {
    console.error('Database connection failed:', error);
    return false;
  }
}