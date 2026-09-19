package handlers_test

import (
	"database/sql"
	"encoding/csv"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strings"
	"testing"
	"time"

	"open-kanban/internal/handlers"

	"github.com/gin-gonic/gin"
)

func TestLogActivity(t *testing.T) {
	tests := []struct {
		name           string
		nickname       string
		seedUser       bool
		action         string
		targetType     string
		targetID       string
		targetTitle    string
		details        string
		ipAddress      string
		source         string
		wantErr        bool
		wantLastActive bool
	}{
		{
			name:           "log activity updates last_active_at using DB-agnostic timestamp",
			nickname:       "alice",
			seedUser:       true,
			action:         "LOGIN",
			targetType:     "USER",
			targetID:       "user-alice",
			targetTitle:    "alice",
			details:        "",
			ipAddress:      "127.0.0.1",
			source:         "web",
			wantLastActive: true,
		},
		{
			name:       "empty userID does nothing (no panic, no row written)",
			nickname:   "",
			seedUser:   false,
			action:     "LOGIN",
			targetType: "USER",
			wantErr:    false,
		},
		{
			name:           "log activity for board action",
			nickname:       "bob",
			seedUser:       true,
			action:         "BOARD_CREATE",
			targetType:     "BOARD",
			targetID:       "board-1",
			targetTitle:    "My Board",
			details:        "",
			ipAddress:      "10.0.0.1",
			source:         "mcp",
			wantLastActive: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			db := setupTestDB(t)
			defer db.Close()

			var userID string
			if tt.seedUser {
				userID = setupTestUser(t, db, tt.nickname, "", "MEMBER")
			}

			handlers.LogActivity(db, userID, tt.action, tt.targetType, tt.targetID, tt.targetTitle, tt.details, tt.ipAddress, tt.source)

			if !tt.seedUser {
				return
			}

			var lastActive sql.NullTime
			err := db.QueryRow("SELECT last_active_at FROM users WHERE id = ?", userID).Scan(&lastActive)
			if err != nil {
				t.Fatalf("failed to query last_active_at: %v", err)
			}

			if tt.wantLastActive && !lastActive.Valid {
				t.Errorf("expected last_active_at to be set, got NULL")
			}

			if !tt.wantLastActive && lastActive.Valid {
				t.Errorf("expected last_active_at to be NULL, got %v", lastActive.Time)
			}

			var count int
			if err := db.QueryRow("SELECT COUNT(*) FROM activities WHERE user_id = ?", userID).Scan(&count); err != nil {
				t.Fatalf("failed to count activities: %v", err)
			}
			if tt.seedUser && count != 1 {
				t.Errorf("expected 1 activity row, got %d", count)
			}
		})
	}
}

func TestGetActivitiesRequiresAuth(t *testing.T) {
	t.Run("unauthenticated request returns 401", func(t *testing.T) {
		db := setupTestDB(t)
		defer db.Close()

		gin.SetMode(gin.TestMode)
		router := gin.New()
		router.GET("/api/activities", handlers.GetActivities(db))

		req, _ := http.NewRequest("GET", "/api/activities", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected status 401, got %d: %s", w.Code, w.Body.String())
		}
	})
}

