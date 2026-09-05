package handlers

import (
	"fmt"
	"os"
	"strings"
)

func splitOrigins(origins string) []string {
	var result []string
	for _, o := range strings.Split(origins, ",") {
		o = strings.TrimSpace(o)
		if o != "" {
			result = append(result, o)
		}
	}
	return result
}

// GetAllowedOrigins returns the list of allowed CORS origins.
// It prefers the ALLOWED_ORIGINS environment variable; if unset or empty,
// it falls back to "http://localhost:<PORT>" (default PORT is "8080").
func GetAllowedOrigins() []string {
	if raw := os.Getenv("ALLOWED_ORIGINS"); raw != "" {
		return splitOrigins(raw)
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	return []string{fmt.Sprintf("http://localhost:%s", port)}
}
