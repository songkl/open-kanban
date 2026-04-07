#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
RELEASE_DIR="$PROJECT_DIR/release"

echo "=== Building open-kanban ==="

# Build frontend
echo ""
echo "--- Building Frontend ---"
cd "$PROJECT_DIR/frontend"
npm install
npm run build

# Copy dist to release directory
rm -rf "$RELEASE_DIR/web"
mkdir -p "$RELEASE_DIR/web"
cp -r "$PROJECT_DIR/frontend/dist/." "$RELEASE_DIR/web/"

# Copy to backend/cmd/server/web for embedding (MUST be done before backend build)
mkdir -p "$PROJECT_DIR/backend/cmd/server/web"
rm -rf "$PROJECT_DIR/backend/cmd/server/web"
cp -r "$PROJECT_DIR/frontend/dist/." "$PROJECT_DIR/backend/cmd/server/web/"

# Build MCP Server
echo ""
echo "--- Building MCP Server ---"
cd "$PROJECT_DIR/mcp-server"
npm install
npm run build

# Build backend for current platform
echo ""
echo "--- Building Backend ---"
mkdir -p "$RELEASE_DIR"
cd "$PROJECT_DIR/backend"

GOOS=$(go env GOOS)
GOARCH=$(go env GOARCH)
OUTPUT_NAME="kanban-server-${GOOS}-${GOARCH}"
if [ "$GOOS" = "windows" ]; then
  OUTPUT_NAME="kanban-server-${GOOS}-${GOARCH}.exe"
fi
CGO_ENABLED=1 go build -ldflags="-s -w" -o "$RELEASE_DIR/$OUTPUT_NAME" ./cmd/server/main.go

echo ""
echo "=== Build Complete ==="
echo "Release:  $RELEASE_DIR/"
echo "  ├── web/"
echo "  ├── $OUTPUT_NAME"
echo "  └── open-kanban-mcp/"
echo ""
echo "MCP Server published to npm: npm publish"
echo "Run '$RELEASE_DIR/$OUTPUT_NAME' to start the server"
