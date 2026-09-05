#!/bin/bash
# release.sh — build open-kanban release artifacts.
#
# Subcommands:
#   (none) / all                 Build everything: frontend, MCP server,
#                                backend for all platforms, web.tar.gz, skill
#                                (the original behavior).
#   backend [TARGETS...]         Build only the backend binaries. Optional
#                                TARGETS are GOOS values (linux, darwin,
#                                windows) or full "GOOS GOARCH" pairs to
#                                filter the target matrix; "all" or no
#                                argument means every supported target.
#   help                         Print this help text.
#
# Examples:
#   ./scripts/release.sh                          # full release
#   ./scripts/release.sh backend                  # backend, all targets
#   ./scripts/release.sh backend linux            # backend, only linux
#   ./scripts/release.sh backend "linux amd64"    # backend, one specific pair
#   ./scripts/release.sh backend darwin windows   # backend, two families
#
# Cross-cutting env vars:
#   PLATFORMS   Newline-separated "GOOS GOARCH" entries that override the
#               default target matrix (e.g. when running release-backend in
#               CI that only ships a subset).
#
# Notes:
#   - Backend builds use the same cross_cc + UPX + -tags release logic
#     regardless of subcommand, so the matrix stays in sync.
#   - The `backend` subcommand skips the npm install / vite build / mcp
#     build / web.tar.gz / skill copy that the full release runs, which
#     saves minutes on iterations that only touch Go code.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
RELEASE_DIR="$PROJECT_DIR/release"

# All supported targets in their canonical (display) order. The full
# release always walks this list; subcommands filter it.
ALL_PLATFORMS=(
  "darwin amd64"
  "darwin arm64"
  "linux amd64"
  "linux arm64"
  "windows amd64"
)

print_help() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
}

# parse_backend_args filters ALL_PLATFORMS by the remaining positional
# args after `backend`. Each arg is either:
#   - "all"                → return ALL_PLATFORMS unchanged
#   - a bare GOOS like "linux" → keep every pair whose first field matches
#   - a full "GOOS GOARCH"   → keep only that exact pair
# Unknown GOOS / GOARCH values fail loudly so typos don't silently
# produce a no-op release.
parse_backend_args() {
  if [ $# -eq 0 ]; then
    PLATFORMS=("${ALL_PLATFORMS[@]}")
    return
  fi
  # Capture the raw args before any `set --` calls below clobber $*,
  # which would otherwise cause the error messages to print the last
  # ALL_PLATFORMS pair instead of what the user actually typed.
  local raw_args="$*"
  local arg goos goarch matched=0
  for arg in "$@"; do
    if [ "$arg" = "all" ]; then
      PLATFORMS=("${ALL_PLATFORMS[@]}")
      return
    fi
  done
  for arg in "$@"; do
    # Bare GOOS (single token, no space).
    if ! [[ "$arg" == *\ * ]]; then
      for pair in "${ALL_PLATFORMS[@]}"; do
        # `local` keeps these set -- assignments from clobbering the
        # outer $* / positional parameters; without it the error
        # branch below would print garbage.
        local pgoos parch
        set -- $pair
        pgoos=$1
        parch=$2
        if [ "$pgoos" = "$arg" ]; then
          PLATFORMS+=("$pair")
          matched=$((matched + 1))
        fi
      done
      continue
    fi
    # Full "GOOS GOARCH".
    goos="${arg%% *}"
    goarch="${arg##* }"
    local found=0
    for pair in "${ALL_PLATFORMS[@]}"; do
      local pgoos parch
      set -- $pair
      pgoos=$1
      parch=$2
      if [ "$pgoos" = "$goos" ] && [ "$parch" = "$goarch" ]; then
        PLATFORMS+=("$pair")
        found=1
        matched=$((matched + 1))
        break
      fi
    done
    if [ "$found" = 0 ]; then
      echo "release.sh backend: unknown target '$arg'" >&2
      echo "  valid: ${ALL_PLATFORMS[*]}" >&2
      exit 1
    fi
  done
  if [ "$matched" = 0 ]; then
    echo "release.sh backend: no matching targets for: $raw_args" >&2
    echo "  valid: ${ALL_PLATFORMS[*]}" >&2
    exit 1
  fi
}

# Allow PLATFORMS env var to override the matrix regardless of subcommand.
# This is convenient for CI scripts that already pass PLATFORMS=... and
# don't want to repeat the args on the command line.
load_platforms_from_env() {
  if [ -n "${PLATFORMS:-}" ]; then
    PLATFORMS=()
    while IFS= read -r line; do
      [ -n "$line" ] && PLATFORMS+=("$line")
    done <<< "$PLATFORMS"
  fi
}

# ---------------------------------------------------------------------------
# Subcommand dispatch
# ---------------------------------------------------------------------------
SUBCMD="${1:-all}"
# Shift off the subcommand but keep the rest for subcommand parsing.
if [ $# -gt 0 ]; then shift; fi

case "$SUBCMD" in
  all|"")
    DO_FRONTEND=1
    DO_MCP=1
    DO_BACKEND=1
    DO_WEB_TARBALL=1
    DO_SKILL=1
    PLATFORMS=("${ALL_PLATFORMS[@]}")
    load_platforms_from_env
    ;;
  backend)
    DO_FRONTEND=0
    DO_MCP=0
    DO_BACKEND=1
    DO_WEB_TARBALL=0
    DO_SKILL=0
    if [ -n "${PLATFORMS:-}" ]; then
      load_platforms_from_env
    else
      parse_backend_args "$@"
    fi
    ;;
  help|--help|-h)
    print_help
    exit 0
    ;;
  *)
    echo "release.sh: unknown subcommand: $SUBCMD" >&2
    echo "  run '$0 help' for usage" >&2
    exit 1
    ;;
