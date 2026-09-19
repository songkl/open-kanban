#!/bin/bash
# release.sh — build open-kanban release artifacts.
#
# Default behavior: BUILD ALL
#   When invoked with no arguments (or with the explicit `all` subcommand),
#   release.sh builds every component of the release: the frontend
#   (npm install + vite build + dist copy), the MCP server (npm install +
#   build), the backend cross-compiled for every supported platform (both
#   the SQLite-default and the MySQL-only variants), the web.tar.gz
#   tarball of the built frontend, and the skill/ directory. This is the
#   behaviour the project's README documents as "Cross-platform release"
#   (`./scripts/release.sh`) and matches the original pre-subcommand
#   implementation; the `backend` subcommand below is an opt-in shortcut
#   for backend-only iterations and does NOT change the default.
#
# Subcommands:
#   (none) / all                 Build everything (DEFAULT): frontend, MCP
#                                server, backend for all platforms,
#                                web.tar.gz, skill.
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

# Capture PLATFORMS env override at script start, before any PLATFORMS
# array assignment below. In bash 3.2 (still the default on macOS),
# assigning `PLATFORMS=("${ALL_PLATFORMS[@]}")` after the variable was
# inherited as a scalar env var converts it to an array attribute,
# which would then make `${PLATFORMS:-}` return the first array element
# ("darwin amd64") instead of the user's env override — the
# load_platforms_from_env() function would then clobber the freshly-set
# PLATFORMS array with an empty list, and `set -e` would silently abort
# the release. Stashing the raw env value into _ENV_PLATFORMS first
# avoids that whole class of bug.
_ENV_PLATFORMS="${PLATFORMS:-}"
unset PLATFORMS

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
  sed -n '2,44p' "$0" | sed 's/^# \{0,1\}//'
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
      local bare_match=0
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
          bare_match=1
        fi
      done
      if [ "$bare_match" = 0 ]; then
        echo "release.sh backend: unknown GOOS '$arg'" >&2
        echo "  valid GOOS: linux darwin windows" >&2
        exit 1
      fi
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
#
# Implementation note: the caller has already populated PLATFORMS as a
# shell array (PLATFORMS=("${ALL_PLATFORMS[@]}")). A naive `${PLATFORMS:-}`
# check inside this function would always succeed (the array's first
# element is non-empty), which used to clobber the freshly-built matrix
# with an empty array and then trip `set -e` on the trailing failed read,
# silently aborting the whole release. The original env value is captured
# into _ENV_PLATFORMS at script start (see below) so this function can
# distinguish "user exported PLATFORMS" from "we just assigned the array".
load_platforms_from_env() {
  if [ -n "${_ENV_PLATFORMS:-}" ]; then
    PLATFORMS=()
    while IFS= read -r line; do
      [ -n "$line" ] && PLATFORMS+=("$line")
    done <<< "$_ENV_PLATFORMS"
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
    if [ -n "${_ENV_PLATFORMS:-}" ]; then
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
echo "Components: frontend=$([ "$DO_FRONTEND" = 1 ] && echo yes || echo no) mcp=$([ "$DO_MCP" = 1 ] && echo yes || echo no) backend=$([ "$DO_BACKEND" = 1 ] && echo yes || echo no) web.tar.gz=$([ "$DO_WEB_TARBALL" = 1 ] && echo yes || echo no) skill=$([ "$DO_SKILL" = 1 ] && echo yes || echo no)"
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
  #
  # The triple list tries the most common packaging names first so a host
  # with multiple cross-compilers (apt + Homebrew + a vendored toolchain)
  # always picks the conventional one. If the binary name ends in a version
  # suffix (Debian/Ubuntu gcc-X / clang-X packages sometimes only symlink
  # the versioned form into /usr/bin), we also accept `<triple>-gcc-*` to
  # avoid a spurious SKIP when only the versioned symlink is on PATH.
  cross_cc() {
    local goos=$1 goarch=$2
    if [ "$goos" = "$HOST_GOOS" ] && [ "$goarch" = "$HOST_GOARCH" ]; then
      echo "native"
      return
    fi
    local triples=()
    case "$goos" in
      linux)
        case "$goarch" in
          amd64)
            # Debian/Ubuntu: gcc-x86-64-linux-gnu provides x86_64-linux-gnu-gcc.
            # Homebrew (Apple Silicon & Linuxbrew): x86_64-linux-gnu-gcc.
            # Gentoo crossdev: x86_64-pc-linux-gnu-gcc.
            # Fedora/RHEL: gcc-x86_64-linux-gnu (same binary name as Debian).
            # Some distros also ship a musl variant for static builds.
            triples=(
              "x86_64-linux-gnu"
              "x86_64-pc-linux-gnu"
              "x86_64-linux-musl"
              "x86_64-elf"
            )
            ;;
          arm64)
            # Debian/Ubuntu: gcc-aarch64-linux-gnu; Homebrew: aarch64-linux-gnu-gcc.
            # Gentoo crossdev: aarch64-unknown-linux-gnu-gcc.
            triples=(
              "aarch64-linux-gnu"
              "aarch64-unknown-linux-gnu"
              "aarch64-pc-linux-gnu"
              "aarch64-linux-musl"
              "aarch64-elf"
            )
            ;;
        esac
        ;;
      windows)
        case "$goarch" in
          amd64)
            # Debian/Ubuntu: gcc-mingw-w64-x86-64; Homebrew: x86_64-w64-mingw32-gcc.
            # Some setups only expose the bare mingw-w64-gcc wrapper.
            triples=("x86_64-w64-mingw32" "mingw-w64" "x86_64-mingw32")
            ;;
          arm64)
            triples=("aarch64-w64-mingw32" "aarch64-mingw32")
            ;;
        esac
        ;;
      darwin)
        # CGO cross from a non-darwin host requires osxcross (clang + SDK).
        # Probe for the standard osxcross wrapper binaries first, then
        # newer SDK-versioned names that recent osxcross releases ship.
        local osxcross_wrappers=()
        case "$goarch" in
          amd64)
            osxcross_wrappers=(
              "o64-clang"
              "x86_64-apple-darwin-clang"
              "x86_64-apple-darwin20.4-clang"
              "x86_64-apple-darwin21-clang"
              "x86_64-apple-darwin22-clang"
            )
            ;;
          arm64)
            osxcross_wrappers=(
              "oa64-clang"
              "arm64-apple-darwin-clang"
              "aarch64-apple-darwin-clang"
              "arm64-apple-darwin20.4-clang"
              "arm64-apple-darwin21-clang"
              "arm64-apple-darwin22-clang"
            )
            ;;
        esac
        local wrapper
        for wrapper in "${osxcross_wrappers[@]}"; do
          if command -v "$wrapper" >/dev/null 2>&1; then
            echo "$wrapper"
            return
          fi
        done
        echo ""
        return
        ;;
      *)
        echo ""
        return
        ;;
    esac
    # Try a list of suffixes per triple: the GNU -gcc form is most
    # common on Debian/Ubuntu and Homebrew; some toolchains ship clang
    # under the GNU name instead, so probe that too. After the bare
    # names, also probe `<triple>-gcc-*` / `<triple>-clang-*` to catch
    # Debian's `update-alternatives` symlinks that only expose the
    # versioned binary (e.g. aarch64-linux-gnu-gcc-12) on PATH.
    local triple suffix candidate_bin
    for triple in "${triples[@]}"; do
      for suffix in "-gcc" "-cc" "-clang"; do
        if command -v "${triple}${suffix}" >/dev/null 2>&1; then
          echo "${triple}${suffix}"
          return
        fi
      done
      # Versioned fallbacks: walk every PATH directory and pick the
      # highest-versioned `<triple>-{gcc,clang}-X[.Y]*` so we don't
      # spuriously SKIP a host where only `update-alternatives` has
      # installed the versioned symlink (common on Debian/Ubuntu and
      # RHEL after `update-alternatives --set`). The numeric-only
      # case keeps unrelated tooling (e.g. `<triple>-gcc-ar` from
      # binutils) out of the result set.
      for suffix in "-gcc-" "-clang-"; do
        local found_bin=""
        local IFS=':'
        local _path_dirs
        read -r -a _path_dirs <<< "${PATH:-}"
        local dir candidate_bin
        for dir in "${_path_dirs[@]}"; do
          [ -d "$dir" ] || continue
          for candidate_bin in "$dir/${triple}${suffix}"*; do
            [ -x "$candidate_bin" ] || continue
            case "$(basename "$candidate_bin")" in
              ${triple}${suffix}[0-9]*)
                if [ -z "$found_bin" ] \
                  || [ "$(basename "$candidate_bin")" \> "$(basename "$found_bin")" ]; then
                  found_bin="$candidate_bin"
                fi
                ;;
            esac
          done
        done
        if [ -n "$found_bin" ]; then
          echo "$found_bin"
          return
        fi
      done
    done
    echo ""
  }

  # cross_cc_hint prints concrete package-install commands that would
  # unblock the cross-build for the given target. Used by the SKIP
  # branch below so the user sees an actionable hint for the target
  # that actually failed (not a generic dump for every target). Output
  # is prefixed with the same indent the SKIP message uses.
  cross_cc_hint() {
    local goos=$1 goarch=$2
    case "$goos" in
      linux)
        case "$goarch" in
          amd64)
            echo "            apt:    sudo apt-get install -y gcc-x86-64-linux-gnu" >&2
            echo "            dnf:    sudo dnf install -y gcc-x86_64-linux-gnu" >&2
            echo "            brew:   brew install x86_64-linux-gnu-gcc" >&2
            echo "            musl:   sudo apt-get install -y gcc-x86-64-linux-musl" >&2
            ;;
          arm64)
            echo "            apt:    sudo apt-get install -y gcc-aarch64-linux-gnu" >&2
            echo "            dnf:    sudo dnf install -y gcc-aarch64-linux-gnu" >&2
            echo "            brew:   brew install aarch64-linux-gnu-gcc" >&2
            echo "            musl:   sudo apt-get install -y gcc-aarch64-linux-musl" >&2
            ;;
        esac
        ;;
      windows)
        case "$goarch" in
          amd64)
            echo "            apt:    sudo apt-get install -y gcc-mingw-w64-x86-64" >&2
            echo "            brew:   brew install mingw-w64" >&2
            ;;
          arm64)
            echo "            apt:    sudo apt-get install -y gcc-mingw-w64-aarch64" >&2
            echo "            brew:   brew install mingw-w64" >&2
            ;;
        esac
        ;;
      darwin)
        echo "            darwin cross-builds need osxcross: https://github.com/tpoechtrager/osxcross" >&2
        ;;
    esac
  }

  # Track which targets produced a full SQLite build and which only got
  # the MySQL-only fallback, so we can print a clear summary at the end
  # (helps catch the "release only produced -mysql variants" case the
  # user reported when no cross-toolchain is installed).
  SQLITE_BUILT=()
  SQLITE_SKIPPED=()

  # Pre-flight: verify that a system C compiler is actually reachable when
  # the target matrix contains the host platform. Without this check the
  # user gets a cryptic "gcc: command not found" from `go build` deep into
  # the loop — after the frontend/MCP builds already burned minutes of
  # time. Probe `cc` first (the POSIX name Go falls back to), then the
  # distro-packaged gcc/clang, so Alpine (musl, `cc` symlink to gcc-mllib)
  # and minimal containers (only `cc`) both resolve cleanly. Uses an
  # in-shell loop instead of grep so it works on minimal PATHs (e.g.
  # scratch containers, musl rescue shells) where grep itself is missing.
  _NATIVE_TARGET_HIT=0
  _P_PLATFORM=""
  for _P_PLATFORM in "${PLATFORMS[@]}"; do
    if [ "$_P_PLATFORM" = "${HOST_GOOS} ${HOST_GOARCH}" ]; then
      _NATIVE_TARGET_HIT=1
      break
    fi
  done
  if [ "$_NATIVE_TARGET_HIT" = 1 ]; then
    if ! command -v cc >/dev/null 2>&1 \
       && ! command -v gcc >/dev/null 2>&1 \
       && ! command -v clang >/dev/null 2>&1; then
      echo "    ERROR: native build for ${HOST_GOOS}/${HOST_GOARCH} needs a C" >&2
      echo "           compiler (cc / gcc / clang) but none were found on PATH." >&2
      echo "           Install one, e.g.:" >&2
      echo "             apt:   sudo apt-get install -y gcc" >&2
      echo "             dnf:   sudo dnf install -y gcc" >&2
      echo "             brew:  brew install gcc" >&2
      echo "             apk:   sudo apk add gcc musl-dev" >&2
      echo "           Then re-run this script." >&2
      exit 1
    fi
  fi

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
      SQLITE_BUILT+=("${GOOS}/${GOARCH} (cc=${CC_BIN})")
    else
      echo "    SKIP: no CGO cross-compile toolchain for ${GOOS}/${GOARCH}." >&2
      echo "          The default build embeds go-sqlite3 which requires CGO." >&2
      echo "          Install a matching toolchain, e.g.:" >&2
      cross_cc_hint "$GOOS" "$GOARCH" >&2
      echo "          Or run this release on a native ${GOOS} host to produce the SQLite build." >&2
      echo "          The MySQL-only variant below is built without CGO." >&2
      SQLITE_SKIPPED+=("${GOOS}/${GOARCH}")
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

