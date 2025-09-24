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

echo "========================================="
echo "Starting Stream Droplets Application..."
echo "========================================="
echo ""
echo "The MainOrchestrator will handle:"
echo "  - Database migrations"
echo "  - Historical backfill processing"
echo "  - Real-time snapshot processing"
echo "  - API server initialization"
echo ""
echo "Starting application..."

# Run the main application
exec "$@"