esac

# ---------------------------------------------------------------------------
# Build stages
# ---------------------------------------------------------------------------
echo "=== Building open-kanban (subcommand: ${SUBCMD:-all}) ==="
echo "Output dir: $RELEASE_DIR"
echo "Targets:    ${PLATFORMS[*]}"
echo

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
if [ "$DO_FRONTEND" = 1 ]; then
  echo ""
  echo "--- Building Frontend ---"
  cd "$PROJECT_DIR/frontend"
  npm install --legacy-peer-deps
  npm run build

  # Copy dist to release directory
  rm -rf "$RELEASE_DIR/web"
  mkdir -p "$RELEASE_DIR/web"
  cp -r "$PROJECT_DIR/frontend/dist/." "$RELEASE_DIR/web/"

  # Also copy to backend/web for development
  mkdir -p "$PROJECT_DIR/backend/web"
  rm -rf "$PROJECT_DIR/backend/web/assets"
  cp -r "$PROJECT_DIR/frontend/dist/." "$PROJECT_DIR/backend/web/"
fi

# Build MCP Server
if [ "$DO_MCP" = 1 ]; then
  echo ""
  echo "--- Building MCP Server ---"
  cd "$PROJECT_DIR/mcp-server"
  npm install --legacy-peer-deps
  npm run build
fi

