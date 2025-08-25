#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');

console.log('==========================================');
console.log('Stream Droplets Production Start Script');
console.log('==========================================');
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('PORT:', process.env.PORT || 3000);
console.log('Database URL:', process.env.DATABASE_URL ? 'Set' : 'Not set');

// Function to run a command and wait for it to complete
function runCommand(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    console.log(`Running: ${command} ${args.join(' ')}`);
    const proc = spawn(command, args, { 
      stdio: 'inherit',
      shell: true,
      cwd: __dirname,
      ...options
    });
    
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Command failed with code ${code}`));
      } else {
        resolve();
      }
    });
    
    proc.on('error', reject);
  });
}

// Function to run a command in background (non-blocking)
function runInBackground(command, args = [], name = 'Process') {
  console.log(`Starting ${name} in background: ${command} ${args.join(' ')}`);
  const proc = spawn(command, args, { 
    stdio: 'inherit',
    shell: true,
    cwd: __dirname,
    detached: false
  });
  
  proc.on('error', (err) => {
    console.error(`${name} error:`, err);
  });
  
  proc.on('exit', (code) => {
    if (code !== 0) {
      console.log(`${name} exited with code ${code}`);
    }
  });
  
  return proc;
}

async function waitForDatabase(maxAttempts = 30) {
  const { Client } = require('pg');
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`Checking database connection (attempt ${attempt}/${maxAttempts})...`);
      const client = new Client({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
      });
      
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      console.log('✅ Database connection successful!');
      return true;
    } catch (error) {
      console.log(`Database not ready yet, retrying in 2s...`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  return false;
}

async function start() {
  try {
    console.log('\n🚀 Starting Stream Droplets Full Production Deployment...');
    
    // Step 1: Wait for database
    const dbReady = await waitForDatabase();
    if (!dbReady) {
      console.error('❌ Database connection failed after multiple attempts');
      process.exit(1);
    }
    
    // Step 2: Run migrations
    console.log('\n=== Running database migrations ===');
    try {
      await runCommand('npx', ['knex', 'migrate:latest', '--knexfile', 'dist/db/knexfile.js', '--env', 'production']);
      console.log('✅ Migrations complete');
    } catch (migrationError) {
      console.log('⚠️ Migration failed (continuing anyway):', migrationError.message);
    }
    
    // Step 3: Start the API server first (needed for health checks)
    console.log('\n=== Starting API server ===');
    const apiServer = runInBackground('node', ['dist/simple-server.js'], 'API Server');
    
    // Give API server time to start
    await new Promise(resolve => setTimeout(resolve, 5000));
    console.log('✅ API server started');
    
    // Step 4: Run backfill
    console.log('\n=== Starting Historical Backfill ===');
    const backfillProcess = runInBackground('node', ['dist/scripts/production-backfill.js'], 'Backfill');
    
    // Give backfill a moment to start
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Step 5: Start live indexer
    console.log('\n=== Starting Live Event Indexer ===');
    const indexerProcess = runInBackground('node', ['dist/indexer/index.js'], 'Live Indexer');
    
    console.log('\n==========================================');
    console.log('🎉 All services started successfully!');
    console.log('- API Server: Running on port', process.env.PORT || 3000);
    console.log('- Backfill: Running in background');
    console.log('- Live Indexer: Running');
    console.log('==========================================\n');
    
    // Keep the main process alive
    process.stdin.resume();
    
  } catch (error) {
    console.error('❌ Startup failed:', error);
    process.exit(1);
  }
}

// Handle shutdown gracefully
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

// Start the application
start().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});