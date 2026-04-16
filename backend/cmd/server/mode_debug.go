//go:build debug

package main

import "github.com/gin-gonic/gin"

func init() {
	gin.SetMode(gin.DebugMode)
}
