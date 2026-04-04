#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== Building Frontend ==="

cd "$PROJECT_DIR/frontend"
npm install
npm run build

# Copy dist to backend/cmd/server/web for embedding
mkdir -p "$PROJECT_DIR/backend/cmd/server/web"
rm -rf "$PROJECT_DIR/backend/cmd/server/web"
cp -r "$PROJECT_DIR/frontend/dist/." "$PROJECT_DIR/backend/cmd/server/web/"

echo "Frontend built: $PROJECT_DIR/backend/web/"
