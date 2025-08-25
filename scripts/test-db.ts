#!/usr/bin/env tsx

import knex from 'knex';

async function testDatabase() {
  console.log('Testing database connection...');
  console.log('DATABASE_URL:', process.env.DATABASE_URL ? 'Set' : 'Not set');
  
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL environment variable is not set!');
    console.log('Available env vars:', Object.keys(process.env).filter(k => k.includes('DB') || k.includes('DATABASE')));
    process.exit(1);
  }
  
  const db = knex({
    client: 'postgresql',
    connection: process.env.DATABASE_URL,
    pool: {
      min: 1,
      max: 1,
    },
    acquireConnectionTimeout: 10000,
  });
  
  try {
    console.log('Attempting to connect...');
    const result = await db.raw('SELECT 1 as test');
    console.log('✅ Database connection successful!');
    console.log('Result:', result.rows);
    
    // Test if tables exist
    const tables = await db.raw(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    console.log('Tables found:', tables.rows.map((r: any) => r.table_name));
    
    await db.destroy();
    process.exit(0);
  } catch (error: any) {
    console.error('❌ Database connection failed!');
    console.error('Error:', error.message);
    console.error('Code:', error.code);
    
    // Parse connection string to debug (without password)
    if (process.env.DATABASE_URL) {
      try {
        const url = new URL(process.env.DATABASE_URL);
        console.log('Connection details:');
        console.log('- Protocol:', url.protocol);
        console.log('- Host:', url.hostname);
        console.log('- Port:', url.port);
        console.log('- Database:', url.pathname.slice(1));
        console.log('- User:', url.username);
        console.log('- Has password:', !!url.password);
      } catch (e) {
        console.error('Could not parse DATABASE_URL');
      }
    }
    
    await db.destroy();
    process.exit(1);
  }
}

testDatabase().catch(console.error);