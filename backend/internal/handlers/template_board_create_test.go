package handlers_test

import (
	"bytes"
	"net/http"
	"testing"

	"open-kanban/internal/handlers"

	"github.com/gin-gonic/gin"
	_ "github.com/mattn/go-sqlite3"
)

func TestCreateBoardFromTemplate_NonAdmin_BecomesOwner(t *testing.T) {
	gin.SetMode(gin.TestMode)

	tests := []struct {
		name, token, userID, role string
	}{
		{"MEMBER becomes owner", "template-member-token", "member1", "MEMBER"},
		{"VIEWER becomes owner", "template-viewer-token", "viewer1", "VIEWER"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			db := setupTemplateOwnershipTestDB(t)
			defer db.Close()
			handlers.ResetTokenCacheForTest()
			handlers.ResetPermissionCacheForTest()

			router := gin.New()
			router.Use(handlers.RequireAuth(db))
			router.POST("/api/boards/from-template", handlers.CreateBoardFromTemplate(db))

			body := bytes.NewBufferString(`{"name":"Created From Template","templateId":"template1"}`)
			w := performTemplateRequest(t, router, http.MethodPost, "/api/boards/from-template", test.token, body.Bytes())
			if w.Code != http.StatusOK {
				t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
			}
			boardID := decodeTemplateID(t, w)

			var ownerID, access string
			if err := db.QueryRow(
				`SELECT owner_agent_id, access FROM board_permissions WHERE user_id = ? AND board_id = ?`,
				test.userID, boardID,
			).Scan(&ownerID, &access); err != nil {
				t.Fatalf("failed to read owner permission: %v", err)
			}
			if ownerID != test.userID {
				t.Errorf("expected owner_agent_id=%s, got %s", test.userID, ownerID)
			}
			if access != "ADMIN" {
				t.Errorf("expected access=ADMIN, got %s", access)
			}
			if got := handlers.GetEffectiveBoardAccess(db, test.userID, boardID, test.role); got != "ADMIN" {
				t.Errorf("expected effective access ADMIN, got %s", got)
			}
		})
	}
}

func TestCreateBoardFromTemplate_AdminCopy_StillOwner(t *testing.T) {
	gin.SetMode(gin.TestMode)

	db := setupTemplateOwnershipTestDB(t)
	defer db.Close()
	handlers.ResetTokenCacheForTest()
	handlers.ResetPermissionCacheForTest()

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.POST("/api/boards/from-template", handlers.CreateBoardFromTemplate(db))

	body := bytes.NewBufferString(`{"name":"Admin Board From Template","templateId":"template1"}`)
	w := performTemplateRequest(t, router, http.MethodPost, "/api/boards/from-template", "template-admin-token", body.Bytes())
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	boardID := decodeTemplateID(t, w)

	var ownerID, access string
	if err := db.QueryRow(
		`SELECT owner_agent_id, access FROM board_permissions WHERE user_id = 'admin1' AND board_id = ?`,
		boardID,
	).Scan(&ownerID, &access); err != nil {
		t.Fatalf("failed to read admin owner permission: %v", err)
	}
	if ownerID != "admin1" {
		t.Errorf("expected owner_agent_id=admin1, got %s", ownerID)
	}
	if access != "ADMIN" {
		t.Errorf("expected admin access=ADMIN, got %s", access)
	}
}

func TestCreateBoardFromTemplate_Failure_RollsBack(t *testing.T) {
	gin.SetMode(gin.TestMode)

	db := setupTemplateOwnershipTestDB(t)
	defer db.Close()
	handlers.ResetTokenCacheForTest()
	handlers.ResetPermissionCacheForTest()

	if _, err := db.Exec(
		`UPDATE templates SET columns_config = ? WHERE id = 'template1'`,
		`[{"name":"Broken","status":"blocked","position":0,"color":"#ef4444"}]`,
	); err != nil {
		t.Fatalf("failed to make template invalid: %v", err)
	}

	router := gin.New()
	router.Use(handlers.RequireAuth(db))
	router.POST("/api/boards/from-template", handlers.CreateBoardFromTemplate(db))

	body := bytes.NewBufferString(`{"name":"Rolled Back Board","templateId":"template1"}`)
	w := performTemplateRequest(t, router, http.MethodPost, "/api/boards/from-template", "template-member-token", body.Bytes())
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d: %s", w.Code, w.Body.String())
	}
	var boardCount int
	if err := db.QueryRow(
		`SELECT COUNT(*) FROM boards WHERE name = 'Rolled Back Board'`,
	).Scan(&boardCount); err != nil {
		t.Fatalf("failed to count created boards: %v", err)
	}
	if boardCount != 0 {
		t.Errorf("expected no board after rollback, got %d", boardCount)
	}
	var permissionCount int
	if err := db.QueryRow(`SELECT COUNT(*) FROM board_permissions`).Scan(&permissionCount); err != nil {
		t.Fatalf("failed to count board permissions: %v", err)
	}
	if permissionCount != 3 {
		t.Errorf("expected only seeded permissions after rollback, got %d", permissionCount)
	}
}
