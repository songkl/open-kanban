#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== Building Frontend ==="

cd "$PROJECT_DIR/frontend"
npm install
npm run build

# Copy dist to backend web directory
mkdir -p "$PROJECT_DIR/backend/web"
rm -rf "$PROJECT_DIR/backend/web/assets
cp -r "$PROJECT_DIR/frontend/dist/." "$PROJECT_DIR/backend/web/"

echo "Frontend built: $PROJECT_DIR/backend/web/"
