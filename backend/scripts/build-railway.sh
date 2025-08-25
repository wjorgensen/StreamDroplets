#!/bin/bash

echo "==================================="
echo "Railway Build Script"
echo "==================================="

# Check if we're in backend directory or root
if [ -f "package.json" ] && [ -d "backend" ]; then
  echo "Running from root directory"
  # Install dependencies from root
  echo "Installing dependencies..."
  npm ci
  
  # Move to backend directory
  cd backend
elif [ -f "package.json" ] && [ -d "src" ]; then
  echo "Running from backend directory"
  # Install dependencies
  echo "Installing dependencies..."
  npm ci
else
  echo "ERROR: Unable to determine project structure"
  exit 1
fi

# Build TypeScript
echo "Building TypeScript..."
if [ -f "../node_modules/.bin/tsc" ]; then
  ../node_modules/.bin/tsc
elif [ -f "node_modules/.bin/tsc" ]; then
  node_modules/.bin/tsc
else
  npx --no-install tsc
fi

# Also compile scripts directory if it exists
if [ -d "scripts" ]; then
  echo "Compiling scripts..."
  if [ -f "../node_modules/.bin/tsc" ]; then
    ../node_modules/.bin/tsc scripts/*.ts --outDir dist/scripts --module commonjs --target ES2022 --esModuleInterop true
  elif [ -f "node_modules/.bin/tsc" ]; then
    node_modules/.bin/tsc scripts/*.ts --outDir dist/scripts --module commonjs --target ES2022 --esModuleInterop true
  else
    npx --no-install tsc scripts/*.ts --outDir dist/scripts --module commonjs --target ES2022 --esModuleInterop true
  fi
fi

# Remove any .d.ts files that might cause issues
if [ -d "dist" ]; then
  find dist -name "*.d.ts" -type f -delete 2>/dev/null || true
  find dist -name "*.d.ts.map" -type f -delete 2>/dev/null || true
fi

# Skip migrations during build - Railway uses internal URL during build
echo "Skipping migrations during build (will run at startup)"
echo "Note: Railway provides internal DATABASE_URL during build which doesn't work for migrations"

echo "Build complete!"