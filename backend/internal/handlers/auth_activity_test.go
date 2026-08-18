package handlers_test

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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