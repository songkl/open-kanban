package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

func isSafePath(configPath string) error {
	if strings.Contains(configPath, "\x00") {
		return fmt.Errorf("path contains null byte")
	}
	absPath, err := filepath.Abs(configPath)
	if err != nil {
		return fmt.Errorf("failed to get absolute path: %v", err)
	}
	absPath = filepath.Clean(absPath)
	if strings.Contains(absPath, "..") {
		return fmt.Errorf("path contains invalid traversal")
	}
	return nil
}

func readConfigFile(configPath string) (map[string]string, error) {
	if err := isSafePath(configPath); err != nil {
		return nil, err
	}
	if _, err := os.Stat(configPath); err != nil {
		return nil, fmt.Errorf("config file not found: %v", err)
	}
	data, err := os.ReadFile(configPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read config file: %v", err)
	}
	envVars := make(map[string]string)
	lines := strings.Split(string(data), "\n")
	for lineNum, line := range lines {
		lineNum++
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}
		key := strings.TrimSpace(parts[0])
		value := strings.TrimSpace(parts[1])
		envVars[key] = value
	}
	return envVars, nil
}

func validateConfigValue(key, value string, validDBTypes map[string]bool) (string, bool) {
	switch key {
	case "PORT":
		if _, err := strconv.Atoi(value); err != nil {
			return fmt.Sprintf("PORT must be a valid number"), false
		} else if port, _ := strconv.Atoi(value); port < 1 || port > 65535 {
			return fmt.Sprintf("PORT must be between 1 and 65535"), false
		}
	case "DB_TYPE":
		if !validDBTypes[value] {
			return fmt.Sprintf("DB_TYPE must be 'sqlite' or 'mysql'"), false
		}
	case "DB_PORT", "DB_MAX_OPEN_CONNS", "DB_MAX_IDLE_CONNS", "DB_CONN_MAX_LIFETIME":
		if _, err := strconv.Atoi(value); err != nil {
			return fmt.Sprintf("%s must be a valid number", key), false
		}
	case "WS_PING_INTERVAL", "WS_PING_WRITE_DEADLINE", "WS_READ_DEADLINE", "WEBHOOK_TIMEOUT", "BROADCAST_WRITE_DEADLINE":
		if _, err := strconv.Atoi(value); err != nil {
			return fmt.Sprintf("%s should be a number (seconds)", key), true
		}
	case "RATE_LIMIT_MAX_ENTRIES", "GLOBAL_RATE_LIMIT_MAX_ENTRIES":
		if _, err := strconv.Atoi(value); err != nil {
			return fmt.Sprintf("%s must be a valid number", key), false
		}
	}
	return "", false
}

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(1)
	}

	switch os.Args[1] {
	case "create-config":
		createConfigCmd := flag.NewFlagSet("create-config", flag.ExitOnError)
		outputPath := createConfigCmd.String("o", "", "Output path (default: /tmp/kanban.env)")
		dbType := createConfigCmd.String("db", "sqlite", "Database type: sqlite or mysql")
		_ = createConfigCmd.Parse(os.Args[2:])
		createConfig(*outputPath, *dbType)

	case "verify-config":
		verifyConfigCmd := flag.NewFlagSet("verify-config", flag.ExitOnError)
		configPath := verifyConfigCmd.String("f", "", "Path to config file to verify")
		_ = verifyConfigCmd.Parse(os.Args[2:])
		if *configPath == "" {
			fmt.Println("Error: -f flag is required")
			printUsage()
			os.Exit(1)
		}
		verifyConfig(*configPath)

	case "test-startup":
		testStartupCmd := flag.NewFlagSet("test-startup", flag.ExitOnError)
		configPath := testStartupCmd.String("f", "", "Path to config file to test")
		_ = testStartupCmd.Parse(os.Args[2:])
		if *configPath == "" {
			fmt.Println("Error: -f flag is required")
			printUsage()
			os.Exit(1)
		}
		testStartup(*configPath)

	case "help", "--help":
		printUsage()

	default:
		fmt.Printf("Unknown command: %s\n", os.Args[1])
		printUsage()
		os.Exit(1)
	}
}

func printUsage() {
	fmt.Println("kanban-config - Configuration tool for kanban server")
	fmt.Println("")
	fmt.Println("Usage:")
	fmt.Println("  kanban-config <command> [options]")
	fmt.Println("")
	fmt.Println("Commands:")
	fmt.Println("  create-config     Create a new configuration file")
	fmt.Println("  verify-config     Verify a configuration file is valid")
	fmt.Println("  test-startup      Test that server startup reads config correctly")
	fmt.Println("  help              Show this help message")
	fmt.Println("")
	fmt.Println("create-config options:")
	fmt.Println("  -o <path>   Output path (default: /tmp/kanban.env)")
	fmt.Println("  -db <type>  Database type: sqlite or mysql (default: sqlite)")
	fmt.Println("")
	fmt.Println("verify-config options:")
	fmt.Println("  -f <path>   Path to config file to verify (required)")
	fmt.Println("")
	fmt.Println("test-startup options:")
	fmt.Println("  -f <path>   Path to config file to test (required)")
}