# Post-build sanity check for the default `all` subcommand: every component
# the default promises to build must have produced an artifact. Catches
# silent partial-build failures (e.g. an `npm install` that errored out
# without `set -e` propagating) so the user does not upload a release that
# is missing the frontend, MCP, web.tar.gz, or skill. The check is gated
# on the DO_* flags so it does not run for `backend`, where the other
# artifacts are intentionally absent.
MISSING=()
if [ "$DO_FRONTEND" = 1 ] && [ ! -f "$RELEASE_DIR/web/index.html" ]; then
  MISSING+=("web/index.html (frontend)")
fi
if [ "$DO_MCP" = 1 ] && [ ! -f "$PROJECT_DIR/mcp-server/dist/index.js" ]; then
  MISSING+=("mcp-server/dist/index.js (mcp)")
fi
if [ "$DO_BACKEND" = 1 ] && ! ls "$RELEASE_DIR"/kanban-server-*-mysql >/dev/null 2>&1; then
  MISSING+=("kanban-server-*-mysql (backend)")
fi
if [ "$DO_WEB_TARBALL" = 1 ] && [ ! -f "$RELEASE_DIR/web.tar.gz" ]; then
  MISSING+=("web.tar.gz")
fi
if [ "$DO_SKILL" = 1 ] && [ ! -d "$RELEASE_DIR/skill" ]; then
  MISSING+=("skill/")
fi
if [ "${#MISSING[@]}" -gt 0 ]; then
  echo "ERROR: default build is incomplete; missing artifacts:" >&2
  for m in "${MISSING[@]}"; do
    echo "  - $m" >&2
  done
  exit 1
fi

if [ "$DO_BACKEND" = 1 ]; then
  if [ "${#SQLITE_BUILT[@]}" -gt 0 ]; then
    echo "SQLite (full) builds produced:"
    for t in "${SQLITE_BUILT[@]}"; do
      echo "  - $t"
    done
  fi
  if [ "${#SQLITE_SKIPPED[@]}" -gt 0 ]; then
    echo ""
    echo "SQLite builds SKIPPED (no CGO cross-toolchain on this host):"
    for t in "${SQLITE_SKIPPED[@]}"; do
      echo "  - $t   (only the -mysql variant was produced)"
    done
    echo ""
    echo "MySQL-only builds (no SQLite) are still produced for the targets above."
  fi
  echo ""
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
