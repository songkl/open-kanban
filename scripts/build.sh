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
npm install --legacy-peer-deps
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
npm install --legacy-peer-deps
npm run build

# Build CLI
echo ""
echo "--- Building CLI ---"
cd "$PROJECT_DIR/cli"
npm install --legacy-peer-deps
npm run build

# Package CLI artifacts into the release directory
rm -rf "$RELEASE_DIR/cli"
mkdir -p "$RELEASE_DIR/cli"
cp -r "$PROJECT_DIR/cli/dist/." "$RELEASE_DIR/cli/dist/"
cp "$PROJECT_DIR/cli/package.json" "$RELEASE_DIR/cli/package.json"
cp -r "$PROJECT_DIR/cli/man" "$RELEASE_DIR/cli/man"
cp "$PROJECT_DIR/cli/README.md" "$RELEASE_DIR/cli/README.md"
cp "$PROJECT_DIR/cli/README_ZH.md" "$RELEASE_DIR/cli/README_ZH.md"
chmod +x "$RELEASE_DIR/cli/dist/index.js"

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
echo "  ├── cli/"
echo "  ├── $OUTPUT_NAME"
echo "  └── open-kanban-mcp/"
echo ""
echo "MCP Server published to npm: npm publish"
echo "CLI published to npm:      cd $RELEASE_DIR/cli && npm publish"
echo "Run '$RELEASE_DIR/$OUTPUT_NAME' to start the server"
