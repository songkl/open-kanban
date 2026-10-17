package handlers

import (
	"bytes"
	"database/sql"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"open-kanban/internal/models"

	"github.com/gin-gonic/gin"
	_ "github.com/mattn/go-sqlite3"
)

// seedCachedSessionForTest installs an enabled, unexpired user in the
// in-memory token cache so handler tests can keep authenticating after
// their test database has had the users table dropped out from under it
// (to force a "query failed" branch without losing auth).
func seedCachedSessionForTest(token, userID, role string) {
	if tokenCache == nil {
		tokenCache = &memoryTokenCache{}
	}
	tokenCache.Store(token, &cachedUser{
		user:      &models.User{ID: userID, Role: role, Type: "HUMAN", Enabled: true},
		expiresAt: time.Now().Add(5 * time.Minute),
	})
}

func doRequest(r *gin.Engine, method, path, token, body string, jsonBody bool) *httptest.ResponseRecorder {
	var reader *bytes.Buffer
	if body != "" {
		reader = bytes.NewBufferString(body)
	} else {
		reader = bytes.NewBufferString("")
	}
	req, _ := http.NewRequest(method, path, reader)
	if jsonBody {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.AddCookie(&http.Cookie{Name: "kanban-token", Value: token})
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func seedCoverageColumns(t *testing.T, db *sql.DB) {
	t.Helper()
	if _, err := db.Exec(`INSERT INTO columns (id, name, board_id) VALUES ('col1', 'Test Column', 'board1')`); err != nil {
		t.Fatalf("seed column: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO column_permissions (id, user_id, column_id, access, granted_by_user_id, expires_at) VALUES ('cp-cover', 'member2', 'col1', 'WRITE', 'admin1', datetime('now', '+1 day'))`); err != nil {
		t.Fatalf("seed column permission: %v", err)
	}
}

// TestPermissionHandlers_UnauthenticatedBranches covers the handler-level
// nil-user guard in every permission entry point. The production router
// normally rejects an unauthenticated request in RequireAuth before the
// handler runs, so the in-handler guard is only reachable when the route
// is mounted without that middleware — which is exactly the defensive
// contract these cheap tests lock in.
func TestPermissionHandlers_UnauthenticatedBranches(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupBoardOwnerDB(t)
	defer func() { _ = db.Close() }()

	gin.SetMode(gin.TestMode)

	cases := []struct {
		name   string
		route  string
		method string
		path   string
		body   string
	}{
		{"GetPermissions", "/p", "GET", "/p", ""},
		{"SetPermission", "/p", "POST", "/p", ""},
		{"DeletePermission", "/p", "DELETE", "/p", ""},
		{"BulkSetPermissions", "/p", "POST", "/p", ""},
		{"BulkGrantPermissions", "/p", "POST", "/p", ""},
		{"TransferOwnership", "/p", "POST", "/p", ""},
		{"UpdateAppConfig", "/p", "POST", "/p", ""},
		{"GetColumnPermissions", "/p", "GET", "/p", ""},
		{"SetColumnPermission", "/p", "POST", "/p", ""},
		{"DeleteColumnPermission", "/p", "DELETE", "/p", ""},
	}

	handlersByRoute := map[string]func(*sql.DB) gin.HandlerFunc{
		"GetPermissions":         GetPermissions,
		"SetPermission":          SetPermission,
		"DeletePermission":       DeletePermission,
		"BulkSetPermissions":     BulkSetPermissions,
		"BulkGrantPermissions":   BulkGrantPermissions,
		"TransferOwnership":      TransferOwnership,
		"UpdateAppConfig":        UpdateAppConfig,
		"GetColumnPermissions":   GetColumnPermissions,
		"SetColumnPermission":    SetColumnPermission,
		"DeleteColumnPermission": DeleteColumnPermission,
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := gin.New()
			switch tc.method {
			case "GET":
				r.GET(tc.route, handlersByRoute[tc.name](db))
			case "POST":
				r.POST(tc.route, handlersByRoute[tc.name](db))
			case "DELETE":
				r.DELETE(tc.route, handlersByRoute[tc.name](db))
			}
			w := doRequest(r, tc.method, tc.path, "", tc.body, false)
			if w.Code != http.StatusUnauthorized {
				t.Errorf("expected 401, got %d: %s", w.Code, w.Body.String())
			}
		})
	}
}

// TestPermissionHandlers_BindErrorBranches covers the ShouldBindJSON
// failure path in every handler that accepts a JSON body.
func TestPermissionHandlers_BindErrorBranches(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupBoardOwnerDB(t)
	defer func() { _ = db.Close() }()

	gin.SetMode(gin.TestMode)

	cases := []struct {
		name    string
		handler func(*sql.DB) gin.HandlerFunc
	}{
		{"SetPermission", SetPermission},
		{"BulkSetPermissions", BulkSetPermissions},
		{"BulkGrantPermissions", BulkGrantPermissions},
		{"TransferOwnership", TransferOwnership},
		{"UpdateAppConfig", UpdateAppConfig},
		{"SetColumnPermission", SetColumnPermission},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := gin.New()
			r.POST("/p", tc.handler(db))
			w := doRequest(r, "POST", "/p", "admin-token", `{"broken":`, true)
			if w.Code != http.StatusBadRequest {
				t.Errorf("expected 400, got %d: %s", w.Code, w.Body.String())
			}
		})
	}
}