# Build backend for multiple platforms
if [ "$DO_BACKEND" = 1 ]; then
  echo ""
  echo "--- Building Backend (cross-compile) ---"
  mkdir -p "$RELEASE_DIR"

  # Host info for cross-compile CGO detection.
  HOST_GOOS=$(go env GOOS)
  HOST_GOARCH=$(go env GOARCH)

  # cross_cc echoes the C compiler path to use when CGO is required for the
  # given target. Returns:
  #   - the literal string "native" when target == host (caller uses system cc)
  #   - a concrete cc path (e.g. x86_64-linux-gnu-gcc) when a GNU-style cross
  #     toolchain is installed for the target
  #   - the empty string when no cross toolchain is available, in which case
  #     the SQLite-default build can't be produced and the caller should
  #     skip it (the MySQL-only build, which uses a pure-Go driver, can still
  #     be cross-compiled for any target).
  cross_cc() {
    local goos=$1 goarch=$2
    if [ "$goos" = "$HOST_GOOS" ] && [ "$goarch" = "$HOST_GOARCH" ]; then
      echo "native"
      return
    fi
    local triple=""
    case "$goos" in
      linux)
        case "$goarch" in
          amd64) triple="x86_64-linux-gnu" ;;
          arm64) triple="aarch64-linux-gnu" ;;
          *)     triple="" ;;
        esac
        ;;
      windows)
        case "$goarch" in
          amd64) triple="x86_64-w64-mingw32" ;;
          arm64) triple="aarch64-w64-mingw32" ;;
          *)     triple="" ;;
        esac
        ;;
      darwin)
        # CGO cross from a non-darwin host requires osxcross (clang + SDK).
        # Probe for the standard osxcross wrapper binaries.
        case "$goarch" in
          amd64)
            if command -v o64-clang >/dev/null 2>&1; then
              echo "o64-clang"
              return
            fi
            ;;
          arm64)
            if command -v oa64-clang >/dev/null 2>&1; then
              echo "oa64-clang"
              return
            fi
            ;;
        esac
        echo ""
        return
        ;;
      *)
        echo ""
        return
        ;;
    esac
    if [ -n "$triple" ] && command -v "${triple}-gcc" >/dev/null 2>&1; then
      echo "${triple}-gcc"
      return
    fi
    echo ""
  }

  for PLATFORM in "${PLATFORMS[@]}"; do
    set -- $PLATFORM
    GOOS=$1
    GOARCH=$2

    OUTPUT_NAME="kanban-server-${GOOS}-${GOARCH}"
    if [ "$GOOS" = "windows" ]; then
      OUTPUT_NAME="kanban-server-${GOOS}-${GOARCH}.exe"
    fi

    echo ""
    echo "  Building $OUTPUT_NAME..."
    cd "$PROJECT_DIR/backend"

    # Remove any leftover from a previous release run before rebuilding. The
    # previous binary may already be UPX-packed, and upx refuses to re-pack
    # a file that already has a UPX header (AlreadyPackedException). Removing
    # the stale file (and upx's `.upx` backup, if any) guarantees the next
    # `go build` writes a fresh, unpacked binary and upx can compress it.
    rm -f "$RELEASE_DIR/$OUTPUT_NAME" "$RELEASE_DIR/$OUTPUT_NAME.upx"

    # The default (non-MySQL) build embeds go-sqlite3, which is a CGO package.
    # Decide whether we can satisfy CGO for this target: native build uses
    # the system cc, cross builds need a matching toolchain installed on the
    # host (apt: gcc-x86-64-linux-gnu / gcc-aarch64-linux-gnu /
    # gcc-mingw-w64-x86-64; brew: x86_64-linux-gnu-gcc / aarch64-linux-gnu-gcc
    # / mingw-w64; darwin targets additionally need osxcross). When no
    # cross-toolchain is available we skip the SQLite build for that target
    # and continue — the MySQL-only variant (pure-Go driver) is still
    # produced and is sufficient for users on MySQL.
    CC_BIN=$(cross_cc "$GOOS" "$GOARCH")
    if [ -n "$CC_BIN" ]; then
      if [ "$CC_BIN" = "native" ]; then
        CGO_ENABLED=1 go build -tags="release" -ldflags="-s -w" -o "$RELEASE_DIR/$OUTPUT_NAME" ./cmd/server/main.go
      else
        CGO_ENABLED=1 GOOS=$GOOS GOARCH=$GOARCH CC="$CC_BIN" \
          go build -tags="release" -ldflags="-s -w" -o "$RELEASE_DIR/$OUTPUT_NAME" ./cmd/server/main.go
      fi

      # Compress with UPX if available (max compression)
      if [ "$UPX_OK" = true ]; then
        echo "    Compressing with UPX -9..."
        upx -9 --best "$RELEASE_DIR/$OUTPUT_NAME" 2>&1 || true
      fi

      # Show size
      SIZE=$(ls -lh "$RELEASE_DIR/$OUTPUT_NAME" | awk '{print $5}')
      echo "    Size: $SIZE"
    else
      echo "    SKIP: no CGO cross-compile toolchain for ${GOOS}/${GOARCH}." >&2
      echo "          The default build embeds go-sqlite3 which requires CGO." >&2
      echo "          Install a matching toolchain (apt: gcc-x86-64-linux-gnu /" >&2
      echo "          gcc-aarch64-linux-gnu / gcc-mingw-w64-x86-64; brew:" >&2
      echo "          x86_64-linux-gnu-gcc / aarch64-linux-gnu-gcc / mingw-w64;" >&2
      echo "          darwin targets additionally need osxcross) or run this" >&2
      echo "          release on a native ${GOOS} host to produce the SQLite build." >&2
      echo "          The MySQL-only variant below is built without CGO." >&2
    fi

    # Build MySQL-only version
    MYSQL_OUTPUT_NAME="kanban-server-${GOOS}-${GOARCH}-mysql"
    if [ "$GOOS" = "windows" ]; then
      MYSQL_OUTPUT_NAME="kanban-server-${GOOS}-${GOARCH}-mysql.exe"
    fi

    echo "  Building $MYSQL_OUTPUT_NAME (MySQL-only)..."
    # MySQL-only build uses pure-Go driver, no CGO needed regardless of host.
    # Same stale-file cleanup as the SQLite build above: a previous release
    # may have left an UPX-packed binary at this path.
    rm -f "$RELEASE_DIR/$MYSQL_OUTPUT_NAME" "$RELEASE_DIR/$MYSQL_OUTPUT_NAME.upx"
    GOOS=$GOOS GOARCH=$GOARCH go build -tags "mysql && release && !sqlite" -ldflags="-s -w" -o "$RELEASE_DIR/$MYSQL_OUTPUT_NAME" ./cmd/server/main.go

    # Compress with UPX if available (max compression)
    if [ "$UPX_OK" = true ]; then
      echo "    Compressing with UPX -9..."
      upx -9 --best "$RELEASE_DIR/$MYSQL_OUTPUT_NAME" 2>&1 || true
    fi

    # Show size
    SIZE=$(ls -lh "$RELEASE_DIR/$MYSQL_OUTPUT_NAME" | awk '{print $5}')
    echo "    Size: $SIZE"
  done