func createConfig(outputPath string, dbType string) {
	if outputPath == "" {
		outputPath = "/tmp/kanban.env"
	}

	if dbType != "sqlite" && dbType != "mysql" {
		fmt.Printf("Error: invalid database type %s (must be 'sqlite' or 'mysql')\n", dbType)
		os.Exit(1)
	}

	configContent := generateConfigContent(dbType)

	dir := filepath.Dir(outputPath)
	if err := os.MkdirAll(dir, 0750); err != nil {
		fmt.Printf("Error: failed to create directory %s: %v\n", dir, err)
		os.Exit(1)
	}

	if err := isSafePath(outputPath); err != nil {
		fmt.Printf("Error: unsafe path: %v\n", err)
		os.Exit(1)
	}

	if err := os.WriteFile(outputPath, []byte(configContent), 0600); err != nil {
		fmt.Printf("Error: failed to write config file: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Configuration file created successfully at: %s\n", outputPath)
}

const commonConfigHeader = `# Kanban Server Configuration
# Generated by kanban-config tool

# Server port (default: 8080)
PORT=8080

`

const commonConfigFooter = `# WebSocket configuration
WS_PING_INTERVAL=30
WS_PING_WRITE_DEADLINE=10
WS_READ_DEADLINE=40
WS_MAX_CONNECTIONS=0
WS_MAX_CONNECTIONS_PER_USER=0

# Rate limiting (0 = disabled)
RATE_LIMIT_MAX_ENTRIES=0
GLOBAL_RATE_LIMIT_MAX_ENTRIES=0

# Broadcast configuration
BROADCAST_WRITE_DEADLINE=2

# Webhook configuration
WEBHOOK_TIMEOUT=10

# CORS configuration
ALLOWED_ORIGINS=

# Static web directory (leave empty for embedded)
WEB_DIR=
`

func generateConfigContent(dbType string) string {
	var dbSection string
	if dbType == "sqlite" {
		dbSection = `# Database type: sqlite or mysql
DB_TYPE=sqlite

# SQLite database file path
DATABASE_URL=kanban.db
`
	} else {
		dbSection = `# Database type: sqlite or mysql
DB_TYPE=mysql

# MySQL database configuration
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=
DB_NAME=kanban
DB_MAX_OPEN_CONNS=25
DB_MAX_IDLE_CONNS=5
DB_CONN_MAX_LIFETIME=300
`
	}
	return commonConfigHeader + dbSection + commonConfigFooter
}

func verifyConfig(configPath string) {
	envVars, err := readConfigFile(configPath)
	if err != nil {
		fmt.Printf("Error: %v\n", err)
		os.Exit(1)
	}

	validDBTypes := map[string]bool{"sqlite": true, "mysql": true}

	if errs := validateConfig(envVars, validDBTypes); len(errs) > 0 {
		printErrors(errs)
		os.Exit(1)
	}

	fmt.Println("Configuration file is valid!")
	fmt.Printf("Verified: %s\n", configPath)
}

func validateConfig(envVars map[string]string, validDBTypes map[string]bool) []string {
	var errors []string
	for key, value := range envVars {
		if key == "" {
			errors = append(errors, "empty key found")
			continue
		}
		if msg, isWarn := validateConfigValue(key, value, validDBTypes); msg != "" && !isWarn {
			errors = append(errors, msg)
		}
	}
	return errors
}

func printErrors(errors []string) {
	fmt.Println("Errors found:")
	for _, e := range errors {
		fmt.Printf("  - %s\n", e)
	}
}

func testStartup(configPath string) {
	envVars, err := readConfigFile(configPath)
	if err != nil {
		fmt.Printf("Error: %v\n", err)
		os.Exit(1)
	}

	fmt.Println("Testing server startup with config file...")
	fmt.Printf("Config file: %s\n\n", configPath)

	fmt.Println("Environment variables that would be set:")
	fmt.Println("  Database type:", envVars["DB_TYPE"])
	fmt.Println("  Database URL/Path:", envVars["DATABASE_URL"])
	fmt.Println("  Port:", envVars["PORT"])

	if envVars["DB_TYPE"] == "mysql" {
		fmt.Println("  MySQL Host:", envVars["DB_HOST"])
		fmt.Println("  MySQL Port:", envVars["DB_PORT"])
		fmt.Println("  MySQL User:", envVars["DB_USER"])
		fmt.Println("  MySQL Database:", envVars["DB_NAME"])
	}

	fmt.Println("")
	fmt.Println("Note: To actually test startup, the server would need to be run with these env vars.")
	fmt.Println("This tool only verifies the config file format is correct for startup.")
}
