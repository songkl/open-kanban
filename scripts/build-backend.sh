#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== Building Backend ==="

cd "$PROJECT_DIR/backend"
go build -ldflags="-s -w" -o kanban-server ./cmd/server/main.go

echo "Backend built: $PROJECT_DIR/backend/kanban-server"
