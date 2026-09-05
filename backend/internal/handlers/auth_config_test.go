package handlers

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	_ "github.com/mattn/go-sqlite3"
)

// setupConfigTestDB opens an in-memory SQLite and applies the
// consolidated initial schema. Duplicated here (instead of importing
// setupTestDB from auth_test.go) because the auth_test helper lives
// in the `handlers_test` external package while these tests need
// package-private access to renderAdvancedConfigEnv / writeAdvancedConfig.
func setupConfigTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatalf("failed to open test db: %v", err)
	}
	schema, err := os.ReadFile("../database/migrations/sqlite/001_initial_schema.up.sql")
	if err != nil {
		t.Fatalf("failed to read sqlite migration: %v", err)
	}
	if _, err := db.Exec(string(schema)); err != nil {
		t.Fatalf("failed to apply schema: %v", err)
	}
	return db
}

// TestRenderAdvancedConfigEnv_AlwaysEmitsPortAndAllowedOrigins guards
// against the regression that hid PORT and ALLOWED_ORIGINS from the
// generated kanban.env when their values were empty. Operators rely
// on the file as a reference of every knob the setup wizard
// surfaced, so we always emit both lines (with empty values when
// the user accepted the defaults).
func TestRenderAdvancedConfigEnv_AlwaysEmitsPortAndAllowedOrigins(t *testing.T) {
	tests := []struct {
		name            string
		cfg             *AdvancedConfig
		wantPort        string
		wantOrigins     string
		wantOriginsLine string
	}{
		{
			name: "explicit values are preserved",
			cfg: &AdvancedConfig{
				DBType:         "sqlite",
				DBPath:         "kanban.db",
				ServerPort:     "9090",
				AllowedOrigins: "https://app.example.com",
			},
			wantPort:        "PORT=9090",
			wantOrigins:     "ALLOWED_ORIGINS=https://app.example.com",
			wantOriginsLine: "ALLOWED_ORIGINS=https://app.example.com",
		},
		{
			name: "empty port falls back to 8080",
			cfg: &AdvancedConfig{
				DBType: "sqlite",
				DBPath: "kanban.db",
			},
			wantPort:        "PORT=8080",
			wantOriginsLine: "ALLOWED_ORIGINS=",
		},
		{
			name: "empty allowed origins is still written as an empty value",
			cfg: &AdvancedConfig{
				DBType:         "sqlite",
				DBPath:         "kanban.db",
				ServerPort:     "8080",
				AllowedOrigins: "",
			},
			wantPort:        "PORT=8080",
			wantOriginsLine: "ALLOWED_ORIGINS=",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			out := renderAdvancedConfigEnv(tt.cfg)
			if !strings.Contains(out, tt.wantPort) {
				t.Errorf("expected %q in output, got:\n%s", tt.wantPort, out)
			}
			if tt.wantOrigins != "" && !strings.Contains(out, tt.wantOrigins) {
				t.Errorf("expected %q in output, got:\n%s", tt.wantOrigins, out)
			}
			if !strings.Contains(out, tt.wantOriginsLine) {
				t.Errorf("expected %q in output, got:\n%s", tt.wantOriginsLine, out)
			}
		})
	}
}

// TestInitHandler_AlwaysWritesConfig guards against the regression
// where omitting the `advanced` block in the init request left
// kanban.env untouched. Init must always produce a complete config
// file (with PORT / ALLOWED_ORIGINS lines) so the on-disk file is
// a full reference of every knob, not a partial subset.
func TestInitHandler_AlwaysWritesConfig(t *testing.T) {
	db := setupConfigTestDB(t)
	defer db.Close()

	// Redirect the config output to a temp file so we can inspect it.
	dir := t.TempDir()
	t.Setenv("INIT_CONFIG_OUTPUT", filepath.Join(dir, "kanban.env"))

	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.POST("/api/init", Init(db, nil))

	// Submit an init request WITHOUT the `advanced` field.
	body := map[string]interface{}{
		"username": "admin",
		"password": "secret123",
	}
	jsonBody, _ := json.Marshal(body)

	req, _ := http.NewRequest("POST", "/api/init", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d: %s", w.Code, w.Body.String())
	}

	// kanban.env must have been written and must contain the lines
	// the operator would expect to find.
	data, err := os.ReadFile(filepath.Join(dir, "kanban.env"))
	if err != nil {
		t.Fatalf("expected kanban.env at %s, got %v", dir, err)
	}
	content := string(data)
	for _, want := range []string{
		"DB_TYPE=sqlite",
		"DATABASE_URL=kanban.db",
		"PORT=8080",
		"ALLOWED_ORIGINS=",
	} {
		if !strings.Contains(content, want) {
			t.Errorf("expected %q in kanban.env, got:\n%s", want, content)
		}
	}
}

// TestInitHandler_WritesOperatorSuppliedAllowedOrigins verifies that
// when the wizard submits a non-default ALLOWED_ORIGINS, the value
// makes it to the config file (the original regression).
func TestInitHandler_WritesOperatorSuppliedAllowedOrigins(t *testing.T) {
	db := setupConfigTestDB(t)
	defer db.Close()

	dir := t.TempDir()
	t.Setenv("INIT_CONFIG_OUTPUT", filepath.Join(dir, "kanban.env"))

	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.POST("/api/init", Init(db, nil))

	body := map[string]interface{}{
		"username": "admin",
		"password": "secret123",
		"advanced": map[string]interface{}{
			"dbType":         "sqlite",
			"dbPath":         "kanban.db",
			"serverPort":     "8080",
			"allowedOrigins": "https://app.example.com,https://admin.example.com",
		},
	}
	jsonBody, _ := json.Marshal(body)

	req, _ := http.NewRequest("POST", "/api/init", bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d: %s", w.Code, w.Body.String())
	}

	data, err := os.ReadFile(filepath.Join(dir, "kanban.env"))
	if err != nil {
		t.Fatalf("expected kanban.env, got %v", err)
	}
	if !strings.Contains(string(data), "ALLOWED_ORIGINS=https://app.example.com,https://admin.example.com") {
		t.Errorf("expected ALLOWED_ORIGINS line with operator value, got:\n%s", string(data))
	}
}
