#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
RELEASE_DIR="$PROJECT_DIR/release"

echo "=== Building KL-Kanban ==="

# Check UPX
UPX_OK=false
if command -v upx &> /dev/null; then
    UPX_VERSION=$(upx --version 2>&1 | head -1)
    echo "UPX: $UPX_VERSION (will compress binaries)"
    UPX_OK=true
else
    echo "UPX not found, binaries will not be compressed"
    echo "Install UPX to compress: brew install upx (macOS) or apt install upx (Linux)"
fi

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

# Also copy to backend/web for development
mkdir -p "$PROJECT_DIR/backend/web"
rm -rf "$PROJECT_DIR/backend/web/assets"
cp -r "$PROJECT_DIR/frontend/dist/." "$PROJECT_DIR/backend/web/"

# Build MCP Server
echo ""
echo "--- Building MCP Server ---"
cd "$PROJECT_DIR/mcp-server"
npm install
npm run build

# Build backend for multiple platforms
echo ""
echo "--- Building Backend (cross-compile) ---"
mkdir -p "$RELEASE_DIR"

PLATFORMS=(
  "darwin amd64"
  "darwin arm64"
  "linux amd64"
  "linux arm64"
  "windows amd64"
)

for PLATFORM in "${PLATFORMS[@]}"; do
  set -- $PLATFORM
  GOOS=$1
  GOARCH=$2

  OUTPUT_NAME="kanban-server-${GOOS}-${GOARCH}"
  if [ "$GOOS" = "windows" ]; then
    OUTPUT_NAME="kanban-server-${GOOS}-${GOARCH}.exe"
  fi

  echo "  Building $OUTPUT_NAME..."
  cd "$PROJECT_DIR/backend"
  GOOS=$GOOS GOARCH=$GOARCH go build -ldflags="-s -w" -o "$RELEASE_DIR/$OUTPUT_NAME" ./cmd/server/main.go

  # Compress with UPX if available (max compression)
  if [ "$UPX_OK" = true ]; then
    echo "    Compressing with UPX -9..."
    upx -9 --best "$RELEASE_DIR/$OUTPUT_NAME" 2>&1 || true
  fi

  # Show size
  SIZE=$(ls -lh "$RELEASE_DIR/$OUTPUT_NAME" | awk '{print $5}')
  echo "    Size: $SIZE"
done

# Create web.tar.gz
echo ""
echo "--- Creating web.tar.gz ---"
cd "$RELEASE_DIR"
tar -czf web.tar.gz web/
SIZE=$(ls -lh web.tar.gz | awk '{print $5}')
echo "  web.tar.gz: $SIZE"

# Copy Skill file to release for reference
mkdir -p "$RELEASE_DIR/skill"
cp "$PROJECT_DIR/mcp/MCP_SETUP.md" "$RELEASE_DIR/skill/" 2>/dev/null || true

echo ""
echo "=== Build Complete ==="
echo "Release:  $RELEASE_DIR/"
echo ""
echo "Contents:"
ls -lh "$RELEASE_DIR/"
echo ""
echo "Upload to GitHub Release:"
echo "  - kanban-server-darwin-amd64"
echo "  - kanban-server-darwin-arm64"
echo "  - kanban-server-linux-amd64"
echo "  - kanban-server-linux-arm64"
echo "  - kanban-server-windows-amd64.exe"
echo "  - web.tar.gz"
echo ""
echo "MCP Server: cd mcp-server && npm publish"
