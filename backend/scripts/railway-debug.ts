#!/usr/bin/env tsx

console.log('='.repeat(60));
console.log('RAILWAY DEPLOYMENT DIAGNOSTIC');
console.log('='.repeat(60));

// 1. Check environment variables
console.log('\n1. ENVIRONMENT VARIABLES CHECK:');
console.log('-'.repeat(40));
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('RAILWAY_ENVIRONMENT:', process.env.RAILWAY_ENVIRONMENT || 'NOT SET');
console.log('PORT:', process.env.PORT || 'NOT SET');
console.log('DATABASE_URL exists:', !!process.env.DATABASE_URL);

// Check for conflicting DB variables
const dbVars = ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];
const conflictingVars = dbVars.filter(v => process.env[v]);
if (conflictingVars.length > 0) {
  console.log('⚠️  WARNING: Conflicting DB variables found:', conflictingVars);
}

// Parse DATABASE_URL if it exists
if (process.env.DATABASE_URL) {
  try {
    const url = new URL(process.env.DATABASE_URL);
    console.log('\n2. DATABASE_URL PARSING:');
    console.log('-'.repeat(40));
    console.log('Protocol:', url.protocol);
    console.log('Host:', url.hostname);
    console.log('Port:', url.port);
    console.log('Database:', url.pathname.slice(1));
    console.log('Username:', url.username);
    console.log('Has password:', !!url.password);
    
    // Check if it's internal or public URL
    if (url.hostname.includes('.railway.internal')) {
      console.log('❌ ERROR: Using internal URL! This won\'t work during build.');
      console.log('You need the public URL (ends with .railway.app)');
    } else if (url.hostname.includes('.railway.app')) {
      console.log('✅ Using public Railway URL');
    }
  } catch (e) {
    console.log('❌ ERROR: Could not parse DATABASE_URL:', e);
  }
} else {
  console.log('\n❌ ERROR: DATABASE_URL not set!');
}

// 3. Test raw PostgreSQL connection
console.log('\n3. RAW DATABASE CONNECTION TEST:');
console.log('-'.repeat(40));

import { Client } from 'pg';

async function testRawConnection() {
  if (!process.env.DATABASE_URL) {
    console.log('❌ Cannot test: DATABASE_URL not set');
    return false;
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT
      ? { rejectUnauthorized: false }
      : undefined
  });

  try {
    console.log('Attempting connection with SSL:', !!(process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT));
    await client.connect();
    console.log('✅ Connected successfully!');
    
    const result = await client.query('SELECT current_database(), current_user, version()');
    console.log('Database:', result.rows[0].current_database);
    console.log('User:', result.rows[0].current_user);
    console.log('Version:', result.rows[0].version.split(' ')[0] + ' ' + result.rows[0].version.split(' ')[1]);
    
    await client.end();
    return true;
  } catch (error: any) {
    console.log('❌ Connection failed!');
    console.log('Error code:', error.code);
    console.log('Error message:', error.message);
    
    if (error.code === 'ENOTFOUND') {
      console.log('→ Host not found. Check if DATABASE_URL is correct.');
    } else if (error.code === 'ECONNREFUSED') {
      console.log('→ Connection refused. Database might not be running.');
    } else if (error.message.includes('SSL')) {
      console.log('→ SSL error. Try with/without SSL.');
    } else if (error.message.includes('password')) {
      console.log('→ Authentication failed. Check credentials.');
    }
    
    return false;
  }
}

// 4. Test Knex connection
console.log('\n4. KNEX CONNECTION TEST:');
console.log('-'.repeat(40));

async function testKnexConnection() {
  try {
    const knex = (await import('knex')).default;
    
    const db = knex({
      client: 'postgresql',
      connection: process.env.DATABASE_URL 
        ? {
            connectionString: process.env.DATABASE_URL,
            ssl: process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT
              ? { rejectUnauthorized: false }
              : undefined
          }
        : undefined,
      pool: { min: 1, max: 1 },
      acquireConnectionTimeout: 10000,
    });

    const result = await db.raw('SELECT 1 as test');
    console.log('✅ Knex connection successful!');
    console.log('Result:', result.rows);
    
    // Check for migrations table
    try {
      const migrations = await db.raw(`
        SELECT tablename 
        FROM pg_tables 
        WHERE schemaname = 'public' 
        AND tablename LIKE '%migration%'
      `);
      if (migrations.rows.length > 0) {
        console.log('Migrations table found:', migrations.rows[0].tablename);
        
        // Check migration status
        const migrationStatus = await db.raw(`
          SELECT name, batch, migration_time 
          FROM ${migrations.rows[0].tablename}
          ORDER BY batch DESC, migration_time DESC
          LIMIT 5
        `);
        console.log('Recent migrations:', migrationStatus.rows.length);
      } else {
        console.log('⚠️  No migrations table found - migrations may not have run');
      }
    } catch (e) {
      console.log('Could not check migrations:', e);
    }
    
    await db.destroy();
    return true;
  } catch (error: any) {
    console.log('❌ Knex connection failed!');
    console.log('Error:', error.message);
    return false;
  }
}

// 5. Test API startup
console.log('\n5. API SERVER TEST:');
console.log('-'.repeat(40));

async function testApiStartup() {
  try {
    // First ensure database is accessible
    const dbOk = await testRawConnection();
    if (!dbOk) {
      console.log('❌ Cannot start API: Database connection failed');
      return;
    }

    const { createServer } = await import('../src/api/server');
    const server = await createServer();
    const port = process.env.PORT || 3000;
    
    await server.listen({ 
      port: Number(port), 
      host: '0.0.0.0'
    });
    
    console.log(`✅ API server started on port ${port}`);
    
    // Test health endpoint
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/health'
    });
    
    console.log('Health check status:', response.statusCode);
    console.log('Health check response:', JSON.parse(response.body));
    
    await server.close();
  } catch (error: any) {
    console.log('❌ API startup failed!');
    console.log('Error:', error.message);
  }
}

// Run all tests
async function runDiagnostics() {
  await testRawConnection();
  await testKnexConnection();
  await testApiStartup();
  
  console.log('\n' + '='.repeat(60));
  console.log('DIAGNOSTIC COMPLETE');
  console.log('='.repeat(60));
}

runDiagnostics().catch(console.error);