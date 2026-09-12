package main

import (
	"os"
	"testing"

	"github.com/gin-gonic/gin"
)

// TestGinModeDefaultIsRelease guarantees that a plain `go build` of the
// server (the binary that ships via scripts/build-backend.sh, the GitHub
// release workflow, and the npm build) never starts in gin's debug mode.
//
// Debug mode in gin prints every route registration and request to stdout,
// which leaks internal structure and is noisy enough to be mistaken for a
// crash dump in production logs. The only way to legitimately enable debug
// mode at build time is `-tags debug` (see cmd/server/mode_debug.go), which
// also flips gin.Mode() to DebugMode. Anyone who re-introduces a debug
// default — e.g. by deleting mode_default.go's build tag — will fail this
// test on the default build and at minimum has to acknowledge the change.
//
// When the test binary itself is compiled with `-tags debug` or
// `-tags release`, this assertion intentionally flips so the same test file
// stays valid across all three build configurations.
func TestGinModeDefaultIsRelease(t *testing.T) {
	want := gin.ReleaseMode
	if debugBuild {
		want = gin.DebugMode
	}

	if got := gin.Mode(); got != want {
		t.Errorf("gin.Mode() = %q, want %q (debugBuild=%v releaseBuild=%v)",
			got, want, debugBuild, releaseBuild)
	}
}

// TestGinModeEnvMatchesBuildTag guards the GIN_MODE environment variable
// against drifting away from the gin internal mode set by our init().
//
// gin.SetMode updates gin's internal state but does NOT write back to
// GIN_MODE, so any code that reads os.Getenv("GIN_MODE") (including the
// self-restart child process spawned from setup, and Go's test runner
// which exports GIN_MODE to subprocess tests) would silently observe the
// gin default (debug) even when we explicitly set release mode.
//
// mode_default.go, mode_release.go, and mode_debug.go all call
// os.Setenv("GIN_MODE", ...) in init() precisely so the env var agrees
// with gin.Mode(). This test asserts that agreement holds across all
// three build configurations, regardless of any later gin.SetMode calls
// from individual test functions (e.g. TestCorsMiddleware...).
func TestGinModeEnvMatchesBuildTag(t *testing.T) {
	want := gin.ReleaseMode
	if debugBuild {
		want = gin.DebugMode
	}

	if got := os.Getenv("GIN_MODE"); got != want {
		t.Errorf("GIN_MODE = %q, want %q (debugBuild=%v releaseBuild=%v)",
			got, want, debugBuild, releaseBuild)
	}
}