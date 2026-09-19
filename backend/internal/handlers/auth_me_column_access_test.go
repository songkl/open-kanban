package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

// TestGetMyColumnAccess_RoleMatrix pins the canCreateTask /
// canModify / canDelete decisions for every seeded user × column
// pair on board1 so the UI-gating logic the endpoint drives cannot
// silently regress. The seed (see permission_integration_test.go)
// gives:
//
//   - admin1: global ADMIN, also explicit board ADMIN row
//   - owner1: global MEMBER but recorded owner of board1
//   - member1: global MEMBER with board WRITE (no column grants)
//   - member2: global MEMBER with board READ + c1 ADMIN, c4 READ
//   - viewer1: global VIEWER with board READ + c2 READ
func TestGetMyColumnAccess_RoleMatrix(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()
	t.Cleanup(func() {
		ResetTokenCacheForTest()
		ResetPermissionCacheForTest()
	})

	db := setupPermissionIntegrationDB(t)
	defer db.Close()

	type wantCol struct {
		effectiveAccess string
		canCreate       bool
		canModify       bool
		canDelete       bool
	}

	cases := []struct {
		name      string
		token     string
		boardID   string
		wantCols  map[string]wantCol
		wantBoard string
		wantOwner bool
	}{
		{
			name:      "global admin on board1: every column ADMIN",
			token:     "admin1-token",
			boardID:   "board1",
			wantBoard: "ADMIN",
			wantOwner: false,
			wantCols: map[string]wantCol{
				"c1": {"ADMIN", true, true, true},
				"c2": {"ADMIN", true, true, true},
				"c3": {"ADMIN", true, true, true},
				"c4": {"ADMIN", true, true, true},
			},
		},
		{
			name:      "board owner (MEMBER) on board1: every column ADMIN via owner short-circuit",
			token:     "owner1-token",
			boardID:   "board1",
			wantBoard: "ADMIN",
			wantOwner: true,
			wantCols: map[string]wantCol{
				"c1": {"ADMIN", true, true, true},
				"c2": {"ADMIN", true, true, true},
				"c3": {"ADMIN", true, true, true},
				"c4": {"ADMIN", true, true, true},
			},
		},
		{
			// member1 has board WRITE on board1 and no
			// per-column grants, so every column inherits the
			// board grant. They get create + modify but not
			// delete (delete needs ADMIN).
			name:      "board WRITE user: every column inherits WRITE",
			token:     "member1-token",
			boardID:   "board1",
			wantBoard: "WRITE",
			wantOwner: false,
			wantCols: map[string]wantCol{
				"c1": {"WRITE", true, true, false},
				"c2": {"WRITE", true, true, false},
				"c3": {"WRITE", true, true, false},
				"c4": {"WRITE", true, true, false},
			},
		},
		{
			// member2 has board READ on board1, with column
			// grants c1=ADMIN (elevates that column) and c4=READ
			// (does NOT elevate above the board grant). c2 and
			// c3 fall back to board READ → no create, no modify,
			// no delete.
			name:      "mixed board+column grants: per-column wins",
			token:     "member2-token",
			boardID:   "board1",
			wantBoard: "READ",
			wantOwner: false,
			wantCols: map[string]wantCol{
				"c1": {"ADMIN", true, true, true},
				"c2": {"READ", false, false, false},
				"c3": {"READ", false, false, false},
				"c4": {"READ", false, false, false},
			},
		},
		{
			// viewer1 has board READ on board1, with c2=READ
			// column grant. Effective access is READ everywhere,
			// no create / modify / delete regardless.
			name:      "VIEWER with READ grant: never allowed to create",
			token:     "viewer1-token",
			boardID:   "board1",
			wantBoard: "READ",
			wantOwner: false,
			wantCols: map[string]wantCol{
				"c1": {"READ", false, false, false},
				"c2": {"READ", false, false, false},
				"c3": {"READ", false, false, false},
				"c4": {"READ", false, false, false},
			},
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			ResetTokenCacheForTest()
			ResetPermissionCacheForTest()

			router := gin.New()
			router.Use(RequireAuth(db))
			router.GET("/api/v1/auth/me/column-access", GetMyColumnAccess(db))

			req, _ := http.NewRequest(
				"GET",
				"/api/v1/auth/me/column-access?boardId="+tc.boardID,
				nil,
			)
			req.AddCookie(&http.Cookie{Name: "kanban-token", Value: tc.token})

			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)

			if w.Code != http.StatusOK {
				t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
			}

			var resp struct {
				BoardID     string `json:"boardId"`
				BoardAccess string `json:"boardAccess"`
				IsOwner     bool   `json:"isOwner"`
				Columns     map[string]struct {
					EffectiveAccess string `json:"effectiveAccess"`
					CanCreateTask   bool   `json:"canCreateTask"`
					CanModify       bool   `json:"canModify"`
					CanDelete       bool   `json:"canDelete"`
				} `json:"columns"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
				t.Fatalf("failed to unmarshal response: %v", err)
			}

			if resp.BoardID != tc.boardID {
				t.Errorf("expected boardId=%q, got %q", tc.boardID, resp.BoardID)
			}
			if resp.BoardAccess != tc.wantBoard {
				t.Errorf("expected boardAccess=%q, got %q", tc.wantBoard, resp.BoardAccess)
			}
			if resp.IsOwner != tc.wantOwner {
				t.Errorf("expected isOwner=%v, got %v", tc.wantOwner, resp.IsOwner)
			}

			if len(resp.Columns) != len(tc.wantCols) {
				t.Errorf("expected %d columns in response, got %d", len(tc.wantCols), len(resp.Columns))
			}
			for colID, want := range tc.wantCols {
				got, ok := resp.Columns[colID]
				if !ok {
					t.Errorf("missing column %q in response", colID)
					continue
				}
				if got.EffectiveAccess != want.effectiveAccess {
					t.Errorf("column %s effectiveAccess: want %q got %q",
						colID, want.effectiveAccess, got.EffectiveAccess)
				}
				if got.CanCreateTask != want.canCreate {
					t.Errorf("column %s canCreateTask: want %v got %v",
						colID, want.canCreate, got.CanCreateTask)
				}
				if got.CanModify != want.canModify {
					t.Errorf("column %s canModify: want %v got %v",
						colID, want.canModify, got.CanModify)
				}
				if got.CanDelete != want.canDelete {
					t.Errorf("column %s canDelete: want %v got %v",
						colID, want.canDelete, got.CanDelete)
				}
			}
		})
	}
}

// TestGetMyColumnAccess_NoAccess_Returns404 covers the
// anti-enumeration branch: a user with no board grant and no
// ownership flag must NOT be able to distinguish "board missing"
// from "board exists, no access". Both collapse to 404.
func TestGetMyColumnAccess_NoAccess_Returns404(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()
	t.Cleanup(func() {
		ResetTokenCacheForTest()
		ResetPermissionCacheForTest()
	})

	db := setupPermissionIntegrationDB(t)
	defer db.Close()

	cases := []struct {
		name    string
		token   string
		boardID string
	}{
		{
			name:    "no grant row on existing board",
			token:   "member2-token",
			boardID: "board2",
		},
		{
			name:    "no such board at all",
			token:   "member2-token",
			boardID: "board-does-not-exist",
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			ResetPermissionCacheForTest()

			router := gin.New()
			router.Use(RequireAuth(db))
			router.GET("/api/v1/auth/me/column-access", GetMyColumnAccess(db))

			req, _ := http.NewRequest(
				"GET",
				"/api/v1/auth/me/column-access?boardId="+tc.boardID,
				nil,
			)
			req.AddCookie(&http.Cookie{Name: "kanban-token", Value: tc.token})

			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)

			if w.Code != http.StatusNotFound {
				t.Fatalf("expected 404 to prevent enumeration, got %d: %s", w.Code, w.Body.String())
			}

			var resp map[string]string
			if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
				t.Fatalf("failed to unmarshal response: %v", err)
			}
			if resp["error"] == "" {
				t.Error("expected error message in 404 body")
			}
		})
	}
}

// TestGetMyColumnAccess_MissingBoardID confirms the missing
// boardId query parameter is rejected with a 400 before any
// permission lookup runs.
func TestGetMyColumnAccess_MissingBoardID(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()
	t.Cleanup(func() {
		ResetTokenCacheForTest()
		ResetPermissionCacheForTest()
	})

	db := setupPermissionIntegrationDB(t)
	defer db.Close()

	router := gin.New()
	router.Use(RequireAuth(db))
	router.GET("/api/v1/auth/me/column-access", GetMyColumnAccess(db))

	req, _ := http.NewRequest("GET", "/api/v1/auth/me/column-access", nil)
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "member1-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for missing boardId, got %d: %s", w.Code, w.Body.String())
	}
}
