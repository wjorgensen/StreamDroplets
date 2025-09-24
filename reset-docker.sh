#!/bin/bash

echo "🧹 Stopping app container (preserving database)..."
docker compose stop app

echo "🗑️  Removing old app container..."
docker compose rm -f app

echo "🗑️  Pruning Docker system (keeping volumes for database preservation)..."
docker system prune -af

echo "🔨 Building app container..."
docker compose build --no-cache app

echo "🚀 Starting app container (database already running)..."
docker compose up -d app

echo "✅ App container reset complete! Database preserved."
echo ""
echo "Database status:"
docker compose ps postgres
echo ""
echo "To view logs, run: docker compose logs -f app"
echo "To view all logs, run: docker compose logs -f"
echo "To stop containers, run: docker compose down"
