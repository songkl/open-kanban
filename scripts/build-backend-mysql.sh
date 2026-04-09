#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== Building Backend (MySQL Only) ==="

cd "$PROJECT_DIR/backend"

rm -rf cmd/server/web
mkdir -p cmd/server/web

if [ -d "$PROJECT_DIR/frontend/dist" ] && [ "$(ls -A $PROJECT_DIR/frontend/dist)" ]; then
    echo "Copying frontend dist..."
    cp -r "$PROJECT_DIR/frontend/dist/." cmd/server/web/
else
    echo "No frontend dist found, creating placeholder..."
    echo "MySQL-only build" > cmd/server/web/placeholder.txt
fi

go build -tags "mysql && !sqlite" -ldflags="-s -w" -o kanban-server-mysql ./cmd/server/main.go

echo "MySQL-only backend built: $PROJECT_DIR/backend/kanban-server-mysql"