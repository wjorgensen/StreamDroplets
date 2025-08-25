#!/usr/bin/env node

/**
 * Simplified start script for Railway deployment
 * Focuses on getting the API server running quickly
 */

const { spawn } = require('child_process');
const path = require('path');

console.log('==========================================');
console.log('Stream Droplets API Server');
console.log('==========================================');
console.log('Environment:', process.env.NODE_ENV || 'development');
console.log('Port:', process.env.PORT || 3000);
console.log('Database:', process.env.DATABASE_URL ? 'Configured' : 'Not configured');
console.log('');

// Start the API server directly - migrations will run on first DB connection if needed
const server = spawn('node', ['dist/api/server.js'], {
  stdio: 'inherit',
  env: { ...process.env }
});

server.on('error', (err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

server.on('exit', (code) => {
  console.log(`Server exited with code ${code}`);
  process.exit(code || 0);
});

// Handle shutdown signals
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down...');
  server.kill('SIGTERM');
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down...');
  server.kill('SIGINT');
});