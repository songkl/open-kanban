package handlers_test

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"open-kanban/internal/handlers"

	"github.com/gin-gonic/gin"
)

// setupPresetTemplatesDB returns an in-memory SQLite with the schema
// the preset-templates + onboarding handlers need. The schema is the
// same shape the production migrations produce (notifications, app_config,
// users, tokens, boards, board_permissions, columns, tasks,
// preset_templates) and seeds one ADMIN user so RequireAuth passes.
func setupPresetTemplatesDB(t *testing.T) *sql.DB {
	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatalf("open test db: %v", err)
	}

	schema := `
	CREATE TABLE users (
		id TEXT PRIMARY KEY,
		username TEXT UNIQUE NOT NULL,
		nickname TEXT NOT NULL,
		password TEXT,
		avatar TEXT,
		type TEXT DEFAULT 'HUMAN',
		role TEXT DEFAULT 'MEMBER',
		enabled BOOLEAN DEFAULT 1,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		last_active_at DATETIME
	);
	CREATE TABLE tokens (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		key TEXT UNIQUE NOT NULL,
		user_id TEXT NOT NULL,
		expires_at DATETIME,
		user_agent TEXT,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
	);
	CREATE TABLE boards (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		short_alias TEXT UNIQUE,
		task_counter INTEGER DEFAULT 1000,
		deleted BOOLEAN DEFAULT 0,
		is_public BOOLEAN DEFAULT 1,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		description TEXT DEFAULT ''
	);
	CREATE TABLE board_permissions (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		board_id TEXT NOT NULL,
		owner_agent_id TEXT,
		access TEXT DEFAULT 'READ',
		granted_by_user_id TEXT,
		expires_at DATETIME,
		revoked_at DATETIME,
		revoked_by_user_id TEXT,
		notes TEXT DEFAULT '',
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
		FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE
	);
	CREATE TABLE columns (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		status TEXT,
		position INTEGER DEFAULT 0,
		color TEXT DEFAULT '#6b7280',
		description TEXT DEFAULT '',
		board_id TEXT NOT NULL,
		owner_agent_id TEXT,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE
	);
	CREATE TABLE tasks (
		id TEXT PRIMARY KEY,
		title TEXT NOT NULL,
		description TEXT,
		priority TEXT DEFAULT 'medium',
		assignee TEXT,
		agent_id TEXT,
		agent_prompt TEXT,
		meta TEXT,
		column_id TEXT NOT NULL,
		position INTEGER DEFAULT 0,
		published BOOLEAN DEFAULT 0,
		archived BOOLEAN DEFAULT 0,
		archived_at DATETIME,
		created_by TEXT,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (column_id) REFERENCES columns(id) ON DELETE CASCADE
	);
	CREATE TABLE app_config (
		key TEXT PRIMARY KEY,
		value TEXT
	);
	CREATE TABLE preset_templates (
		id TEXT PRIMARY KEY,
		slug TEXT NOT NULL UNIQUE,
		name TEXT NOT NULL,
		description TEXT NOT NULL DEFAULT '',
		category TEXT NOT NULL DEFAULT '',
		columns_config TEXT NOT NULL,
		sample_tasks TEXT NOT NULL DEFAULT '[]',
		sample_agent TEXT NOT NULL DEFAULT '',
		position INTEGER NOT NULL DEFAULT 0,
		enabled BOOLEAN NOT NULL DEFAULT 1,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
	);
	`
	if _, err := db.Exec(schema); err != nil {
		t.Fatalf("create schema: %v", err)
	}

	if _, err := db.Exec(`INSERT INTO users (id, username, nickname, password, role, enabled, avatar) VALUES ('u1', 'admin', 'admin', 'pass', 'ADMIN', 1, '')`); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO tokens (id, name, key, user_id) VALUES ('t1', 'default', 'test-token', 'u1')`); err != nil {
		t.Fatalf("seed token: %v", err)
	}

	// Seed two presets so the handler has something to enumerate.
	seedPresets(t, db)

	return db
}

// seedPresets inserts the minimum preset set the tests rely on. The
// shapes are deliberately a bit smaller than the production seed (one
// task, three columns) so the assertions below can stay focused on the
// structural contract (4 columns out, slug in, position ordering) rather
// than the specific column names.
func seedPresets(t *testing.T, db *sql.DB) {
	t.Helper()

	presets := []struct {
		id, slug, name, category, sampleAgent string
		columns                               string
		sampleTasks                           string
		position                              int
	}{
		{
			id:          "alpha",
			slug:        "alpha-template",
			name:        "Alpha template",
			category:    "engineering",
			sampleAgent: "Alpha Bot",
			columns: `[{"name":"Backlog","position":0,"color":"#94a3b8","status":"todo"},
				{"name":"Doing","position":1,"color":"#3b82f6","status":"in_progress"},
				{"name":"Done","position":2,"color":"#22c55e","status":"done"}]`,
			sampleTasks: `[{"title":"Try me","columnIndex":0,"priority":"medium"}]`,
			position:    1,
		},
		{
			id:          "beta",
			slug:        "beta-template",
			name:        "Beta template",
			category:    "support",
			sampleAgent: "Beta Bot",
			columns: `[{"name":"Inbox","position":0,"color":"#94a3b8","status":"todo"},
				{"name":"Closed","position":1,"color":"#22c55e","status":"done"}]`,
			sampleTasks: `[{"title":"Sample ticket","columnIndex":0,"priority":"high"}]`,
			position:    2,
		},
		{
			// Disabled preset — must be hidden from the marketplace GET.
			id:          "gamma",
			slug:        "gamma-template",
			name:        "Gamma template",
			category:    "internal",
			sampleAgent: "Gamma Bot",
			columns:     `[{"name":"One","position":0,"color":"#94a3b8","status":"todo"}]`,
			sampleTasks: `[{"title":"x","columnIndex":0,"priority":"low"}]`,
			position:    3,
		},
	}

	for _, p := range presets {
		enabled := 1
		if p.id == "gamma" {
			enabled = 0
		}
		if _, err := db.Exec(`
			INSERT INTO preset_templates (id, slug, name, category, columns_config, sample_tasks, sample_agent, position, enabled)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`, p.id, p.slug, p.name, p.category, p.columns, p.sampleTasks, p.sampleAgent, p.position, enabled); err != nil {
			t.Fatalf("seed preset %s: %v", p.id, err)
		}
	}
}

func TestGetPresetTemplates(t *testing.T) {
	gin.SetMode(gin.TestMode)

	t.Run("returns enabled presets without auth (public marketplace)", func(t *testing.T) {
		db := setupPresetTemplatesDB(t)
		defer db.Close()

		router := gin.New()
		router.GET("/api/v1/preset-templates", handlers.GetPresetTemplates(db))

		req, _ := http.NewRequest("GET", "/api/v1/preset-templates", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var presets []handlers.PresetTemplate
		if err := json.Unmarshal(w.Body.Bytes(), &presets); err != nil {
			t.Fatalf("decode response: %v", err)
		}
		if len(presets) != 2 {
			t.Errorf("expected 2 enabled presets, got %d", len(presets))
		}
		// alpha is position 1, beta is position 2 — alpha should come first.
		if presets[0].Slug != "alpha-template" {
			t.Errorf("expected alpha-template first (lower position), got %q", presets[0].Slug)
		}
		if presets[1].Slug != "beta-template" {
			t.Errorf("expected beta-template second, got %q", presets[1].Slug)
		}
		// Disabled gamma must be hidden.
		for _, p := range presets {
			if p.Slug == "gamma-template" {
				t.Error("disabled preset gamma should not be in the marketplace response")
			}
		}
	})

	t.Run("404 when marketplace is disabled by admin", func(t *testing.T) {
		db := setupPresetTemplatesDB(t)
		defer db.Close()

		if _, err := db.Exec(`REPLACE INTO app_config (`+"`key`"+`, value) VALUES ('marketplaceEnabled', '0')`); err != nil {
			t.Fatalf("disable marketplace: %v", err)
		}

		router := gin.New()
		router.GET("/api/v1/preset-templates", handlers.GetPresetTemplates(db))

		req, _ := http.NewRequest("GET", "/api/v1/preset-templates", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusNotFound {
			t.Errorf("expected 404 when marketplace disabled, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("missing preset table returns 500 (not panic)", func(t *testing.T) {
		db, err := sql.Open("sqlite3", ":memory:")
		if err != nil {
			t.Fatalf("open: %v", err)
		}
		defer db.Close()

		router := gin.New()
		router.GET("/api/v1/preset-templates", handlers.GetPresetTemplates(db))

		req, _ := http.NewRequest("GET", "/api/v1/preset-templates", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusInternalServerError {
			t.Errorf("expected 500 when preset_templates missing, got %d: %s", w.Code, w.Body.String())
		}
	})
}

func TestQuickstartOnboarding(t *testing.T) {
	gin.SetMode(gin.TestMode)

	t.Run("unauthenticated quickstart returns 401", func(t *testing.T) {
		db := setupPresetTemplatesDB(t)
		defer db.Close()

		router := gin.New()
		router.Use(handlers.RequireAuth(db))
		router.POST("/api/v1/onboarding/quickstart", handlers.QuickstartOnboarding(db))

		body := map[string]interface{}{"presetSlug": "alpha-template"}
		jsonBody, _ := json.Marshal(body)
		req, _ := http.NewRequest("POST", "/api/v1/onboarding/quickstart", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("quickstart materialises board + columns + agent + demo task in one shot", func(t *testing.T) {
		db := setupPresetTemplatesDB(t)
		defer db.Close()

		router := gin.New()
		router.Use(handlers.RequireAuth(db))
		router.POST("/api/v1/onboarding/quickstart", handlers.QuickstartOnboarding(db))

		body := map[string]interface{}{"presetSlug": "alpha-template"}
		jsonBody, _ := json.Marshal(body)
		req, _ := http.NewRequest("POST", "/api/v1/onboarding/quickstart", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var result handlers.QuickstartResult
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
			t.Fatalf("decode result: %v", err)
		}
		if result.BoardID == "" {
			t.Error("expected non-empty boardId in result")
		}
		if result.AgentID == "" {
			t.Error("expected non-empty agentId in result")
		}
		if result.AgentToken == "" {
			t.Error("expected non-empty agentToken in result")
		}
		if result.DemoTaskID == "" {
			t.Error("expected non-empty demoTaskId in result")
		}
		if result.BoardName != "Alpha template" {
			t.Errorf("expected default board name 'Alpha template', got %q", result.BoardName)
		}

		// Board row exists with the right name.
		var boardName string
		if err := db.QueryRow(`SELECT name FROM boards WHERE id = ?`, result.BoardID).Scan(&boardName); err != nil {
			t.Fatalf("query board: %v", err)
		}
		if boardName != "Alpha template" {
			t.Errorf("expected board name 'Alpha template', got %q", boardName)
		}

		// 3 columns were materialised in declared order.
		var colCount int
		if err := db.QueryRow(`SELECT COUNT(*) FROM columns WHERE board_id = ?`, result.BoardID).Scan(&colCount); err != nil {
			t.Fatalf("count columns: %v", err)
		}
		if colCount != 3 {
			t.Errorf("expected 3 columns, got %d", colCount)
		}

		// Sample Agent exists, has ADMIN on the board, and has a token.
		var agentType, agentRole string
		if err := db.QueryRow(`SELECT type, role FROM users WHERE id = ?`, result.AgentID).Scan(&agentType, &agentRole); err != nil {
			t.Fatalf("query agent: %v", err)
		}
		if agentType != "AGENT" {
			t.Errorf("expected AGENT type, got %q", agentType)
		}
		if agentRole != "ADMIN" {
			t.Errorf("expected ADMIN role, got %q", agentRole)
		}
		var tokenCount int
		if err := db.QueryRow(`SELECT COUNT(*) FROM tokens WHERE user_id = ?`, result.AgentID).Scan(&tokenCount); err != nil {
			t.Fatalf("count agent tokens: %v", err)
		}
		if tokenCount == 0 {
			t.Error("expected at least one token for the sample agent")
		}

		var permCount int
		if err := db.QueryRow(`SELECT COUNT(*) FROM board_permissions WHERE user_id = ? AND board_id = ? AND access = 'ADMIN'`, result.AgentID, result.BoardID).Scan(&permCount); err != nil {
			t.Fatalf("count agent permissions: %v", err)
		}
		if permCount != 1 {
			t.Errorf("expected exactly 1 ADMIN permission for sample agent, got %d", permCount)
		}

		// Demo task lives in column 0 and matches the seeded title.
		var taskTitle string
		var colPos int
		if err := db.QueryRow(`
			SELECT t.title, c.position FROM tasks t JOIN columns c ON t.column_id = c.id
			WHERE t.id = ?
		`, result.DemoTaskID).Scan(&taskTitle, &colPos); err != nil {
			t.Fatalf("query demo task: %v", err)
		}
		if taskTitle != "Try me" {
			t.Errorf("expected demo task title 'Try me', got %q", taskTitle)
		}
		if colPos != 0 {
			t.Errorf("expected demo task in column position 0, got %d", colPos)
		}
	})

	t.Run("explicit installAgent=false skips the sample agent", func(t *testing.T) {
		db := setupPresetTemplatesDB(t)
		defer db.Close()

		router := gin.New()
		router.Use(handlers.RequireAuth(db))
		router.POST("/api/v1/onboarding/quickstart", handlers.QuickstartOnboarding(db))

		f := false
		body := map[string]interface{}{
			"presetSlug":    "alpha-template",
			"installAgent":  f,
			"triggerDemoRun": f,
		}
		jsonBody, _ := json.Marshal(body)
		req, _ := http.NewRequest("POST", "/api/v1/onboarding/quickstart", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var result handlers.QuickstartResult
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if result.AgentID != "" {
			t.Errorf("expected empty agentId when installAgent=false, got %q", result.AgentID)
		}
		if result.DemoTaskID != "" {
			t.Errorf("expected empty demoTaskId when triggerDemoRun=false, got %q", result.DemoTaskID)
		}

		// No agent tokens should exist at all.
		var tokenCount int
		if err := db.QueryRow(`SELECT COUNT(*) FROM tokens WHERE name = 'default'`).Scan(&tokenCount); err != nil {
			t.Fatalf("count default tokens: %v", err)
		}
		if tokenCount != 1 {
			// 1 from the seed user 'u1', nothing else should have been added.
			t.Errorf("expected only the seed user's token, got %d", tokenCount)
		}
	})

	t.Run("unknown presetSlug returns 404", func(t *testing.T) {
		db := setupPresetTemplatesDB(t)
		defer db.Close()

		router := gin.New()
		router.Use(handlers.RequireAuth(db))
		router.POST("/api/v1/onboarding/quickstart", handlers.QuickstartOnboarding(db))

		body := map[string]interface{}{"presetSlug": "does-not-exist"}
		jsonBody, _ := json.Marshal(body)
		req, _ := http.NewRequest("POST", "/api/v1/onboarding/quickstart", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusNotFound {
			t.Errorf("expected 404 for unknown preset, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("missing presetSlug returns 400", func(t *testing.T) {
		db := setupPresetTemplatesDB(t)
		defer db.Close()

		router := gin.New()
		router.Use(handlers.RequireAuth(db))
		router.POST("/api/v1/onboarding/quickstart", handlers.QuickstartOnboarding(db))

		body := map[string]interface{}{}
		jsonBody, _ := json.Marshal(body)
		req, _ := http.NewRequest("POST", "/api/v1/onboarding/quickstart", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400 for empty presetSlug, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("custom boardName overrides the preset default", func(t *testing.T) {
		db := setupPresetTemplatesDB(t)
		defer db.Close()

		router := gin.New()
		router.Use(handlers.RequireAuth(db))
		router.POST("/api/v1/onboarding/quickstart", handlers.QuickstartOnboarding(db))

		body := map[string]interface{}{"presetSlug": "alpha-template", "boardName": "My Custom Board"}
		jsonBody, _ := json.Marshal(body)
		req, _ := http.NewRequest("POST", "/api/v1/onboarding/quickstart", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var result handlers.QuickstartResult
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if result.BoardName != "My Custom Board" {
			t.Errorf("expected custom board name, got %q", result.BoardName)
		}
	})

	t.Run("nickname collision appends a numeric suffix instead of clobbering", func(t *testing.T) {
		db := setupPresetTemplatesDB(t)
		defer db.Close()

		// Seed a user that already owns the "Alpha Bot" nickname so the
		// onboarding wizard has to disambiguate.
		if _, err := db.Exec(`INSERT INTO users (id, username, nickname, type, role, enabled) VALUES ('existing', 'existing', 'Alpha Bot', 'HUMAN', 'MEMBER', 1)`); err != nil {
			t.Fatalf("seed collision: %v", err)
		}

		router := gin.New()
		router.Use(handlers.RequireAuth(db))
		router.POST("/api/v1/onboarding/quickstart", handlers.QuickstartOnboarding(db))

		body := map[string]interface{}{"presetSlug": "alpha-template"}
		jsonBody, _ := json.Marshal(body)
		req, _ := http.NewRequest("POST", "/api/v1/onboarding/quickstart", bytes.NewBuffer(jsonBody))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}

		var result handlers.QuickstartResult
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
			t.Fatalf("decode: %v", err)
		}

		var nick string
		if err := db.QueryRow(`SELECT nickname FROM users WHERE id = ?`, result.AgentID).Scan(&nick); err != nil {
			t.Fatalf("query agent nickname: %v", err)
		}
		if nick == "Alpha Bot" {
			t.Error("agent nickname should have been suffixed to avoid clobbering the existing user")
		}
		if nick[:len("Alpha Bot")] != "Alpha Bot" {
			t.Errorf("expected suffixed nickname to start with 'Alpha Bot', got %q", nick)
		}
	})
}

func TestGetAppConfigIncludesMarketplaceEnabled(t *testing.T) {
	gin.SetMode(gin.TestMode)

	db := setupPresetTemplatesDB(t)
	defer db.Close()

	router := gin.New()
	router.GET("/api/auth/config", handlers.GetAppConfig(db))

	req, _ := http.NewRequest("GET", "/api/auth/config", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var cfg struct {
		AllowRegistration  bool `json:"allowRegistration"`
		RequirePassword    bool `json:"requirePassword"`
		AuthEnabled        bool `json:"authEnabled"`
		MarketplaceEnabled bool `json:"marketplaceEnabled"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &cfg); err != nil {
		t.Fatalf("decode: %v", err)
	}
	// Default (no row in app_config) must be enabled so the marketplace
	// surfaces out of the box on a fresh install.
	if !cfg.MarketplaceEnabled {
		t.Error("expected marketplaceEnabled to default to true when no app_config row is present")
	}
}

