#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== Building Backend ==="

cd "$PROJECT_DIR/backend"

# Copy frontend dist to cmd/server/web for embedding
if [ -d "$PROJECT_DIR/frontend/dist" ]; then
    rm -rf cmd/server/web
    mkdir -p cmd/server/web
    cp -r "$PROJECT_DIR/frontend/dist/." web/
fi

go build -ldflags="-s -w" -o kanban-server ./cmd/server/main.go

echo "Backend built: $PROJECT_DIR/backend/kanban-server"
