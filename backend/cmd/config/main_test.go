package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCreateConfigSqlite(t *testing.T) {
	tmpDir := t.TempDir()
	outputPath := filepath.Join(tmpDir, "test-config.env")

	createConfig(outputPath, "sqlite")

	data, err := os.ReadFile(outputPath)
	if err != nil {
		t.Fatalf("failed to read config file: %v", err)
	}

	content := string(data)

	if !strings.Contains(content, "DB_TYPE=sqlite") {
		t.Error("expected DB_TYPE=sqlite in config")
	}

	if !strings.Contains(content, "DATABASE_URL=kanban.db") {
		t.Error("expected DATABASE_URL=kanban.db in config")
	}

	if !strings.Contains(content, "PORT=8080") {
		t.Error("expected PORT=8080 in config")
	}
}

func TestCreateConfigMysql(t *testing.T) {
	tmpDir := t.TempDir()
	outputPath := filepath.Join(tmpDir, "test-config.env")

	createConfig(outputPath, "mysql")

	data, err := os.ReadFile(outputPath)
	if err != nil {
		t.Fatalf("failed to read config file: %v", err)
	}

	content := string(data)

	if !strings.Contains(content, "DB_TYPE=mysql") {
		t.Error("expected DB_TYPE=mysql in config")
	}

	if !strings.Contains(content, "DB_HOST=localhost") {
		t.Error("expected DB_HOST=localhost in config")
	}

	if !strings.Contains(content, "DB_PORT=3306") {
		t.Error("expected DB_PORT=3306 in config")
	}
}

func TestVerifyConfigValid(t *testing.T) {
	tmpDir := t.TempDir()
	configPath := filepath.Join(tmpDir, "valid.env")

	content := `PORT=8080
DB_TYPE=sqlite
DATABASE_URL=kanban.db
WS_PING_INTERVAL=30
`
	if err := os.WriteFile(configPath, []byte(content), 0600); err != nil {
		t.Fatalf("failed to write config: %v", err)
	}

	verifyConfig(configPath)
}

func TestVerifyConfigWithComments(t *testing.T) {
	tmpDir := t.TempDir()
	configPath := filepath.Join(tmpDir, "with-comments.env")

	content := `# This is a comment
PORT=8080
# Another comment
DB_TYPE=sqlite
`
	if err := os.WriteFile(configPath, []byte(content), 0600); err != nil {
		t.Fatalf("failed to write config: %v", err)
	}

	verifyConfig(configPath)
}

func TestVerifyConfigEmptyLines(t *testing.T) {
	tmpDir := t.TempDir()
	configPath := filepath.Join(tmpDir, "empty-lines.env")

	content := `PORT=8080

DB_TYPE=sqlite

`
	if err := os.WriteFile(configPath, []byte(content), 0600); err != nil {
		t.Fatalf("failed to write config: %v", err)
	}

	verifyConfig(configPath)
}

func TestTestStartup(t *testing.T) {
	tmpDir := t.TempDir()
	configPath := filepath.Join(tmpDir, "startup-test.env")

	content := `PORT=8080
DB_TYPE=sqlite
DATABASE_URL=kanban.db
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=secret
DB_NAME=kanban
`
	if err := os.WriteFile(configPath, []byte(content), 0600); err != nil {
		t.Fatalf("failed to write config: %v", err)
	}

	testStartup(configPath)
}

func TestVerifyConfigMysqlType(t *testing.T) {
	tmpDir := t.TempDir()
	configPath := filepath.Join(tmpDir, "mysql.env")

	content := `PORT=8080
DB_TYPE=mysql
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=secret
DB_NAME=kanban
DB_MAX_OPEN_CONNS=25
DB_MAX_IDLE_CONNS=5
DB_CONN_MAX_LIFETIME=300
`
	if err := os.WriteFile(configPath, []byte(content), 0600); err != nil {
		t.Fatalf("failed to write config: %v", err)
	}

	verifyConfig(configPath)
}

func TestVerifyConfigWebsocketSettings(t *testing.T) {
	tmpDir := t.TempDir()
	configPath := filepath.Join(tmpDir, "websocket.env")

	content := `PORT=8080
DB_TYPE=sqlite
WS_PING_INTERVAL=30
WS_PING_WRITE_DEADLINE=10
WS_READ_DEADLINE=40
WS_MAX_CONNECTIONS=100
WS_MAX_CONNECTIONS_PER_USER=5
`
	if err := os.WriteFile(configPath, []byte(content), 0600); err != nil {
		t.Fatalf("failed to write config: %v", err)
	}

	verifyConfig(configPath)
}

func TestVerifyConfigRateLimiting(t *testing.T) {
	tmpDir := t.TempDir()
	configPath := filepath.Join(tmpDir, "rate-limit.env")

	content := `PORT=8080
DB_TYPE=sqlite
RATE_LIMIT_MAX_ENTRIES=1000
GLOBAL_RATE_LIMIT_MAX_ENTRIES=5000
`
	if err := os.WriteFile(configPath, []byte(content), 0600); err != nil {
		t.Fatalf("failed to write config: %v", err)
	}

	verifyConfig(configPath)
}

