package handlers

import (
	"database/sql"
	"net/http"

	"open-kanban/internal/models"

	"github.com/gin-gonic/gin"
)

func isAdmin(user *models.User) bool {
	return user != nil && user.Role == "ADMIN"
}

// IsLastAdmin reports whether targetUserID is the last enabled
// ADMIN user in the system. Returns true when removing targetUserID
// from the enabled ADMIN set would leave zero admins. This is used to
// guard against demoting, disabling or deleting the last admin so the
// system never becomes unmanageable.
func IsLastAdmin(db *sql.DB, targetUserID string) (bool, error) {
	var count int
	err := db.QueryRow(
		"SELECT COUNT(*) FROM users WHERE role = 'ADMIN' AND enabled = 1 AND id != ?",
		targetUserID,
	).Scan(&count)
	if err != nil {
		return false, err
	}
	return count == 0, nil
}

func checkBoardAccess(db *sql.DB, userID, boardID, requiredAccess string, userRole string) bool {
	if userRole == "ADMIN" {
		return true
	}
	if userID == "" || boardID == "" {
		return false
	}
	var access string
	err := db.QueryRow(
		"SELECT access FROM board_permissions WHERE user_id = ? AND board_id = ?",
		userID, boardID,
	).Scan(&access)
	if err != nil {
		return false
	}
	accessLevel := map[string]int{"READ": 1, "WRITE": 2, "ADMIN": 3}
	requiredLevel := accessLevel[requiredAccess]
	userLevel := accessLevel[access]
	if userLevel >= requiredLevel {
		return true
	}
	return false
}

func checkColumnAccess(db *sql.DB, userID, columnID, requiredAccess string, userRole string) bool {
	if userRole == "ADMIN" {
		return true
	}
	if userID == "" || columnID == "" {
		return false
	}
	var access string
	err := db.QueryRow(
		"SELECT access FROM column_permissions WHERE user_id = ? AND column_id = ?",
		userID, columnID,
	).Scan(&access)
	if err != nil {
		return false
	}
	accessLevel := map[string]int{"READ": 1, "WRITE": 2, "ADMIN": 3}
	requiredLevel := accessLevel[requiredAccess]
	userLevel := accessLevel[access]
	return userLevel >= requiredLevel
}

func checkColumnAccessWithBoardFallback(db *sql.DB, userID, columnID, requiredAccess string, userRole string) bool {
	if checkColumnAccess(db, userID, columnID, requiredAccess, userRole) {
		return true
	}
	boardID, err := getBoardIDForColumn(db, columnID)
	if err != nil {
		return false
	}
	return checkBoardAccess(db, userID, boardID, requiredAccess, userRole)
}

func getBoardIDForTask(db *sql.DB, taskID string) (string, error) {
	var boardID string
	err := db.QueryRow(`
		SELECT c.board_id 
		FROM tasks t 
		JOIN columns c ON t.column_id = c.id 
		WHERE t.id = ?
	`, taskID).Scan(&boardID)
	return boardID, err
}

func getBoardIDForColumn(db *sql.DB, columnID string) (string, error) {
	var boardID string
	err := db.QueryRow(
		"SELECT board_id FROM columns WHERE id = ?",
		columnID,
	).Scan(&boardID)
	return boardID, err
}

func requireNonViewer(c *gin.Context, user *models.User) bool {
	if user == nil || user.Role == "VIEWER" {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "Viewer role cannot perform this action"})
		return true
	}
	return false
}

func canModifyTask(db *sql.DB, user *models.User, taskID string) (bool, error) {
	if user == nil {
		return false, nil
	}
	switch user.Role {
	case "ADMIN":
		return true, nil
	case "VIEWER":
		return false, nil
	}
	var createdBy sql.NullString
	err := db.QueryRow("SELECT created_by FROM tasks WHERE id = ?", taskID).Scan(&createdBy)
	if err != nil {
		return false, err
	}
	return createdBy.Valid && createdBy.String == user.ID, nil
}
