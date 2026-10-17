#!/bin/bash
# Boots the backend for the Playwright e2e suite.
#
# - Uses a throwaway SQLite database so each run starts from a clean
#   slate (global-setup then seeds the first admin + a public board).
# - Drops in a placeholder cmd/server/web/index.html when the frontend
#   bundle hasn't been embedded, because `//go:embed web` in
#   cmd/server/main.go fails to compile against an empty directory.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR/backend"

if [ -z "$(ls -A cmd/server/web 2>/dev/null)" ]; then
  mkdir -p cmd/server/web
  cat > cmd/server/web/index.html <<'EOF'
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>open-kanban</title></head>
<body><h1>open-kanban</h1><p>E2E placeholder build.</p></body>
</html>
EOF
fi

export PORT="${PORT:-8081}"
export DATABASE_URL="${E2E_DATABASE_URL:-/tmp/open-kanban-e2e.db}"
# The Playwright frontend is served by the Vite dev server on 5173, so
# the WebSocket origin check must accept it (the default only allows
# http://localhost:$PORT, which would 403 every /ws upgrade).
export ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-http://localhost:5173,http://localhost:8081}"

rm -f "$DATABASE_URL" "$DATABASE_URL-shm" "$DATABASE_URL-wal"

exec go run ./cmd/server
