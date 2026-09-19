//go:build !debug && !release

package main

import (
	"os"

	"github.com/gin-gonic/gin"
)

// applyDefaultServerMode pins Gin to release mode unless the operator
// passes the explicit `-tags debug` build tag (see mode_debug.go) or
// the explicit `-tags release` build tag (see mode_release.go).
//
// gin.SetMode updates Gin's internal mode but does NOT write back to
// the GIN_MODE env var. Set it explicitly so subprocesses (e.g. the
// self-restart child) and any code that reads os.Getenv("GIN_MODE")
// see "release" too.
//
// We deliberately override any GIN_MODE the operator may have
// inherited from their shell: the default build is intended for
// production / normal local runs, where verbose debug logs are not
// wanted. s-1225.
func applyDefaultServerMode() {
	_ = os.Setenv("GIN_MODE", gin.ReleaseMode)
	gin.SetMode(gin.ReleaseMode)
}

func init() {
	applyDefaultServerMode()
}
