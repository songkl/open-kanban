package handlers

import (
	"database/sql"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"open-kanban/internal/models"
)

type Activity struct {
	ID          string    `json:"id"`
	UserID      string    `json:"userId"`
	Action      string    `json:"action"`
	TargetType  string    `json:"targetType"`
	TargetID    string    `json:"targetId,omitempty"`
	TargetTitle string    `json:"targetTitle,omitempty"`
	Details     string    `json:"details,omitempty"`
	IPAddress   string    `json:"ipAddress,omitempty"`
	Source      string    `json:"source"`
	CreatedAt   time.Time `json:"createdAt"`
}

func LogActivity(db *sql.DB, userID, action, targetType, targetID, targetTitle, details, ipAddress, source string) {
	if userID == "" {
		slog.Error("LogActivity called with empty userID", "action", action, "targetType", targetType, "targetID", targetID)
		return
	}
	id := generateID()
	createdAt := time.Now()
	_, err := db.Exec(
		"INSERT INTO activities (id, user_id, action, target_type, target_id, target_title, details, ip_address, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		id, userID, action, targetType, targetID, targetTitle, details, ipAddress, source, createdAt,
	)
	if err != nil {
		slog.Error("Failed to insert activity", "error", err, "userID", userID, "action", action, "targetType", targetType, "targetID", targetID)
	}
	_, err = db.Exec("UPDATE users SET last_active_at = CURRENT_TIMESTAMP WHERE id = ?", userID)
	if err != nil {
		slog.Error("Failed to update user last_active_at", "error", err, "userID", userID)
	}
	go BroadcastActivityExternal(sanitizeActivity(Activity{
		ID:          id,
		UserID:      userID,
		Action:      action,
		TargetType:  targetType,
		TargetID:    targetID,
		TargetTitle: targetTitle,
		Details:     details,
		IPAddress:   ipAddress,
		Source:      source,
		CreatedAt:   createdAt,
	}).(Activity))

	if targetType == "TASK" {
		boardID, err := getBoardIDForTask(db, targetID)
		if err == nil && boardID != "" {
			notifyAction := action
			if action == "CREATE_TASK" {
				notifyAction = "create"
			} else if action == "UPDATE_TASK" {
				notifyAction = "update"
			} else if action == "COMPLETE_TASK" {
				notifyAction = "update_status"
			} else if action == "ADD_COMMENT" {
				notifyAction = "new_comment"
			}
			go BroadcastTaskNotificationExternal(boardID, targetID, notifyAction)
		}
	}
}

func BroadcastActivityExternal(activity Activity) {
	BroadcastActivity(activity)
}

func BroadcastTaskNotificationExternal(boardID, taskID, action string) {
	BroadcastTaskNotification(boardID, taskID, action)
}

func getRequestSource(c *gin.Context) string {
	if user, exists := c.Get("user"); exists {
		if u, ok := user.(*models.User); ok && u.Type == "AGENT" {
			return "mcp"
		}
	}
	if c.GetHeader("X-MCP-Request") == "true" {
		return "mcp"
	}
	return "web"
}

