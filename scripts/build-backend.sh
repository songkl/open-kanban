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
    cp -r "$PROJECT_DIR/frontend/dist/." cmd/server/web/
fi

# Fallback: if `web/` is still empty (fresh clone, frontend never
# built), drop a minimal placeholder index.html in place. The
# `//go:embed web` directive in cmd/server/main.go requires the
# pattern to match at least one non-hidden file at compile time;
# without this the build fails with "pattern web: no matching
# files found". The placeholder renders a "build the frontend"
# hint at runtime so the operator isn't confused by an empty
# page after `go run` against this minimal binary.
if [ -z "$(ls -A cmd/server/web 2>/dev/null)" ]; then
    echo "frontend/dist not found; writing placeholder web/index.html so the embed has at least one file."
    mkdir -p cmd/server/web
    cat > cmd/server/web/index.html <<'EOF'
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>open-kanban</title>
</head>
<body>
  <h1>open-kanban</h1>
  <p>Frontend bundle not built. Run <code>cd frontend &amp;&amp; npm run build</code> and rebuild the backend to embed the real SPA.</p>
</body>
</html>
EOF
fi

go build -ldflags="-s -w" -o kanban-server ./cmd/server/main.go

echo "Backend built: $PROJECT_DIR/backend/kanban-server"