func TestGetPermissions_QueryError(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()

	db := setupBoardOwnerDB(t)
	defer func() { _ = db.Close() }()

	if _, err := db.Exec("DROP TABLE board_permissions"); err != nil {
		t.Fatalf("drop board_permissions: %v", err)
	}

	r := gin.New()
	r.GET("/p", GetPermissions(db))
	w := doRequest(r, "GET", "/p", "admin-token", "", false)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d: %s", w.Code, w.Body.String())
	}
}

func TestGetColumnPermissions_ExtraBranches(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()
	gin.SetMode(gin.TestMode)

	t.Run("non-admin requesting another user's grants returns 403", func(t *testing.T) {
		db := setupBoardOwnerDB(t)
		defer func() { _ = db.Close() }()
		seedCoverageColumns(t, db)

		r := gin.New()
		r.GET("/p", GetColumnPermissions(db))
		w := doRequest(r, "GET", "/p?userId=admin1", "member1-token", "", false)
		if w.Code != http.StatusForbidden {
			t.Fatalf("expected 403, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("non-admin scoping by unknown column returns 500", func(t *testing.T) {
		db := setupBoardOwnerDB(t)
		defer func() { _ = db.Close() }()
		seedCoverageColumns(t, db)

		r := gin.New()
		r.GET("/p", GetColumnPermissions(db))
		w := doRequest(r, "GET", "/p?columnId=missing", "member1-token", "", false)
		if w.Code != http.StatusInternalServerError {
			t.Fatalf("expected 500, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("non-admin scoping by a column they do not own returns 403", func(t *testing.T) {
		db := setupBoardOwnerDB(t)
		defer func() { _ = db.Close() }()
		seedCoverageColumns(t, db)

		r := gin.New()
		r.GET("/p", GetColumnPermissions(db))
		w := doRequest(r, "GET", "/p?columnId=col1", "member1-token", "", false)
		if w.Code != http.StatusForbidden {
			t.Fatalf("expected 403, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("admin scoping by column returns the unified rows", func(t *testing.T) {
		db := setupBoardOwnerDB(t)
		defer func() { _ = db.Close() }()
		seedCoverageColumns(t, db)

		r := gin.New()
		r.GET("/p", GetColumnPermissions(db))
		w := doRequest(r, "GET", "/p?columnId=col1", "admin-token", "", false)
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
		if !bytes.Contains(w.Body.Bytes(), []byte(`"expiresAt":"`)) {
			t.Errorf("expected populated expiresAt in response, got %s", w.Body.String())
		}
	})

	t.Run("query failure returns 500", func(t *testing.T) {
		db := setupBoardOwnerDB(t)
		defer func() { _ = db.Close() }()
		if _, err := db.Exec("DROP TABLE column_permissions"); err != nil {
			t.Fatalf("drop column_permissions: %v", err)
		}

		r := gin.New()
		r.GET("/p", GetColumnPermissions(db))
		w := doRequest(r, "GET", "/p", "admin-token", "", false)
		if w.Code != http.StatusInternalServerError {
			t.Fatalf("expected 500, got %d: %s", w.Code, w.Body.String())
		}
	})
}

func TestSetColumnPermission_ExtraBranches(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()
	gin.SetMode(gin.TestMode)

	t.Run("unknown column returns 500", func(t *testing.T) {
		db := setupBoardOwnerDB(t)
		defer func() { _ = db.Close() }()
		seedCoverageColumns(t, db)

		r := gin.New()
		r.POST("/p", SetColumnPermission(db))
		w := doRequest(r, "POST", "/p", "admin-token", `{"columnId":"missing","userId":"member1","access":"READ"}`, true)
		if w.Code != http.StatusInternalServerError {
			t.Fatalf("expected 500, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("owner lookup error returns 500", func(t *testing.T) {
		db := setupBoardOwnerDB(t)
		defer func() { _ = db.Close() }()
		seedCoverageColumns(t, db)
		if _, err := db.Exec("DROP TABLE board_permissions"); err != nil {
			t.Fatalf("drop board_permissions: %v", err)
		}

		r := gin.New()
		r.POST("/p", SetColumnPermission(db))
		w := doRequest(r, "POST", "/p", "admin-token", `{"columnId":"col1","userId":"member1","access":"READ"}`, true)
		if w.Code != http.StatusInternalServerError {
			t.Fatalf("expected 500, got %d: %s", w.Code, w.Body.String())
		}
	})
}

func TestDeleteColumnPermission_ExtraBranches(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()
	gin.SetMode(gin.TestMode)

	t.Run("unknown id is an idempotent 200", func(t *testing.T) {
		db := setupBoardOwnerDB(t)
		defer func() { _ = db.Close() }()

		r := gin.New()
		r.DELETE("/p", DeleteColumnPermission(db))
		w := doRequest(r, "DELETE", "/p?id=does-not-exist", "admin-token", "", false)
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("load failure (table missing) returns 500", func(t *testing.T) {
		db := setupBoardOwnerDB(t)
		defer func() { _ = db.Close() }()
		if _, err := db.Exec("DROP TABLE column_permissions"); err != nil {
			t.Fatalf("drop column_permissions: %v", err)
		}

		r := gin.New()
		r.DELETE("/p", DeleteColumnPermission(db))
		w := doRequest(r, "DELETE", "/p?id=whatever", "admin-token", "", false)
		if w.Code != http.StatusInternalServerError {
			t.Fatalf("expected 500, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("owner lookup error returns 500", func(t *testing.T) {
		db := setupBoardOwnerDB(t)
		defer func() { _ = db.Close() }()
		seedCoverageColumns(t, db)
		if _, err := db.Exec("DROP TABLE board_permissions"); err != nil {
			t.Fatalf("drop board_permissions: %v", err)
		}

		r := gin.New()
		r.DELETE("/p", DeleteColumnPermission(db))
		w := doRequest(r, "DELETE", "/p?id=cp-cover", "admin-token", "", false)
		if w.Code != http.StatusInternalServerError {
			t.Fatalf("expected 500, got %d: %s", w.Code, w.Body.String())
		}
	})
}

func TestDeletePermission_ExtraBranches(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()
	gin.SetMode(gin.TestMode)

	t.Run("unknown id is an idempotent 200", func(t *testing.T) {
		db := setupBoardOwnerDB(t)
		defer func() { _ = db.Close() }()

		r := gin.New()
		r.DELETE("/p", DeletePermission(db))
		w := doRequest(r, "DELETE", "/p?id=does-not-exist", "admin-token", "", false)
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("load failure (table missing) returns 500", func(t *testing.T) {
		db := setupBoardOwnerDB(t)
		defer func() { _ = db.Close() }()
		if _, err := db.Exec("DROP TABLE board_permissions"); err != nil {
			t.Fatalf("drop board_permissions: %v", err)
		}

		r := gin.New()
		r.DELETE("/p", DeletePermission(db))
		w := doRequest(r, "DELETE", "/p?id=whatever", "admin-token", "", false)
		if w.Code != http.StatusInternalServerError {
			t.Fatalf("expected 500, got %d: %s", w.Code, w.Body.String())
		}
	})
}

func TestBulkSetPermissions_ExtraBranches(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()
	gin.SetMode(gin.TestMode)

	t.Run("board load failure returns 500", func(t *testing.T) {
		db := setupBoardOwnerDB(t)
		defer func() { _ = db.Close() }()
		if _, err := db.Exec("DROP TABLE boards"); err != nil {
			t.Fatalf("drop boards: %v", err)
		}

		r := gin.New()
		r.POST("/p", BulkSetPermissions(db))
		w := doRequest(r, "POST", "/p", "admin-token", `{"boardId":"board1","userIds":["member1"],"access":"READ"}`, true)
		if w.Code != http.StatusInternalServerError {
			t.Fatalf("expected 500, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("user verification failure returns 500", func(t *testing.T) {
		db := setupBoardOwnerDB(t)
		defer func() { _ = db.Close() }()
		if _, err := db.Exec("DROP TABLE users"); err != nil {
			t.Fatalf("drop users: %v", err)
		}
		seedCachedSessionForTest("cached-admin", "admin1", "ADMIN")

		r := gin.New()
		r.POST("/p", BulkSetPermissions(db))
		w := doRequest(r, "POST", "/p", "cached-admin", `{"boardId":"board1","userIds":["member1"],"access":"READ"}`, true)
		if w.Code != http.StatusInternalServerError {
			t.Fatalf("expected 500, got %d: %s", w.Code, w.Body.String())
		}
	})
}

func TestBulkGrantPermissions_ExtraBranches(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()
	gin.SetMode(gin.TestMode)

	t.Run("board load failure returns 500", func(t *testing.T) {
		db := setupBoardOwnerDB(t)
		defer func() { _ = db.Close() }()
		if _, err := db.Exec("DROP TABLE boards"); err != nil {
			t.Fatalf("drop boards: %v", err)
		}

		r := gin.New()
		r.POST("/p", BulkGrantPermissions(db))
		w := doRequest(r, "POST", "/p", "admin-token", `{"boardId":"board1","grants":[{"userId":"member1","access":"READ"}]}`, true)
		if w.Code != http.StatusInternalServerError {
			t.Fatalf("expected 500, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("user verification failure returns 500", func(t *testing.T) {
		db := setupBoardOwnerDB(t)
		defer func() { _ = db.Close() }()
		if _, err := db.Exec("DROP TABLE users"); err != nil {
			t.Fatalf("drop users: %v", err)
		}
		seedCachedSessionForTest("cached-admin-grant", "admin1", "ADMIN")

		r := gin.New()
		r.POST("/p", BulkGrantPermissions(db))
		w := doRequest(r, "POST", "/p", "cached-admin-grant", `{"boardId":"board1","grants":[{"userId":"member1","access":"READ"}]}`, true)
		if w.Code != http.StatusInternalServerError {
			t.Fatalf("expected 500, got %d: %s", w.Code, w.Body.String())
		}
	})
}

func TestTransferOwnership_ExtraBranches(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()
	gin.SetMode(gin.TestMode)

	t.Run("ownership lookup error returns 500", func(t *testing.T) {
		db := setupBoardOwnerDB(t)
		defer func() { _ = db.Close() }()
		if _, err := db.Exec("DROP TABLE board_permissions"); err != nil {
			t.Fatalf("drop board_permissions: %v", err)
		}

		r := gin.New()
		r.POST("/p", TransferOwnership(db))
		w := doRequest(r, "POST", "/p", "member1-token", `{"boardId":"board1","newOwnerUserId":"member2"}`, true)
		if w.Code != http.StatusInternalServerError {
			t.Fatalf("expected 500, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("board load failure returns 500", func(t *testing.T) {
		db := setupBoardOwnerDB(t)
		defer func() { _ = db.Close() }()
		if _, err := db.Exec("DROP TABLE boards"); err != nil {
			t.Fatalf("drop boards: %v", err)
		}

		r := gin.New()
		r.POST("/p", TransferOwnership(db))
		w := doRequest(r, "POST", "/p", "admin-token", `{"boardId":"board1","newOwnerUserId":"member1"}`, true)
		if w.Code != http.StatusInternalServerError {
			t.Fatalf("expected 500, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("target user lookup failure returns 500", func(t *testing.T) {
		db := setupBoardOwnerDB(t)
		defer func() { _ = db.Close() }()
		if _, err := db.Exec("DROP TABLE users"); err != nil {
			t.Fatalf("drop users: %v", err)
		}
		seedCachedSessionForTest("cached-admin-transfer", "admin1", "ADMIN")

		r := gin.New()
		r.POST("/p", TransferOwnership(db))
		w := doRequest(r, "POST", "/p", "cached-admin-transfer", `{"boardId":"board1","newOwnerUserId":"member2"}`, true)
		if w.Code != http.StatusInternalServerError {
			t.Fatalf("expected 500, got %d: %s", w.Code, w.Body.String())
		}
	})
}

func TestUpdateAppConfig_ExtraBranches(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()
	gin.SetMode(gin.TestMode)

	// setupBoardOwnerDB deliberately omits app_config, so every REPLACE
	// fails and drives the per-field error branch. Each subtest sends a
	// single field so the failure lands on that field's Exec.
	cases := []struct {
		name string
		body string
	}{
		{"allowRegistration", `{"allowRegistration":true}`},
		{"requirePassword", `{"requirePassword":true}`},
		{"authEnabled", `{"authEnabled":true}`},
		{"marketplaceEnabled", `{"marketplaceEnabled":true}`},
		{"frontendEventsEnabled", `{"frontendEventsEnabled":true}`},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			db := setupBoardOwnerDB(t)
			defer func() { _ = db.Close() }()

			r := gin.New()
			r.POST("/p", UpdateAppConfig(db))
			w := doRequest(r, "POST", "/p", "admin-token", tc.body, true)
			if w.Code != http.StatusInternalServerError {
				t.Fatalf("expected 500, got %d: %s", w.Code, w.Body.String())
			}
		})
	}

	t.Run("non-admin is forbidden", func(t *testing.T) {
		db := setupBoardOwnerDB(t)
		defer func() { _ = db.Close() }()

		r := gin.New()
		r.POST("/p", UpdateAppConfig(db))
		w := doRequest(r, "POST", "/p", "member1-token", `{"allowRegistration":true}`, true)
		if w.Code != http.StatusForbidden {
			t.Fatalf("expected 403, got %d: %s", w.Code, w.Body.String())
		}
	})
}

func TestParseGrantExpiresAt_Formats(t *testing.T) {
	cases := []struct {
		name    string
		input   string
		wantErr bool
	}{
		{"rfc3339", "2027-01-01T10:00:00Z", false},
		{"rfc3339-no-zone", "2027-01-01T10:00:00", false},
		{"space-separated", "2027-01-01 10:00:00", false},
		{"date-only", "2027-01-01", false},
		{"garbage", "not-a-date", true},
		{"empty", "", true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseGrantExpiresAt(tc.input)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error for %q, got %v", tc.input, got)
				}
				if err.Error() != "invalid expires_at format" {
					t.Errorf("unexpected error message: %q", err.Error())
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error for %q: %v", tc.input, err)
			}
			if got.IsZero() {
				t.Errorf("expected non-zero time for %q", tc.input)
			}
		})
	}
}