func GetActivities(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(401, gin.H{"error": "Not logged in"})
			return
		}

		filterUserID := c.Query("userId")
		filterAction := c.Query("action")
		filterStartTime := c.Query("startTime")
		filterEndTime := c.Query("endTime")
		filterAgentOnly := c.Query("agentOnly")

		baseQuery := "SELECT a.id, a.user_id, a.action, a.target_type, a.target_id, a.target_title, a.details, a.ip_address, a.source, a.created_at FROM activities a"
		whereClause := ""
		args := []interface{}{}

		if filterAgentOnly == "true" {
			baseQuery += " JOIN users u ON a.user_id = u.id AND u.type = 'AGENT'"
		}

		if !isAdmin(user) {
			filterUserID = user.ID
		}

		if filterUserID != "" {
			if whereClause != "" {
				whereClause += " AND "
			}
			whereClause += "a.user_id = ?"
			args = append(args, filterUserID)
		}

		if filterAction != "" {
			if whereClause != "" {
				whereClause += " AND "
			}
			whereClause += "a.action = ?"
			args = append(args, filterAction)
		}

		if filterStartTime != "" {
			if whereClause != "" {
				whereClause += " AND "
			}
			whereClause += "a.created_at >= ?"
			args = append(args, filterStartTime)
		}

		if filterEndTime != "" {
			if whereClause != "" {
				whereClause += " AND "
			}
			whereClause += "a.created_at <= ?"
			args = append(args, filterEndTime)
		}

		if whereClause != "" {
			baseQuery += " WHERE " + whereClause
		}

		limit := 50
		offset := 0
		if l := c.Query("limit"); l != "" {
			if parsed, err := strconv.Atoi(l); err == nil && parsed > 0 && parsed <= 100 {
				limit = parsed
			}
		}
		if o := c.Query("offset"); o != "" {
			if parsed, err := strconv.Atoi(o); err == nil && parsed >= 0 {
				offset = parsed
			}
		}

		countQuery := "SELECT COUNT(*) FROM activities a"
		if filterAgentOnly == "true" {
			countQuery += " JOIN users u ON a.user_id = u.id AND u.type = 'AGENT'"
		}
		if whereClause != "" {
			countQuery += " WHERE " + whereClause
		}
		var total int
		if len(args) > 0 {
			db.QueryRow(countQuery, args...).Scan(&total)
		} else {
			db.QueryRow(countQuery).Scan(&total)
		}

		baseQuery += " ORDER BY a.created_at DESC LIMIT ? OFFSET ?"
		queryArgs := append(args, limit, offset)

		var rows *sql.Rows
		var err error

		if len(queryArgs) > 0 {
			rows, err = db.Query(baseQuery, queryArgs...)
		} else {
			rows, err = db.Query(baseQuery)
		}

		if err != nil {
			c.JSON(500, gin.H{"error": "Failed to get activity records"})
			return
		}
		defer rows.Close()

		var activities []Activity
		for rows.Next() {
			var a Activity
			if err := rows.Scan(&a.ID, &a.UserID, &a.Action, &a.TargetType, &a.TargetID, &a.TargetTitle, &a.Details, &a.IPAddress, &a.Source, &a.CreatedAt); err == nil {
				activities = append(activities, a)
			}
		}

		hasMore := offset+len(activities) < total
		c.JSON(200, gin.H{"activities": activities, "hasMore": hasMore, "total": total})
	}
}

// permissionAuditActions is the set of action names accepted by
// the ?actions= query parameter on GET /api/v1/activities. Anything
// outside this set is rejected with 400 so the client cannot
// silently get an empty result for typos.
var permissionAuditActions = map[string]bool{
	"PERMISSION_GRANT":      true,
	"PERMISSION_REVOKE":     true,
	"PERMISSION_TRANSFER":   true,
	"PERMISSION_BULK_GRANT": true,
}

// defaultPermissionAuditActions is what GET /api/v1/activities
// returns when ?actions= is not supplied. Mirrors the three actions
// the audit endpoint was originally built around.
var defaultPermissionAuditActions = []string{
	"PERMISSION_GRANT",
	"PERMISSION_REVOKE",
	"PERMISSION_TRANSFER",
}

