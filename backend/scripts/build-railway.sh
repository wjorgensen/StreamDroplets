#!/bin/bash

echo "==================================="
echo "Railway Build Script"
echo "==================================="

# Install dependencies
echo "Installing dependencies..."
npm install

# Build TypeScript
echo "Building TypeScript..."
npx tsc

# Skip migrations during build - Railway uses internal URL during build
echo "Skipping migrations during build (will run at startup)"
echo "Note: Railway provides internal DATABASE_URL during build which doesn't work for migrations"

echo "Build complete!"