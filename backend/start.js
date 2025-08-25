#!/usr/bin/env node

console.log('='.repeat(60));
console.log('RAILWAY START SCRIPT EXECUTING');
console.log('Time:', new Date().toISOString());
console.log('Node version:', process.version);
console.log('='.repeat(60));

// Log environment
console.log('\nEnvironment Variables:');
console.log('- NODE_ENV:', process.env.NODE_ENV);
console.log('- PORT:', process.env.PORT);
console.log('- DATABASE_URL:', process.env.DATABASE_URL ? 'SET' : 'NOT SET');
console.log('- RAILWAY_ENVIRONMENT:', process.env.RAILWAY_ENVIRONMENT || 'NOT SET');

// Check for DATABASE_URL pattern
if (process.env.DATABASE_URL) {
  if (process.env.DATABASE_URL.includes('.railway.internal')) {
    console.error('\n❌ ERROR: Using internal DATABASE_URL!');
    console.error('Internal URLs only work for service-to-service communication.');
    console.error('You need the public URL for database migrations and initial setup.');
  } else if (process.env.DATABASE_URL.includes('.railway.app')) {
    console.log('\n✅ Using public Railway DATABASE_URL');
  }
}

// Run migrations first (if DATABASE_URL is set)
if (process.env.DATABASE_URL) {
  console.log('\nRunning database migrations...');
  const { execSync } = require('child_process');
  
  try {
    // Try to run migrations
    execSync('npx knex migrate:latest --knexfile dist/db/knexfile.js --env production', {
      stdio: 'inherit',
      env: process.env
    });
    console.log('✅ Migrations completed successfully');
  } catch (error) {
    console.error('⚠️  Migration failed (non-fatal):', error.message);
    console.log('Continuing with server startup...');
  }
}

// Try to start the server
console.log('\nStarting server...');

const { spawn } = require('child_process');

// Use node to run the compiled JavaScript file
// Make sure the TypeScript has been compiled to dist/ during build
const server = spawn('node', ['dist/simple-server.js'], {
  stdio: 'inherit',
  env: process.env
});

server.on('error', (err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

server.on('exit', (code) => {
  console.log('Server exited with code:', code);
  process.exit(code || 0);
});