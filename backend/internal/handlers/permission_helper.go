package handlers

import (
	"database/sql"

	"open-kanban/internal/models"
)

func isAdmin(user *models.User) bool {
	return user != nil && user.Role == "ADMIN"
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
