package repositories_test

import (
	"database/sql"
	"errors"
	"testing"

	_ "github.com/mattn/go-sqlite3"

	"open-kanban/internal/models"
	"open-kanban/internal/repositories"
)

// setupWebhookTestDB returns a minimal in-memory SQLite with
// the webhooks + users tables from migration 012 created. Other
// tables are intentionally not added — the webhook repository
// only touches webhooks (and the FK to users for created_by
// lookup).
func setupWebhookTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite3", "file:webhook_repo_test.db?mode=memory&cache=shared")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	db.SetMaxOpenConns(1)
	// Enable foreign-key enforcement so the
	// webhook_deliveries.webhook_id ON DELETE CASCADE in the
	// schema actually fires during the cascade test below.
	// SQLite defaults to foreign_keys = OFF for new
	// connections; without this the cascade test would
	// silently leave orphaned delivery rows behind.
	if _, err := db.Exec("PRAGMA foreign_keys = ON"); err != nil {
		t.Fatalf("enable foreign keys: %v", err)
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
	CREATE TABLE webhooks (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		url TEXT NOT NULL,
		secret BLOB NOT NULL,
		enabled INTEGER NOT NULL DEFAULT 1,
		event_types TEXT NOT NULL DEFAULT '[]',
		filters TEXT NOT NULL DEFAULT '{}',
		headers TEXT NOT NULL DEFAULT '{}',
		timeout_sec INTEGER NOT NULL DEFAULT 10,
		max_retries INTEGER NOT NULL DEFAULT 5,
		created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		last_success_at DATETIME,
		last_failure_at DATETIME
	);
	CREATE TABLE webhook_deliveries (
		id TEXT PRIMARY KEY,
		webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
		event_id TEXT NOT NULL,
		event_type TEXT NOT NULL,
		status TEXT NOT NULL CHECK(status IN ('PENDING', 'SUCCESS', 'FAILED', 'EXHAUSTED')),
		attempt INTEGER NOT NULL DEFAULT 1,
		request_body TEXT NOT NULL DEFAULT '',
		response_code INTEGER NOT NULL DEFAULT 0,
		response_body TEXT NOT NULL DEFAULT '',
		error TEXT NOT NULL DEFAULT '',
		started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		finished_at DATETIME,
		next_retry_at DATETIME
	);
	`

	if _, err := db.Exec(schema); err != nil {
		t.Fatalf("create schema: %v", err)
	}
	for _, stmt := range []string{
		`INSERT INTO users (id, username, nickname, role, enabled) VALUES ('u-admin', 'admin', 'admin', 'ADMIN', 1)`,
		`INSERT INTO users (id, username, nickname, role, enabled) VALUES ('u-member', 'member', 'member', 'MEMBER', 1)`,
	} {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("seed %q: %v", stmt, err)
		}
	}
	return db
}

func TestWebhookRepository_Create(t *testing.T) {
	db := setupWebhookTestDB(t)
	defer db.Close()
	repo := repositories.NewWebhookRepository(db)

	createdBy := "u-admin"

	tests := []struct {
		name    string
		in      *models.Webhook
		wantErr bool
		checkFn func(*testing.T, *models.Webhook)
	}{
		{
			name: "creates row with all fields populated",
			in: &models.Webhook{
				ID:         "wh-1",
				Name:       "Primary",
				URL:        "https://example.com/hook",
				Secret:     []byte("supersecret"),
				Enabled:    true,
				EventTypes: `["task.created"]`,
				Filters:    `{"priority":"high"}`,
				Headers:    `{"X-Token":"abc"}`,
				TimeoutSec: 12,
				MaxRetries: 4,
				CreatedBy:  &createdBy,
			},
			checkFn: func(t *testing.T, w *models.Webhook) {
				got, err := repo.Get(w.ID)
				if err != nil {
					t.Fatalf("Get: %v", err)
				}
				if got.Name != "Primary" {
					t.Errorf("name: got %q want %q", got.Name, "Primary")
				}
				if got.URL != "https://example.com/hook" {
					t.Errorf("url: got %q", got.URL)
				}
				if string(got.Secret) != "supersecret" {
					t.Errorf("secret: got %q want %q", string(got.Secret), "supersecret")
				}
				if !got.Enabled {
					t.Error("enabled should be true")
				}
				if got.EventTypes != `["task.created"]` {
					t.Errorf("event_types round-trip: got %q", got.EventTypes)
				}
				if got.Filters != `{"priority":"high"}` {
					t.Errorf("filters round-trip: got %q", got.Filters)
				}
				if got.Headers != `{"X-Token":"abc"}` {
					t.Errorf("headers round-trip: got %q", got.Headers)
				}
				if got.TimeoutSec != 12 {
					t.Errorf("timeout_sec: got %d want %d", got.TimeoutSec, 12)
				}
				if got.MaxRetries != 4 {
					t.Errorf("max_retries: got %d want %d", got.MaxRetries, 4)
				}
				if got.CreatedBy == nil || *got.CreatedBy != createdBy {
					t.Errorf("created_by: got %v want %s", got.CreatedBy, createdBy)
				}
				if got.CreatedAt.IsZero() {
					t.Error("created_at should be populated")
				}
				if got.UpdatedAt.IsZero() {
					t.Error("updated_at should be populated")
				}
			},
		},
		{
			name: "applies schema defaults when json fields are empty",
			in: &models.Webhook{
				ID:      "wh-defaults",
				Name:    "Defaults",
				URL:     "https://example.com/hook",
				Secret:  []byte("k"),
				Enabled: false,
			},
			checkFn: func(t *testing.T, w *models.Webhook) {
				got, err := repo.Get(w.ID)
				if err != nil {
					t.Fatalf("Get: %v", err)
				}
				if got.EventTypes != "[]" {
					t.Errorf("event_types default: got %q want %q", got.EventTypes, "[]")
				}
				if got.Filters != "{}" {
					t.Errorf("filters default: got %q want %q", got.Filters, "{}")
				}
				if got.Headers != "{}" {
					t.Errorf("headers default: got %q want %q", got.Headers, "{}")
				}
				if got.Enabled {
					t.Error("enabled should be false")
				}
			},
		},
		{
			name: "duplicate id is rejected",
			in: &models.Webhook{
				ID:      "wh-dup",
				Name:    "first",
				URL:     "https://example.com/hook",
				Secret:  []byte("k"),
				Enabled: true,
			},
			wantErr: false,
			checkFn: func(t *testing.T, w *models.Webhook) {
				dup := *w
				dup.Name = "second"
				if err := repo.Create(&dup); err == nil {
					t.Error("expected duplicate id to fail")
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := repo.Create(tt.in)
			if (err != nil) != tt.wantErr {
				t.Fatalf("Create err = %v, wantErr %v", err, tt.wantErr)
			}
			if !tt.wantErr && tt.checkFn != nil {
				tt.checkFn(t, tt.in)
			}
		})
	}
}

func TestWebhookRepository_Get(t *testing.T) {
	db := setupWebhookTestDB(t)
	defer db.Close()
	repo := repositories.NewWebhookRepository(db)

	createdBy := "u-admin"
	seed := &models.Webhook{
		ID:         "wh-get",
		Name:       "Get Test",
		URL:        "https://example.com/hook",
		Secret:     []byte("k"),
		Enabled:    true,
		EventTypes: `["task.created"]`,
		Filters:    `{}`,
		Headers:    `{}`,
		TimeoutSec: 10,
		MaxRetries: 5,
		CreatedBy:  &createdBy,
	}
	if err := repo.Create(seed); err != nil {
		t.Fatalf("seed Create: %v", err)
	}

	tests := []struct {
		name    string
		id      string
		wantErr error
		checkFn func(*testing.T, *models.Webhook)
	}{
		{
			name:    "existing row returns full payload",
			id:      "wh-get",
			wantErr: nil,
			checkFn: func(t *testing.T, w *models.Webhook) {
				if w.ID != "wh-get" {
					t.Errorf("id: got %q", w.ID)
				}
				if string(w.Secret) != "k" {
					t.Errorf("secret should be readable from repo (redaction is service concern): got %q", string(w.Secret))
				}
			},
		},
		{
			name:    "missing row returns ErrWebhookNotFound",
			id:      "ghost",
			wantErr: repositories.ErrWebhookNotFound,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := repo.Get(tt.id)
			if tt.wantErr != nil {
				if !errors.Is(err, tt.wantErr) {
					t.Errorf("Get err = %v, want %v", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("Get err = %v", err)
			}
			if tt.checkFn != nil {
				tt.checkFn(t, got)
			}
		})
	}
}

func TestWebhookRepository_List(t *testing.T) {
	db := setupWebhookTestDB(t)
	defer db.Close()
	repo := repositories.NewWebhookRepository(db)

	for i, id := range []string{"wh-1", "wh-2", "wh-3"} {
		w := &models.Webhook{
			ID:      id,
			Name:    id,
			URL:     "https://example.com/" + id,
			Secret:  []byte("k"),
			Enabled: true,
		}
		// Stagger created_at so DESC ordering is deterministic.
		// wh-1 is the most recent (current time), wh-2 is 1s in
		// the past, wh-3 is 2s in the past.
		if _, err := db.Exec(
			`INSERT INTO webhooks (id, name, url, secret, enabled, created_at) VALUES (?, ?, ?, ?, ?, datetime('now', ?))`,
			w.ID, w.Name, w.URL, w.Secret, true, "-"+itoaSuffix(i)+" seconds",
		); err != nil {
			t.Fatalf("seed %s: %v", id, err)
		}
	}

	got, err := repo.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("expected 3 rows, got %d", len(got))
	}
	// Ordered by created_at DESC → wh-1 first, then wh-2, then
	// wh-3 (wh-1 has the most recent created_at).
	if got[0].ID != "wh-1" {
		t.Errorf("first row: got %q want wh-1", got[0].ID)
	}
	if got[1].ID != "wh-2" {
		t.Errorf("second row: got %q want wh-2", got[1].ID)
	}
	if got[2].ID != "wh-3" {
		t.Errorf("third row: got %q want wh-3", got[2].ID)
	}
}

func TestWebhookRepository_List_Empty(t *testing.T) {
	db := setupWebhookTestDB(t)
	defer db.Close()
	repo := repositories.NewWebhookRepository(db)

	got, err := repo.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if got == nil {
		t.Error("List should return an empty slice, not nil")
	}
	if len(got) != 0 {
		t.Errorf("expected empty list, got %d rows", len(got))
	}
}

func TestWebhookRepository_Update(t *testing.T) {
	db := setupWebhookTestDB(t)
	defer db.Close()
	repo := repositories.NewWebhookRepository(db)

	seed := &models.Webhook{
		ID:      "wh-up",
		Name:    "Original",
		URL:     "https://example.com/hook",
		Secret:  []byte("k"),
		Enabled: true,
	}
	if err := repo.Create(seed); err != nil {
		t.Fatalf("seed: %v", err)
	}

	updated := &models.Webhook{
		ID:         "wh-up",
		Name:       "Renamed",
		URL:        "https://example.com/new",
		Secret:     []byte("k"),
		Enabled:    false,
		EventTypes: `["task.moved"]`,
		Filters:    `{"boardIds":["b-1"]}`,
		Headers:    `{"X-Auth":"v2"}`,
		TimeoutSec: 25,
		MaxRetries: 3,
	}

	if err := repo.Update(updated); err != nil {
		t.Fatalf("Update: %v", err)
	}

	got, err := repo.Get("wh-up")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Name != "Renamed" {
		t.Errorf("name: got %q", got.Name)
	}
	if got.URL != "https://example.com/new" {
		t.Errorf("url: got %q", got.URL)
	}
	if got.Enabled {
		t.Error("enabled should be false")
	}
	if got.EventTypes != `["task.moved"]` {
		t.Errorf("event_types: got %q", got.EventTypes)
	}
	if got.Filters != `{"boardIds":["b-1"]}` {
		t.Errorf("filters: got %q", got.Filters)
	}
	if got.Headers != `{"X-Auth":"v2"}` {
		t.Errorf("headers: got %q", got.Headers)
	}
	if got.TimeoutSec != 25 {
		t.Errorf("timeout_sec: got %d", got.TimeoutSec)
	}
	if got.MaxRetries != 3 {
		t.Errorf("max_retries: got %d", got.MaxRetries)
	}
	if string(got.Secret) != "k" {
		t.Errorf("Update should not rotate secret; got %q", string(got.Secret))
	}
	if !got.UpdatedAt.After(seed.UpdatedAt) {
		t.Errorf("updated_at should advance (was %s, now %s)", seed.UpdatedAt, got.UpdatedAt)
	}
}

func TestWebhookRepository_Update_NotFound(t *testing.T) {
	db := setupWebhookTestDB(t)
	defer db.Close()
	repo := repositories.NewWebhookRepository(db)

	missing := &models.Webhook{
		ID:      "ghost",
		Name:    "x",
		URL:     "https://example.com/x",
		Secret:  []byte("k"),
		Enabled: true,
	}
	err := repo.Update(missing)
	if !errors.Is(err, repositories.ErrWebhookNotFound) {
		t.Errorf("Update miss err = %v, want ErrWebhookNotFound", err)
	}
}

func TestWebhookRepository_Delete(t *testing.T) {
	db := setupWebhookTestDB(t)
	defer db.Close()
	repo := repositories.NewWebhookRepository(db)

	if err := repo.Create(&models.Webhook{ID: "wh-del", Name: "x", URL: "https://example.com/x", Secret: []byte("k"), Enabled: true}); err != nil {
		t.Fatalf("seed: %v", err)
	}

	if err := repo.Delete("wh-del"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := repo.Get("wh-del"); !errors.Is(err, repositories.ErrWebhookNotFound) {
		t.Errorf("Get after Delete err = %v, want ErrWebhookNotFound", err)
	}
}

func TestWebhookRepository_Delete_NotFound(t *testing.T) {
	db := setupWebhookTestDB(t)
	defer db.Close()
	repo := repositories.NewWebhookRepository(db)

	err := repo.Delete("ghost")
	if !errors.Is(err, repositories.ErrWebhookNotFound) {
		t.Errorf("Delete miss err = %v, want ErrWebhookNotFound", err)
	}
}

func TestWebhookRepository_Delete_CascadesDeliveries(t *testing.T) {
	db := setupWebhookTestDB(t)
	defer db.Close()
	repo := repositories.NewWebhookRepository(db)

	if err := repo.Create(&models.Webhook{ID: "wh-casc", Name: "x", URL: "https://example.com/x", Secret: []byte("k"), Enabled: true}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO webhook_deliveries (id, webhook_id, event_id, event_type, status) VALUES ('d-1', 'wh-casc', 'evt-1', 'task.created', 'PENDING')`); err != nil {
		t.Fatalf("seed delivery: %v", err)
	}

	if err := repo.Delete("wh-casc"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM webhook_deliveries WHERE webhook_id = 'wh-casc'").Scan(&count); err != nil {
		t.Fatalf("count deliveries: %v", err)
	}
	if count != 0 {
		t.Errorf("ON DELETE CASCADE should have swept delivery rows; got %d", count)
	}
}