// GetPermissionActivities is the audit-log endpoint exposed at
// GET /api/v1/activities. It surfaces PERMISSION_GRANT / REVOKE /
// TRANSFER rows (and optionally PERMISSION_BULK_GRANT) so global
// ADMINs and board owners can audit who changed access on which
// boards.
//
// Authorization is two-tier:
//
//   - Global ADMINs see every row that matches the filter.
//   - Everyone else must own at least one board; rows whose resolved
//     board they don't own are filtered out by SQL. A caller with no
//     owned boards gets a 403.
//
// The resourceId → boardId resolution happens in SQL via a CASE
// expression: BOARD.target_id is already the boardId; COLUMN.target_id
// resolves through columns.board_id; TASK/COMMENT rows walk through
// tasks → columns; USER/SYSTEM/TEMPLATE rows have no board and are
// only visible to global admins.
func GetPermissionActivities(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		var actions []string
		if raw := c.Query("actions"); raw != "" {
			for _, part := range strings.Split(raw, ",") {
				part = strings.TrimSpace(part)
				if part == "" {
					continue
				}
				if !permissionAuditActions[part] {
					c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("Unsupported action %q", part)})
					return
				}
				actions = append(actions, part)
			}
		}
		if len(actions) == 0 {
			actions = defaultPermissionAuditActions
		}

		limit := 50
		offset := 0
		if l := c.Query("limit"); l != "" {
			if parsed, err := strconv.Atoi(l); err == nil && parsed > 0 && parsed <= 100 {
				limit = parsed
			}
		}
		if o := c.Query("offset"); o != "" {
			if parsed, err := strconv.Atoi(o); err == nil && parsed >= 0 {
				offset = parsed
			}
		}

		var ownedBoards []string
		if !isAdmin(user) {
			var err error
			ownedBoards, err = loadOwnedBoardIDs(db, user.ID)
			if err != nil {
				slog.Error("GetPermissionActivities: failed to load owned boards", "error", err, "userID", user.ID)
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to query activity records"})
				return
			}
			if len(ownedBoards) == 0 {
				c.JSON(http.StatusForbidden, gin.H{"error": "Only admin or board owner can query permission activities"})
				return
			}
		}

		actionPlaceholders := strings.TrimSuffix(strings.Repeat("?,", len(actions)), ",")
		var ownedPlaceholders string
		var filterArgs []interface{}
		for _, a := range actions {
			filterArgs = append(filterArgs, a)
		}
		if len(ownedBoards) > 0 {
			ownedPlaceholders = strings.TrimSuffix(strings.Repeat("?,", len(ownedBoards)), ",")
			for _, b := range ownedBoards {
				filterArgs = append(filterArgs, b)
			}
		}

		resolvedBoardExpr := `CASE
            WHEN a.target_type = 'BOARD'   THEN a.target_id
            WHEN a.target_type = 'COLUMN'  THEN (SELECT board_id FROM columns WHERE id = a.target_id)
            WHEN a.target_type = 'TASK'    THEN (SELECT c.board_id FROM tasks t JOIN columns c ON t.column_id = c.id WHERE t.id = a.target_id)
            WHEN a.target_type = 'COMMENT' THEN (SELECT c.board_id FROM comments cm JOIN tasks t ON cm.task_id = t.id JOIN columns c ON t.column_id = c.id WHERE cm.id = a.target_id)
            ELSE NULL
        END`

		selectQuery := fmt.Sprintf(`
            SELECT a.id, a.user_id, a.action, a.target_type, a.target_id,
                   a.target_title, a.details, a.ip_address, a.source, a.created_at
            FROM activities a
            WHERE a.action IN (%s)
        `, actionPlaceholders)
		if ownedPlaceholders != "" {
			selectQuery += fmt.Sprintf(` AND (%s) IN (%s)`, resolvedBoardExpr, ownedPlaceholders)
		}
		selectQuery += ` ORDER BY a.created_at DESC LIMIT ? OFFSET ?`
		queryArgs := append([]interface{}{}, filterArgs...)
		queryArgs = append(queryArgs, limit, offset)

		rows, err := db.Query(selectQuery, queryArgs...)
		if err != nil {
			slog.Error("GetPermissionActivities: query failed", "error", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to query activity records"})
			return
		}
		defer rows.Close()

		var activities []Activity
		for rows.Next() {
			var a Activity
			if err := rows.Scan(&a.ID, &a.UserID, &a.Action, &a.TargetType, &a.TargetID,
				&a.TargetTitle, &a.Details, &a.IPAddress, &a.Source, &a.CreatedAt); err == nil {
				activities = append(activities, a)
			}
		}
		if err := rows.Err(); err != nil {
			slog.Error("GetPermissionActivities: rows iteration", "error", err)
		}

		countQuery := fmt.Sprintf(`
            SELECT COUNT(*) FROM activities a
            WHERE a.action IN (%s)
        `, actionPlaceholders)
		if ownedPlaceholders != "" {
			countQuery += fmt.Sprintf(` AND (%s) IN (%s)`, resolvedBoardExpr, ownedPlaceholders)
		}
		var total int
		if err := db.QueryRow(countQuery, filterArgs...).Scan(&total); err != nil {
			slog.Error("GetPermissionActivities: count query failed", "error", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to query activity records"})
			return
		}

		hasMore := offset+len(activities) < total
		c.JSON(http.StatusOK, gin.H{"activities": activities, "hasMore": hasMore, "total": total})
	}
}

// loadOwnedBoardIDs returns the set of board IDs the given user is
// the recorded owner of. Used by GetPermissionActivities to scope
// non-admin queries to the caller's owned boards. The check mirrors
// IsBoardOwner: owner_agent_id on the user's own board_permissions
// row must equal user_id.
func loadOwnedBoardIDs(db *sql.DB, userID string) ([]string, error) {
	if userID == "" {
		return nil, nil
	}
	rows, err := db.Query(
		"SELECT board_id FROM board_permissions WHERE user_id = ? AND owner_agent_id = ?",
		userID, userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var boards []string
	for rows.Next() {
		var b string
		if err := rows.Scan(&b); err == nil {
			boards = append(boards, b)
		}
	}
	return boards, rows.Err()
}
