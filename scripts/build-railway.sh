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

# Build frontend
echo "Building frontend..."
cd frontend
npm install
npm run build
cd ..

# Run migrations if DATABASE_URL is set
if [ ! -z "$DATABASE_URL" ]; then
  echo "DATABASE_URL is set, attempting migrations..."
  
  # Check if it's an internal URL
  if [[ "$DATABASE_URL" == *".railway.internal"* ]]; then
    echo "WARNING: DATABASE_URL uses internal URL, migrations might fail"
    echo "Skipping migrations - they should run at startup instead"
  else
    echo "Running database migrations..."
    npx knex migrate:latest --knexfile dist/db/knexfile.js --env production || {
      echo "Migration failed, but continuing build..."
      echo "Migrations will be attempted at startup"
    }
  fi
else
  echo "DATABASE_URL not set, skipping migrations"
fi

echo "Build complete!"