func TestWebhookRepository_RotateSecret(t *testing.T) {
	db := setupWebhookTestDB(t)
	defer db.Close()
	repo := repositories.NewWebhookRepository(db)

	if err := repo.Create(&models.Webhook{ID: "wh-rot", Name: "x", URL: "https://example.com/x", Secret: []byte("old-secret"), Enabled: true}); err != nil {
		t.Fatalf("seed: %v", err)
	}

	newSecret := []byte("new-secret")
	if err := repo.RotateSecret("wh-rot", newSecret); err != nil {
		t.Fatalf("RotateSecret: %v", err)
	}

	got, err := repo.Get("wh-rot")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if string(got.Secret) != "new-secret" {
		t.Errorf("secret: got %q want %q", string(got.Secret), "new-secret")
	}
}

func TestWebhookRepository_RotateSecret_NotFound(t *testing.T) {
	db := setupWebhookTestDB(t)
	defer db.Close()
	repo := repositories.NewWebhookRepository(db)

	err := repo.RotateSecret("ghost", []byte("k"))
	if !errors.Is(err, repositories.ErrWebhookNotFound) {
		t.Errorf("RotateSecret miss err = %v, want ErrWebhookNotFound", err)
	}
}

// itoaSuffix returns the ASCII representation of n — kept
// local to avoid pulling strconv into the test for one helper.
func itoaSuffix(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}
