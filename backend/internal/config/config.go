package config

import (
	"os"
	"strconv"
	"time"
)

type Config struct {
	WebSocket WebSocketConfig
	RateLimit RateLimitConfig
	Broadcast BroadcastConfig
	Webhook   WebhookConfig
}

type WebSocketConfig struct {
	PingInterval          time.Duration
	PingWriteDeadline     time.Duration
	ReadDeadline          time.Duration
	MaxConnections        int
	MaxConnectionsPerUser int
}

type RateLimitConfig struct {
	MaxRateLimitEntries       int
	MaxGlobalRateLimitEntries int
}

type BroadcastConfig struct {
	WriteDeadline time.Duration
}

type WebhookConfig struct {
	Timeout time.Duration
}

var cfg *Config

func getEnvInt(key string, defaultVal int) int {
	if val := os.Getenv(key); val != "" {
		if intVal, err := strconv.Atoi(val); err == nil && intVal > 0 {
			return intVal
		}
	}
	return defaultVal
}

func getEnvDuration(key string, defaultVal time.Duration) time.Duration {
	if val := os.Getenv(key); val != "" {
		if intVal, err := strconv.Atoi(val); err == nil && intVal > 0 {
			return time.Duration(intVal) * time.Second
		}
	}
	return defaultVal
}

func InitConfig() *Config {
	cfg = &Config{
		WebSocket: WebSocketConfig{
			PingInterval:          getEnvDuration("WS_PING_INTERVAL", 30*time.Second),
			PingWriteDeadline:     getEnvDuration("WS_PING_WRITE_DEADLINE", 10*time.Second),
			ReadDeadline:          getEnvDuration("WS_READ_DEADLINE", 40*time.Second),
			MaxConnections:        getEnvInt("WS_MAX_CONNECTIONS", 100),
			MaxConnectionsPerUser: getEnvInt("WS_MAX_CONNECTIONS_PER_USER", 5),
		},
		RateLimit: RateLimitConfig{
			MaxRateLimitEntries:       getEnvInt("RATE_LIMIT_MAX_ENTRIES", 10000),
			MaxGlobalRateLimitEntries: getEnvInt("GLOBAL_RATE_LIMIT_MAX_ENTRIES", 10000),
		},
		Broadcast: BroadcastConfig{
			WriteDeadline: getEnvDuration("BROADCAST_WRITE_DEADLINE", 2*time.Second),
		},
		Webhook: WebhookConfig{
			Timeout: getEnvDuration("WEBHOOK_TIMEOUT", 10*time.Second),
		},
	}
	return cfg
}

func GetConfig() *Config {
	if cfg == nil {
		return InitConfig()
	}
	return cfg
}
