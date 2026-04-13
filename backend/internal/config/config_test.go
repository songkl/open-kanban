package config

import (
	"os"
	"testing"
	"time"
)

func TestGetEnvInt(t *testing.T) {
	_ = os.Setenv("TEST_INT_KEY", "123")
	defer func() { _ = os.Unsetenv("TEST_INT_KEY") }()

	result := getEnvInt("TEST_INT_KEY", 0)
	if result != 123 {
		t.Errorf("expected 123, got %d", result)
	}

	result = getEnvInt("NON_EXISTENT_KEY", 456)
	if result != 456 {
		t.Errorf("expected default 456, got %d", result)
	}

	_ = os.Setenv("TEST_INT_INVALID", "not_a_number")
	defer func() { _ = os.Unsetenv("TEST_INT_INVALID") }()

	result = getEnvInt("TEST_INT_INVALID", 789)
	if result != 789 {
		t.Errorf("expected default 789 for invalid value, got %d", result)
	}

	_ = os.Setenv("TEST_INT_NEGATIVE", "-5")
	defer func() { _ = os.Unsetenv("TEST_INT_NEGATIVE") }()

	result = getEnvInt("TEST_INT_NEGATIVE", 0)
	if result != 0 {
		t.Errorf("expected 0 for negative value, got %d", result)
	}
}

func TestGetEnvDuration(t *testing.T) {
	_ = os.Setenv("TEST_DURATION_KEY", "60")
	defer func() { _ = os.Unsetenv("TEST_DURATION_KEY") }()

	result := getEnvDuration("TEST_DURATION_KEY", 0)
	expected := 60 * time.Second
	if result != expected {
		t.Errorf("expected %v, got %v", expected, result)
	}

	result = getEnvDuration("NON_EXISTENT_KEY", 30*time.Second)
	expected = 30 * time.Second
	if result != expected {
		t.Errorf("expected default %v, got %v", expected, result)
	}

	_ = os.Setenv("TEST_DURATION_INVALID", "not_a_number")
	defer func() { _ = os.Unsetenv("TEST_DURATION_INVALID") }()

	result = getEnvDuration("TEST_DURATION_INVALID", 15*time.Second)
	expected = 15 * time.Second
	if result != expected {
		t.Errorf("expected default %v for invalid value, got %v", expected, result)
	}
}

func TestInitConfig(t *testing.T) {
	_ = os.Setenv("WS_PING_INTERVAL", "45")
	_ = os.Setenv("WS_MAX_CONNECTIONS", "100")
	_ = os.Setenv("RATE_LIMIT_MAX_ENTRIES", "500")
	defer func() {
		_ = os.Unsetenv("WS_PING_INTERVAL")
		_ = os.Unsetenv("WS_MAX_CONNECTIONS")
		_ = os.Unsetenv("RATE_LIMIT_MAX_ENTRIES")
	}()

	cfg := InitConfig()

	if cfg.WebSocket.PingInterval != 45*time.Second {
		t.Errorf("expected PingInterval 45s, got %v", cfg.WebSocket.PingInterval)
	}

	if cfg.WebSocket.MaxConnections != 100 {
		t.Errorf("expected MaxConnections 100, got %d", cfg.WebSocket.MaxConnections)
	}

	if cfg.RateLimit.MaxRateLimitEntries != 500 {
		t.Errorf("expected MaxRateLimitEntries 500, got %d", cfg.RateLimit.MaxRateLimitEntries)
	}
}

func TestGetConfig(t *testing.T) {
	cfg1 := GetConfig()
	if cfg1 == nil {
		t.Fatal("expected non-nil config")
	}

	cfg2 := GetConfig()
	if cfg1 != cfg2 {
		t.Error("expected same config instance on subsequent calls")
	}
}

func TestConfigDefaults(t *testing.T) {
	_ = os.Unsetenv("WS_PING_INTERVAL")
	_ = os.Unsetenv("WS_PING_WRITE_DEADLINE")
	_ = os.Unsetenv("WS_READ_DEADLINE")
	_ = os.Unsetenv("WS_MAX_CONNECTIONS")
	_ = os.Unsetenv("WS_MAX_CONNECTIONS_PER_USER")
	_ = os.Unsetenv("RATE_LIMIT_MAX_ENTRIES")
	_ = os.Unsetenv("GLOBAL_RATE_LIMIT_MAX_ENTRIES")
	_ = os.Unsetenv("BROADCAST_WRITE_DEADLINE")
	_ = os.Unsetenv("WEBHOOK_TIMEOUT")

	cfg := InitConfig()

	if cfg.WebSocket.PingInterval != 30*time.Second {
		t.Errorf("expected default PingInterval 30s, got %v", cfg.WebSocket.PingInterval)
	}

	if cfg.WebSocket.PingWriteDeadline != 10*time.Second {
		t.Errorf("expected default PingWriteDeadline 10s, got %v", cfg.WebSocket.PingWriteDeadline)
	}

	if cfg.WebSocket.ReadDeadline != 40*time.Second {
		t.Errorf("expected default ReadDeadline 40s, got %v", cfg.WebSocket.ReadDeadline)
	}

	if cfg.WebSocket.MaxConnections != 0 {
		t.Errorf("expected default MaxConnections 0, got %d", cfg.WebSocket.MaxConnections)
	}

	if cfg.WebSocket.MaxConnectionsPerUser != 0 {
		t.Errorf("expected default MaxConnectionsPerUser 0, got %d", cfg.WebSocket.MaxConnectionsPerUser)
	}

	if cfg.RateLimit.MaxRateLimitEntries != 0 {
		t.Errorf("expected default MaxRateLimitEntries 0, got %d", cfg.RateLimit.MaxRateLimitEntries)
	}

	if cfg.RateLimit.MaxGlobalRateLimitEntries != 0 {
		t.Errorf("expected default MaxGlobalRateLimitEntries 0, got %d", cfg.RateLimit.MaxGlobalRateLimitEntries)
	}

	if cfg.Broadcast.WriteDeadline != 2*time.Second {
		t.Errorf("expected default WriteDeadline 2s, got %v", cfg.Broadcast.WriteDeadline)
	}

	if cfg.Webhook.Timeout != 10*time.Second {
		t.Errorf("expected default Timeout 10s, got %v", cfg.Webhook.Timeout)
	}
}
