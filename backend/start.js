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
function runCommand(command, args = []) {
  return new Promise((resolve, reject) => {
    console.log(`Running: ${command} ${args.join(' ')}`);
    const proc = spawn(command, args, { 
      stdio: 'inherit',
      shell: true,
      cwd: __dirname
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

async function start() {
  try {
    // Run migrations first using knex
    console.log('\n=== Running database migrations ===');
    try {
      await runCommand('npx', ['knex', 'migrate:latest', '--knexfile', 'dist/db/knexfile.js']);
      console.log('✅ Migrations complete');
    } catch (migrationError) {
      console.log('⚠️ Migration failed (this might be normal if DB is not ready):', migrationError.message);
      console.log('Continuing with server startup...');
    }
    
    // Start the main API server
    console.log('\n=== Starting API server ===');
    console.log(`Server will listen on port: ${process.env.PORT || 3000}`);
    await runCommand('node', ['dist/api/server.js']);
    
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