func TestUpdateAppConfigTogglesMarketplaceEnabled(t *testing.T) {
	gin.SetMode(gin.TestMode)

	db := setupPresetTemplatesDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.PUT("/api/config", handlers.UpdateAppConfig(db))

	off := false
	body, _ := json.Marshal(map[string]interface{}{"marketplaceEnabled": off})
	req, _ := http.NewRequest("PUT", "/api/config", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "test-token"})
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	// Verify the persisted value and that GetPresetTemplates now 404s.
	var stored string
	if err := db.QueryRow(`SELECT value FROM app_config WHERE `+"`key`"+` = 'marketplaceEnabled'`).Scan(&stored); err != nil {
		t.Fatalf("query stored value: %v", err)
	}
	if stored != "0" {
		t.Errorf("expected marketplaceEnabled='0' after update, got %q", stored)
	}

	marketplaceRouter := gin.New()
	marketplaceRouter.GET("/api/v1/preset-templates", handlers.GetPresetTemplates(db))
	req2, _ := http.NewRequest("GET", "/api/v1/preset-templates", nil)
	w2 := httptest.NewRecorder()
	marketplaceRouter.ServeHTTP(w2, req2)
	if w2.Code != http.StatusNotFound {
		t.Errorf("expected marketplace to 404 after disable, got %d", w2.Code)
	}
}