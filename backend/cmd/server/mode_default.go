//go:build !debug && !release

package main

import (
	"os"

	"github.com/gin-gonic/gin"
)

func init() {
	// gin.SetMode updates Gin's internal mode but does NOT write back to
	// the GIN_MODE env var. Set it explicitly so subprocesses (e.g. the
	// self-restart child) and any code that reads os.Getenv("GIN_MODE")
	// see "release" too.
	_ = os.Setenv("GIN_MODE", gin.ReleaseMode)
	gin.SetMode(gin.ReleaseMode)
}
