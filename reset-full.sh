#!/bin/bash

echo "⚠️  WARNING: This will DELETE ALL DATA including the database!"
echo "🗑️  This is a FULL RESET - all progress will be lost."
echo ""
read -p "Are you sure you want to continue? (yes/no): " confirm

if [[ $confirm != "yes" ]]; then
    echo "❌ Full reset cancelled."
    exit 0
fi

echo ""
echo "🧹 Stopping and removing ALL containers and volumes..."
docker compose down -v

echo "🗑️  Removing all Docker volumes for this project..."
docker volume rm $(docker volume ls -q --filter name=streamdroplets) 2>/dev/null || true

echo "🗑️  Pruning Docker system (removing unused containers, networks, images, and volumes)..."
docker system prune -af --volumes

echo "🔨 Building ALL containers from scratch..."
docker compose build --no-cache

echo "🚀 Starting ALL containers (fresh database)..."
docker compose up -d

echo ""
echo "✅ Full reset complete! Everything is fresh."
echo "📊 Database will be empty and migrations will run automatically."
echo "⏳ The app will start backfill from the beginning (2025-02-18)."
echo ""
echo "To view logs, run: docker compose logs -f"
echo "To view app logs only, run: docker compose logs -f app"
echo "To stop containers, run: docker compose down"