fi

# Create web.tar.gz
if [ "$DO_WEB_TARBALL" = 1 ]; then
  echo ""
  echo "--- Creating web.tar.gz ---"
  cd "$RELEASE_DIR"
  tar -czf web.tar.gz web/
  SIZE=$(ls -lh web.tar.gz | awk '{print $5}')
  echo "  web.tar.gz: $SIZE"
fi

# Copy Skill file to release for reference
if [ "$DO_SKILL" = 1 ]; then
  mkdir -p "$RELEASE_DIR/skill"
  cp "$PROJECT_DIR/mcp/MCP_SETUP.md" "$RELEASE_DIR/skill/" 2>/dev/null || true
fi

echo ""
echo "=== Build Complete (${SUBCMD:-all}) ==="
echo "Release:  $RELEASE_DIR/"
echo ""
echo "Contents:"
ls -lh "$RELEASE_DIR/"
echo ""
if [ "$DO_BACKEND" = 1 ]; then
  echo "Upload to GitHub Release:"
  echo "  - kanban-server-darwin-amd64"
  echo "  - kanban-server-darwin-arm64"
  echo "  - kanban-server-linux-amd64"
  echo "  - kanban-server-linux-arm64"
  echo "  - kanban-server-windows-amd64.exe"
  echo "  - kanban-server-darwin-amd64-mysql"
  echo "  - kanban-server-darwin-arm64-mysql"
  echo "  - kanban-server-linux-amd64-mysql"
  echo "  - kanban-server-linux-arm64-mysql"
  echo "  - kanban-server-windows-amd64-mysql.exe"
  echo ""
  echo "MySQL-only builds (no SQLite):"
  echo "  - kanban-server-*-mysql"
fi
if [ "$DO_MCP" = 1 ]; then
  echo ""
  echo "MCP Server: cd mcp-server && npm publish"
fi
