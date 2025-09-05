#!/bin/sh
set -e

echo "========================================="
echo "Stream Droplets Container Starting..."
echo "========================================="

# Wait for PostgreSQL to be ready
echo "Waiting for PostgreSQL..."
until PGPASSWORD=$DB_PASSWORD psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -c '\q' 2>/dev/null; do
  echo "PostgreSQL is unavailable - sleeping"
  sleep 2
done

echo "PostgreSQL is ready!"

# Run database migrations
echo "Running database migrations..."
cd /app
npx knex migrate:latest --knexfile ./src/db/knexfile.js

# Check if initial backfill is needed
echo "Checking if initial backfill is required..."
BACKFILL_CHECK=$(PGPASSWORD=$DB_PASSWORD psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -t -c "SELECT COUNT(*) FROM events;" 2>/dev/null | xargs)

if [ "$BACKFILL_CHECK" = "0" ]; then
  echo "No existing data found. Running initial backfill..."
  
  # Set start date for backfill (Feb 19, 2024)
  export BACKFILL_START_DATE="2024-02-19"
  
  # Run backfill for Ethereum mainnet
  echo "Backfilling Ethereum mainnet events..."
  node dist/scripts/quick-backfill-stakes.js || echo "Ethereum backfill completed with warnings"
  
  # Populate cross-chain data
  echo "Populating cross-chain balances..."
  node dist/scripts/quick-fetch-all-chains.js || echo "Cross-chain data populated with warnings"
  
  # Generate historical droplets
  echo "Generating historical droplets..."
  node dist/scripts/generate-all-historical-droplets.js || echo "Historical droplets generated with warnings"
  
  echo "Initial backfill completed!"
else
  echo "Existing data found ($BACKFILL_CHECK events). Skipping backfill."
fi

# Start the application
echo "========================================="
echo "Starting Stream Droplets API and Services..."
echo "========================================="

# Run the main application
exec "$@"