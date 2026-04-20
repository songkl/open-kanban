//go:build release

package main

import (
	"log"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"
)

func init() {
	gin.SetMode(gin.ReleaseMode)
	initReleaseLogging()
}

func initReleaseLogging() {
	logDir := os.Getenv("LOG_DIR")
	logLevel := getLogLevel(os.Getenv("LOG_LEVEL"))

	var handler slog.Handler
	if logDir != "" {
		if err := os.MkdirAll(logDir, 0755); err != nil {
			log.Printf("Warning: Failed to create log directory %s: %v, using stdout", logDir, err)
			handler = slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: logLevel})
		} else {
			logFile := filepath.Join(logDir, "server.log")
			file, err := os.OpenFile(logFile, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
			if err != nil {
				log.Printf("Warning: Failed to open log file %s: %v, using stdout", logFile, err)
				handler = slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: logLevel})
			} else {
				handler = slog.NewTextHandler(file, &slog.HandlerOptions{Level: logLevel})
			}
		}
	} else {
		handler = slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: logLevel})
	}

	slog.SetDefault(slog.New(handler))
}

func getLogLevel(level string) slog.Level {
	switch strings.ToLower(level) {
	case "debug":
		return slog.LevelDebug
	case "info":
		return slog.LevelInfo
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}
