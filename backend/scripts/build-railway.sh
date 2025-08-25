#!/bin/bash

echo "==================================="
echo "Railway Build Script"
echo "==================================="

# Move to root directory for monorepo installation
cd ..

# Install dependencies from root (monorepo)
echo "Installing dependencies..."
npm ci

# Move back to backend directory
cd backend

# Build TypeScript
echo "Building TypeScript..."
npx --no-install tsc || ../node_modules/.bin/tsc

# Also compile scripts directory
echo "Compiling scripts..."
npx --no-install tsc scripts/*.ts --outDir dist/scripts --module commonjs --target ES2022 --esModuleInterop true || ../node_modules/.bin/tsc scripts/*.ts --outDir dist/scripts --module commonjs --target ES2022 --esModuleInterop true

# Remove any .d.ts files that might cause issues
find dist -name "*.d.ts" -type f -delete
find dist -name "*.d.ts.map" -type f -delete

# Skip migrations during build - Railway uses internal URL during build
echo "Skipping migrations during build (will run at startup)"
echo "Note: Railway provides internal DATABASE_URL during build which doesn't work for migrations"

echo "Build complete!"