func TestVerifyConfigWebhookSettings(t *testing.T) {
	tmpDir := t.TempDir()
	configPath := filepath.Join(tmpDir, "webhook.env")

	content := `PORT=8080
DB_TYPE=sqlite
WEBHOOK_TIMEOUT=30
BROADCAST_WRITE_DEADLINE=5
`
	if err := os.WriteFile(configPath, []byte(content), 0600); err != nil {
		t.Fatalf("failed to write config: %v", err)
	}

	verifyConfig(configPath)
}

func TestTestStartupMySQL(t *testing.T) {
	tmpDir := t.TempDir()
	configPath := filepath.Join(tmpDir, "startup-mysql.env")

	content := `PORT=8080
DB_TYPE=mysql
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=secret
DB_NAME=kanban
`
	if err := os.WriteFile(configPath, []byte(content), 0600); err != nil {
		t.Fatalf("failed to write config: %v", err)
	}

	testStartup(configPath)
}

func TestGenerateConfigContent(t *testing.T) {
	sqliteContent := generateConfigContent("sqlite")
	if !strings.Contains(sqliteContent, "DB_TYPE=sqlite") {
		t.Error("expected DB_TYPE=sqlite in sqlite config")
	}
	if !strings.Contains(sqliteContent, "DATABASE_URL=kanban.db") {
		t.Error("expected DATABASE_URL in sqlite config")
	}

	mysqlContent := generateConfigContent("mysql")
	if !strings.Contains(mysqlContent, "DB_TYPE=mysql") {
		t.Error("expected DB_TYPE=mysql in mysql config")
	}
	if !strings.Contains(mysqlContent, "DB_HOST=localhost") {
		t.Error("expected DB_HOST in mysql config")
	}
}

func TestValidateConfigValueInvalidPort(t *testing.T) {
	validDBTypes := map[string]bool{"sqlite": true, "mysql": true}
	msg, isWarn := validateConfigValue("PORT", "invalid", validDBTypes)
	if msg == "" {
		t.Error("expected error message for invalid port")
	}
	if isWarn {
		t.Error("invalid port should not be a warning")
	}
}

func TestValidateConfigValuePortOutOfRange(t *testing.T) {
	validDBTypes := map[string]bool{"sqlite": true, "mysql": true}
	msg, isWarn := validateConfigValue("PORT", "70000", validDBTypes)
	if msg == "" {
		t.Error("expected error message for port out of range")
	}
	if isWarn {
		t.Error("port out of range should not be a warning")
	}
}

func TestValidateConfigValueInvalidDBPort(t *testing.T) {
	validDBTypes := map[string]bool{"sqlite": true, "mysql": true}
	msg, isWarn := validateConfigValue("DB_PORT", "notanumber", validDBTypes)
	if msg == "" {
		t.Error("expected error message for invalid DB_PORT")
	}
	if isWarn {
		t.Error("invalid DB_PORT should not be a warning")
	}
}

func TestValidateConfigValueWarningCase(t *testing.T) {
	validDBTypes := map[string]bool{"sqlite": true, "mysql": true}
	msg, isWarn := validateConfigValue("WS_PING_INTERVAL", "invalid", validDBTypes)
	if msg == "" {
		t.Error("expected message for invalid WS_PING_INTERVAL")
	}
	if !isWarn {
		t.Error("WS_PING_INTERVAL should be a warning")
	}
}

func TestValidateConfigValueInvalidRateLimit(t *testing.T) {
	validDBTypes := map[string]bool{"sqlite": true, "mysql": true}
	msg, isWarn := validateConfigValue("RATE_LIMIT_MAX_ENTRIES", "notanumber", validDBTypes)
	if msg == "" {
		t.Error("expected error message for invalid RATE_LIMIT_MAX_ENTRIES")
	}
	if isWarn {
		t.Error("RATE_LIMIT_MAX_ENTRIES should not be a warning")
	}
}

func TestValidateConfig(t *testing.T) {
	validDBTypes := map[string]bool{"sqlite": true, "mysql": true}
	envVars := map[string]string{
		"PORT":    "8080",
		"DB_TYPE": "sqlite",
	}
	errs := validateConfig(envVars, validDBTypes)
	if len(errs) != 0 {
		t.Errorf("expected no errors, got %v", errs)
	}

	envVarsWithBadPort := map[string]string{
		"PORT":    "invalid",
		"DB_TYPE": "sqlite",
	}
	errs = validateConfig(envVarsWithBadPort, validDBTypes)
	if len(errs) == 0 {
		t.Error("expected errors for invalid port")
	}
}

func TestValidateConfigEmptyKey(t *testing.T) {
	validDBTypes := map[string]bool{"sqlite": true, "mysql": true}
	envVars := map[string]string{
		"":        "somevalue",
		"DB_TYPE": "sqlite",
	}
	errs := validateConfig(envVars, validDBTypes)
	if len(errs) == 0 {
		t.Error("expected error for empty key")
	}
}

func TestPrintErrors(t *testing.T) {
	errors := []string{"error 1", "error 2", "error 3"}
	printErrors(errors)
}

func TestCreateConfigWithSubDir(t *testing.T) {
	tmpDir := t.TempDir()
	outputPath := filepath.Join(tmpDir, "subdir", "test-config.env")

	createConfig(outputPath, "sqlite")

	data, err := os.ReadFile(outputPath)
	if err != nil {
		t.Fatalf("failed to read config file: %v", err)
	}

	content := string(data)
	if !strings.Contains(content, "DB_TYPE=sqlite") {
		t.Error("expected DB_TYPE=sqlite in config")
	}
}