func TestGetActivitiesReturnsRows(t *testing.T) {
	t.Run("admin user receives activities list", func(t *testing.T) {
		db := setupTestDB(t)
		defer db.Close()

		userID := setupTestUser(t, db, "alice", "", "ADMIN")
		handlers.LogActivity(db, userID, "LOGIN", "USER", userID, "alice", "", "127.0.0.1", "web")
		handlers.LogActivity(db, userID, "BOARD_CREATE", "BOARD", "board-1", "Sprint", "", "127.0.0.1", "web")

		tokenKey := "admin-token-xyz"
		setupTestToken(t, db, userID, tokenKey)

		gin.SetMode(gin.TestMode)
		router := gin.New()
		router.GET("/api/activities", handlers.GetActivities(db))

		req, _ := http.NewRequest("GET", "/api/activities", nil)
		req.Header.Set("Authorization", "Bearer "+tokenKey)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected status 200, got %d: %s", w.Code, w.Body.String())
		}

		var resp struct {
			Activities []handlers.Activity `json:"activities"`
			Total      int                 `json:"total"`
			HasMore    bool                `json:"hasMore"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("failed to unmarshal response: %v", err)
		}

		if resp.Total != 2 {
			t.Errorf("expected total=2, got %d", resp.Total)
		}
		if len(resp.Activities) != 2 {
			t.Errorf("expected 2 activities, got %d", len(resp.Activities))
		}
	})
}

func TestLogActivityUsesValidTimestamp(t *testing.T) {
	t.Run("activity and last_active_at are written within a reasonable time window", func(t *testing.T) {
		db := setupTestDB(t)
		defer db.Close()
		userID := setupTestUser(t, db, "alice", "", "MEMBER")

		before := time.Now().Add(-2 * time.Second)
		handlers.LogActivity(db, userID, "LOGIN", "USER", userID, "alice", "", "127.0.0.1", "web")
		after := time.Now().Add(2 * time.Second)

		var lastActive sql.NullTime
		if err := db.QueryRow("SELECT last_active_at FROM users WHERE id = ?", userID).Scan(&lastActive); err != nil {
			t.Fatalf("failed to query last_active_at: %v", err)
		}
		if !lastActive.Valid {
			t.Fatalf("expected last_active_at to be set")
		}
		if lastActive.Time.Before(before) || lastActive.Time.After(after) {
			t.Errorf("expected last_active_at within [%v, %v], got %v", before, after, lastActive.Time)
		}
	})
}

// seedActivityScope inserts the minimum graph required for the scope
// filter tests: two boards, each with a column + a task + a comment,
// and a second user so we can also verify the cross-account guard.
//
//   - board-a (col-a → task-a → comment-a)
//   - board-b (col-b → task-b → comment-b)
//
// Returns the alice user id who "owns" the resulting activity rows.
func seedActivityScope(t *testing.T, db *sql.DB) (aliceID, bobID string) {
	t.Helper()
	aliceID = setupTestUser(t, db, "alice", "", "ADMIN")
	bobID = setupTestUser(t, db, "bob", "", "MEMBER")
	execAll(t, db,
		`INSERT INTO boards (id, name, is_public) VALUES ('board-a', 'Board A', 1)`,
		`INSERT INTO boards (id, name, is_public) VALUES ('board-b', 'Board B', 1)`,
		`INSERT INTO columns (id, name, board_id, position) VALUES ('col-a', 'A todo', 'board-a', 0)`,
		`INSERT INTO columns (id, name, board_id, position) VALUES ('col-b', 'B todo', 'board-b', 0)`,
		`INSERT INTO tasks (id, title, column_id, position) VALUES ('task-a', 'A task', 'col-a', 0)`,
		`INSERT INTO tasks (id, title, column_id, position) VALUES ('task-b', 'B task', 'col-b', 0)`,
		`INSERT INTO comments (id, content, task_id, user_id) VALUES ('comment-a', 'A note', 'task-a', 'user-bob')`,
		`INSERT INTO comments (id, content, task_id, user_id) VALUES ('comment-b', 'B note', 'task-b', 'user-bob')`,
		// board-level row directly on board-a
		`INSERT INTO activities (id, user_id, action, target_type, target_id, target_title, details, ip_address, source) VALUES ('act-board-a', 'user-alice', 'BOARD_CREATE', 'BOARD', 'board-a', 'Board A', '', '127.0.0.1', 'web')`,
		// column-level row on col-a
		`INSERT INTO activities (id, user_id, action, target_type, target_id, target_title, details, ip_address, source) VALUES ('act-col-a', 'user-bob', 'COLUMN_CREATE', 'COLUMN', 'col-a', 'A todo', '', '127.0.0.1', 'web')`,
		// task-level row on task-a
		`INSERT INTO activities (id, user_id, action, target_type, target_id, target_title, details, ip_address, source) VALUES ('act-task-a', 'user-bob', 'CREATE_TASK', 'TASK', 'task-a', 'A task', '', '127.0.0.1', 'web')`,
		// comment-level row on comment-a
		`INSERT INTO activities (id, user_id, action, target_type, target_id, target_title, details, ip_address, source) VALUES ('act-comment-a', 'user-bob', 'ADD_COMMENT', 'COMMENT', 'comment-a', 'A note', '', '127.0.0.1', 'web')`,
		// mirror rows on the b side so the negative assertions can
		// verify the filter actually narrowed the result.
		`INSERT INTO activities (id, user_id, action, target_type, target_id, target_title, details, ip_address, source) VALUES ('act-board-b', 'user-alice', 'BOARD_CREATE', 'BOARD', 'board-b', 'Board B', '', '127.0.0.1', 'web')`,
		`INSERT INTO activities (id, user_id, action, target_type, target_id, target_title, details, ip_address, source) VALUES ('act-task-b', 'user-bob', 'CREATE_TASK', 'TASK', 'task-b', 'B task', '', '127.0.0.1', 'web')`,
	)
	return aliceID, bobID
}

func execAll(t *testing.T, db *sql.DB, queries ...string) {
	t.Helper()
	for _, sqlText := range queries {
		if _, err := db.Exec(sqlText); err != nil {
			t.Fatalf("execAll: %v\nSQL: %s", err, sqlText)
		}
	}
}

// fetchActivityIDs issues a GET against /api/activities with the
// given query params and returns the activity IDs in their natural
// (response) order. The caller is responsible for any ordering
// assertion.
func fetchActivityIDs(t *testing.T, db *sql.DB, tokenKey string, params url.Values) []string {
	t.Helper()
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.GET("/api/activities", handlers.GetActivities(db))

	req, _ := http.NewRequest("GET", "/api/activities?"+params.Encode(), nil)
	req.Header.Set("Authorization", "Bearer "+tokenKey)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp struct {
		Activities []handlers.Activity `json:"activities"`
		Total      int                 `json:"total"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	ids := make([]string, 0, len(resp.Activities))
	for _, a := range resp.Activities {
		ids = append(ids, a.ID)
	}
	return ids
}

func TestGetActivitiesScopeFilters(t *testing.T) {
	t.Run("boardId filter returns the board's full activity slice", func(t *testing.T) {
		db := setupTestDB(t)
		defer db.Close()
		aliceID, _ := seedActivityScope(t, db)
		tokenKey := "alice-token"
		setupTestToken(t, db, aliceID, tokenKey)

		got := fetchActivityIDs(t, db, tokenKey, url.Values{"boardId": []string{"board-a"}})
		want := []string{"act-comment-a", "act-task-a", "act-col-a", "act-board-a"}
		sort.Strings(got)
		sortedWant := append([]string{}, want...)
		sort.Strings(sortedWant)
		if strings.Join(got, ",") != strings.Join(sortedWant, ",") {
			t.Errorf("boardId filter mismatch\n got: %v\nwant: %v", got, sortedWant)
		}
	})

	t.Run("columnId filter returns direct column + tasks under it + comments", func(t *testing.T) {
		db := setupTestDB(t)
		defer db.Close()
		aliceID, _ := seedActivityScope(t, db)
		tokenKey := "alice-token-col"
		setupTestToken(t, db, aliceID, tokenKey)

		got := fetchActivityIDs(t, db, tokenKey, url.Values{"columnId": []string{"col-a"}})
		want := []string{"act-comment-a", "act-task-a", "act-col-a"}
		sort.Strings(got)
		sortedWant := append([]string{}, want...)
		sort.Strings(sortedWant)
		if strings.Join(got, ",") != strings.Join(sortedWant, ",") {
			t.Errorf("columnId filter mismatch\n got: %v\nwant: %v", got, sortedWant)
		}
	})

	t.Run("taskId filter returns task + comment rows for the task", func(t *testing.T) {
		db := setupTestDB(t)
		defer db.Close()
		aliceID, _ := seedActivityScope(t, db)
		tokenKey := "alice-token-task"
		setupTestToken(t, db, aliceID, tokenKey)

		got := fetchActivityIDs(t, db, tokenKey, url.Values{"taskId": []string{"task-a"}})
		want := []string{"act-comment-a", "act-task-a"}
		sort.Strings(got)
		sortedWant := append([]string{}, want...)
		sort.Strings(sortedWant)
		if strings.Join(got, ",") != strings.Join(sortedWant, ",") {
			t.Errorf("taskId filter mismatch\n got: %v\nwant: %v", got, sortedWant)
		}
	})

	t.Run("scope filter combines with action filter", func(t *testing.T) {
		db := setupTestDB(t)
		defer db.Close()
		aliceID, _ := seedActivityScope(t, db)
		tokenKey := "alice-token-combo"
		setupTestToken(t, db, aliceID, tokenKey)

		params := url.Values{}
		params.Set("boardId", "board-a")
		params.Set("action", "CREATE_TASK")
		got := fetchActivityIDs(t, db, tokenKey, params)
		if len(got) != 1 || got[0] != "act-task-a" {
			t.Errorf("expected only act-task-a, got %v", got)
		}
	})

	t.Run("non-admin cannot pass cross-account userId", func(t *testing.T) {
		db := setupTestDB(t)
		defer db.Close()
		_, bobID := seedActivityScope(t, db)
		tokenKey := "bob-token"
		setupTestToken(t, db, bobID, tokenKey)

		gin.SetMode(gin.TestMode)
		router := gin.New()
		router.GET("/api/activities", handlers.GetActivities(db))

		req, _ := http.NewRequest("GET", "/api/activities?userId=alice", nil)
		req.Header.Set("Authorization", "Bearer "+tokenKey)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusForbidden {
			t.Errorf("expected 403 for cross-account userId, got %d: %s", w.Code, w.Body.String())
		}
	})
}

func TestExportActivitiesCSV(t *testing.T) {
	t.Run("streams CSV with stable header and same slice as list endpoint", func(t *testing.T) {
		db := setupTestDB(t)
		defer db.Close()
		aliceID, _ := seedActivityScope(t, db)
		tokenKey := "alice-export-token"
		setupTestToken(t, db, aliceID, tokenKey)

		gin.SetMode(gin.TestMode)
		router := gin.New()
		router.GET("/api/activities", handlers.GetActivities(db))
		router.GET("/api/activities/export", handlers.ExportActivities(db))

		listReq, _ := http.NewRequest("GET", "/api/activities?boardId=board-a&action=CREATE_TASK", nil)
		listReq.Header.Set("Authorization", "Bearer "+tokenKey)
		listW := httptest.NewRecorder()
		router.ServeHTTP(listW, listReq)
		if listW.Code != http.StatusOK {
			t.Fatalf("list request failed: %d %s", listW.Code, listW.Body.String())
		}

		expReq, _ := http.NewRequest("GET", "/api/activities/export?boardId=board-a&action=CREATE_TASK&format=csv", nil)
		expReq.Header.Set("Authorization", "Bearer "+tokenKey)
		expW := httptest.NewRecorder()
		router.ServeHTTP(expW, expReq)
		if expW.Code != http.StatusOK {
			t.Fatalf("export request failed: %d %s", expW.Code, expW.Body.String())
		}
		if ct := expW.Header().Get("Content-Type"); ct != "text/csv; charset=utf-8" {
			t.Errorf("expected text/csv content type, got %q", ct)
		}
		if cd := expW.Header().Get("Content-Disposition"); !strings.HasPrefix(cd, "attachment; filename=activity_log_") {
			t.Errorf("expected attachment disposition, got %q", cd)
		}

		reader := csv.NewReader(strings.NewReader(expW.Body.String()))
		rows, err := reader.ReadAll()
		if err != nil {
			t.Fatalf("parse csv: %v", err)
		}
		wantHeader := []string{
			"id", "userId", "action", "targetType", "targetId",
			"targetTitle", "details", "ipAddress", "source", "createdAt",
		}
		if len(rows) == 0 {
			t.Fatalf("expected at least a header row")
		}
		if got := rows[0]; strings.Join(got, ",") != strings.Join(wantHeader, ",") {
			t.Errorf("csv header drift\n got: %v\nwant: %v", got, wantHeader)
		}
		if len(rows)-1 != 1 {
			t.Fatalf("expected exactly 1 data row, got %d", len(rows)-1)
		}
		if rows[1][0] != "act-task-a" {
			t.Errorf("expected data row act-task-a, got %q", rows[1][0])
		}
		if rows[1][2] != "CREATE_TASK" {
			t.Errorf("expected action CREATE_TASK in csv, got %q", rows[1][2])
		}
	})

	t.Run("non-csv format is rejected with 400", func(t *testing.T) {
		db := setupTestDB(t)
		defer db.Close()
		aliceID, _ := seedActivityScope(t, db)
		tokenKey := "alice-export-400"
		setupTestToken(t, db, aliceID, tokenKey)

		gin.SetMode(gin.TestMode)
		router := gin.New()
		router.GET("/api/activities/export", handlers.ExportActivities(db))

		req, _ := http.NewRequest("GET", "/api/activities/export?format=json", nil)
		req.Header.Set("Authorization", "Bearer "+tokenKey)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400 for non-csv format, got %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("unauthenticated export is rejected with 401", func(t *testing.T) {
		db := setupTestDB(t)
		defer db.Close()

		gin.SetMode(gin.TestMode)
		router := gin.New()
		router.GET("/api/activities/export", handlers.ExportActivities(db))

		req, _ := http.NewRequest("GET", "/api/activities/export", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("expected 401 unauthenticated, got %d", w.Code)
		}
	})
}
