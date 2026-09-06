package handlers

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

// TestGetMyBoardPermissions_AllRoles exhaustively pins the response
// shape returned by GET /api/v1/auth/me/board-permissions for every
// interesting (user, board) combination. The cases table is the
// single source of truth — adding a new access level or role grants
// requires touching the table below rather than scattering asserts
// across the suite.
//
// Anti-enumeration behavior is exercised separately below.
func TestGetMyBoardPermissions_AllRoles(t *testing.T) {
	ResetTokenCacheForTest()
	ResetPermissionCacheForTest()
	t.Cleanup(func() {
		ResetTokenCacheForTest()
		ResetPermissionCacheForTest()
	})

	db := setupPermissionIntegrationDB(t)
	defer db.Close()

	type want struct {
		status                     int
		effectiveAccess            string
		isOwner                    bool
		canManageBoardPermissions  bool
		canManageColumnPermissions bool
	}

	cases := []struct {
		name      string
		token     string
		userRole  string
		boardID   string
		override  func(t *testing.T, db *sql.DB)
		want      want
	}{
		{
			// admin1 owns board2 via owner_agent_id AND is a global
			// ADMIN. The handler must surface both flags so the
			// frontend's shield affordance is shown.
			name:     "global admin who is also board owner",
			token:    "admin1-token",
			userRole: "ADMIN",
			boardID:  "board2",
			want: want{
				status:                     http.StatusOK,
				effectiveAccess:            "ADMIN",
				isOwner:                    true,
				canManageBoardPermissions:  true,
				canManageColumnPermissions: true,
			},
		},
		{
			// admin2 is a global ADMIN with no grant row on board1.
			// The handler must still report effectiveAccess=ADMIN
			// (the global short-circuit wins), isOwner=false
			// (no owner_agent_id on admin2's row), and both
			// canManage* = true (global ADMIN always qualifies
			// for column management; canManageBoardPermissions
			// also accepts global ADMINs).
			name:     "global admin without ownership row",
			token:    "admin2-token",
			userRole: "ADMIN",
			boardID:  "board1",
			want: want{
				status:                     http.StatusOK,
				effectiveAccess:            "ADMIN",
				isOwner:                    false,
				canManageBoardPermissions:  true,
				canManageColumnPermissions: true,
			},
		},
		{
			// owner1 is recorded as the owner of board1 but their
			// global role is MEMBER. The handler must report
			// effectiveAccess=ADMIN (owner short-circuit), isOwner
			// =true, and canManageBoardPermissions=true (owner
			// qualifies for permission management). Column
			// permission management is intentionally NOT granted
			// to non-global-admin owners — the existing column
			// permission handler still requires global ADMIN.
			name:     "board owner with MEMBER global role",
			token:    "owner1-token",
			userRole: "MEMBER",
			boardID:  "board1",
			want: want{
				status:                     http.StatusOK,
				effectiveAccess:            "ADMIN",
				isOwner:                    true,
				canManageBoardPermissions:  true,
				canManageColumnPermissions: false,
			},
		},
		{
			// member1 has an explicit board WRITE on board1 with
			// no owner_agent_id. Effective access is WRITE, no
			// ownership flag, no manage-permissions capability.
			name:     "MEMBER with WRITE grant",
			token:    "member1-token",
			userRole: "MEMBER",
			boardID:  "board1",
			want: want{
				status:                     http.StatusOK,
				effectiveAccess:            "WRITE",
				isOwner:                    false,
				canManageBoardPermissions:  false,
				canManageColumnPermissions: false,
			},
		},
		{
			// viewer1 has a READ grant on board1 and a VIEWER
			// global role. Effective access stays READ (the
			// access-helper layer does NOT block writes for
			// VIEWER — requireNonViewer is handler-layer), but
			// no manage-permissions capability is exposed.
			name:     "VIEWER with READ grant",
			token:    "viewer1-token",
			userRole: "VIEWER",
			boardID:  "board1",
			want: want{
				status:                     http.StatusOK,
				effectiveAccess:            "READ",
				isOwner:                    false,
				canManageBoardPermissions:  false,
				canManageColumnPermissions: false,
			},
		},
		{
			// member2 has board READ on board1 but is recorded
			// as the owner of board1 (the existing
			// setupPermissionIntegrationDB seeds member2 with
			// a non-owner row). Member2 promoted to owner of
			// board1 (overriding the existing setup) — proves
			// the MEMBER-as-owner branch surfaces the same
			// canManageBoardPermissions=true a MEMBER-as-owner
			// does, regardless of the row's `access` value.
			name:     "MEMBER promoted to owner mid-test",
			token:    "member2-token",
			userRole: "MEMBER",
			boardID:  "board1",
			override: func(t *testing.T, db *sql.DB) {
				if _, err := db.Exec(
					`UPDATE board_permissions SET owner_agent_id = 'member2' WHERE user_id = 'member2' AND board_id = 'board1'`,
				); err != nil {
					t.Fatalf("failed to promote member2 to owner: %v", err)
				}
			},
			want: want{
				status:                     http.StatusOK,
				effectiveAccess:            "ADMIN",
				isOwner:                    true,
				canManageBoardPermissions:  true,
				canManageColumnPermissions: false,
			},
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			// Reset caches between cases so state cannot leak.
			ResetTokenCacheForTest()
			ResetPermissionCacheForTest()

			if tc.override != nil {
				tc.override(t, db)
				// The override may have flipped a row that's
				// already cached, so flush again.
				ResetPermissionCacheForTest()
			}

			router := gin.New()
			router.Use(RequireAuth(db))
			router.GET("/api/v1/auth/me/board-permissions", GetMyBoardPermissions(db))

			req, _ := http.NewRequest(
				"GET",
				"/api/v1/auth/me/board-permissions?boardId="+tc.boardID,
				nil,
			)
			req.AddCookie(&http.Cookie{Name: "kanban-token", Value: tc.token})

			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)

			if w.Code != tc.want.status {
				t.Fatalf("expected status %d, got %d: %s", tc.want.status, w.Code, w.Body.String())
			}

			if tc.want.status != http.StatusOK {
				return
			}

			var resp struct {
				BoardID                    string `json:"boardId"`
				EffectiveAccess            string `json:"effectiveAccess"`
				IsOwner                    bool   `json:"isOwner"`
				CanManageBoardPermissions  bool   `json:"canManageBoardPermissions"`
				CanManageColumnPermissions bool   `json:"canManageColumnPermissions"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
				t.Fatalf("failed to unmarshal response: %v", err)
			}

			if resp.BoardID != tc.boardID {
				t.Errorf("expected boardId=%q, got %q", tc.boardID, resp.BoardID)
			}
			if resp.EffectiveAccess != tc.want.effectiveAccess {
				t.Errorf("expected effectiveAccess=%q, got %q", tc.want.effectiveAccess, resp.EffectiveAccess)
			}
			if resp.IsOwner != tc.want.isOwner {
				t.Errorf("expected isOwner=%v, got %v", tc.want.isOwner, resp.IsOwner)
			}
			if resp.CanManageBoardPermissions != tc.want.canManageBoardPermissions {
				t.Errorf("expected canManageBoardPermissions=%v, got %v",
					tc.want.canManageBoardPermissions, resp.CanManageBoardPermissions)
			}
			if resp.CanManageColumnPermissions != tc.want.canManageColumnPermissions {
				t.Errorf("expected canManageColumnPermissions=%v, got %v",
					tc.want.canManageColumnPermissions, resp.CanManageColumnPermissions)
			}
		})
	}
}

// TestGetMyBoardPermissions_NoAccess_Returns404 covers the
// anti-enumeration branch: a user with no board_permissions row
// and no owner_agent_id must NOT be able to distinguish "board
// missing" from "board exists, no access". Both collapse to a
// 404 response.
//
// We exercise the (member2, board2) pair — member2 has no
// permission on board2 in the seed — and also exercise a
// non-existent boardId to confirm both cases return identical
// 404s.
func TestGetMyBoardPermissions_NoAccess_Returns404(t *testing.T) {
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
			router.GET("/api/v1/auth/me/board-permissions", GetMyBoardPermissions(db))

			req, _ := http.NewRequest(
				"GET",
				"/api/v1/auth/me/board-permissions?boardId="+tc.boardID,
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

// TestGetMyBoardPermissions_MissingBoardID confirms the missing
// boardId query parameter is rejected with a 400 before any
// permission lookup runs.
func TestGetMyBoardPermissions_MissingBoardID(t *testing.T) {
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
	router.GET("/api/v1/auth/me/board-permissions", GetMyBoardPermissions(db))

	req, _ := http.NewRequest(
		"GET",
		"/api/v1/auth/me/board-permissions",
		nil,
	)
	req.AddCookie(&http.Cookie{Name: "kanban-token", Value: "member1-token"})

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for missing boardId, got %d: %s", w.Code, w.Body.String())
	}
}