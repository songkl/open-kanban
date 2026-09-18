package handlers

import (
	"database/sql"
	"encoding/csv"
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

		filters := parseActivityFilters(c, user)
		if filters.forbidden {
			c.JSON(http.StatusForbidden, gin.H{"error": "Only admin or board owner can view activity scope outside your account"})
			return
		}

		limit, offset := parseActivityPagination(c)

		baseQuery, args := buildActivityListQuery(filters)
		countQuery, countArgs := buildActivityCountQuery(filters)

		var total int
		if len(countArgs) > 0 {
			if err := db.QueryRow(countQuery, countArgs...).Scan(&total); err != nil {
				c.JSON(500, gin.H{"error": "Failed to get activity records"})
				return
			}
		} else {
			if err := db.QueryRow(countQuery).Scan(&total); err != nil {
				c.JSON(500, gin.H{"error": "Failed to get activity records"})
				return
			}
		}

		baseQuery += " ORDER BY a.created_at DESC LIMIT ? OFFSET ?"
		queryArgs := append(append([]interface{}{}, args...), limit, offset)

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

// activityFilters is the parsed, normalized set of ?query= arguments
// accepted by both GetActivities and ExportActivities. Centralizing
// the parsing here keeps the two endpoints returning the exact same
// slice for the same URL.
//
//   - userID is the actor filter. Non-admins are forced to their own
//     user ID so they cannot enumerate other accounts.
//   - action / startTime / endTime / agentOnly mirror the original
//     activity-log filters.
//   - boardID / columnID / taskID are the new scope filters
//     (PM-s1188 §3.8). Each is resolved through SQL subqueries so a
//     filter on `boardID` returns BOARD-target rows on that board plus
//     COLUMN/TASK/COMMENT rows whose target chain walks through that
//     board.
//   - forbidden is set when a non-admin requested a cross-account
//     userId filter; the handler turns that into a 403.
type activityFilters struct {
	userID     string
	action     string
	startTime  string
	endTime    string
	agentOnly  bool
	boardID    string
	columnID   string
	taskID     string
	forbidden  bool
	joinsAgent bool
}

func parseActivityFilters(c *gin.Context, user *models.User) activityFilters {
	f := activityFilters{
		userID:    c.Query("userId"),
		action:    c.Query("action"),
		startTime: c.Query("startTime"),
		endTime:   c.Query("endTime"),
		boardID:   c.Query("boardId"),
		columnID:  c.Query("columnId"),
		taskID:    c.Query("taskId"),
	}
	if c.Query("agentOnly") == "true" {
		f.agentOnly = true
		f.joinsAgent = true
	}
	if !isAdmin(user) {
		if f.userID != "" && f.userID != user.ID {
			f.forbidden = true
			return f
		}
		f.userID = user.ID
	}
	return f
}

func parseActivityPagination(c *gin.Context) (int, int) {
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
	return limit, offset
}

// appendActivityWhere joins every non-empty filter into a single WHERE
// clause + matching args slice. The same fragment is reused by the
// list query, the count query, and the CSV exporter so they can never
// drift apart.
func (f activityFilters) appendActivityWhere() (string, []interface{}) {
	clause := ""
	args := []interface{}{}
	add := func(pred string, val ...interface{}) {
		if clause != "" {
			clause += " AND "
		}
		clause += pred
		args = append(args, val...)
	}

	if f.userID != "" {
		add("a.user_id = ?", f.userID)
	}
	if f.action != "" {
		add("a.action = ?", f.action)
	}
	if f.startTime != "" {
		add("a.created_at >= ?", f.startTime)
	}
	if f.endTime != "" {
		add("a.created_at <= ?", f.endTime)
	}

	if f.taskID != "" {
		// TargetType TASK rows hit directly; COMMENT rows on that
		// task inherit the scope via comments.task_id. The outer
		// parentheses are load-bearing: without them the surrounding
		// AND/OR chain would only apply the action filter to TASK
		// rows because AND binds tighter than OR.
		add(`((a.target_type = 'TASK' AND a.target_id = ?) OR (a.target_type = 'COMMENT' AND a.target_id IN (SELECT id FROM comments WHERE task_id = ?)))`, f.taskID, f.taskID)
	}
	if f.columnID != "" {
		// COLUMN rows direct; TASK rows whose column_id matches;
		// COMMENT rows that resolve through tasks.column_id.
		add(`((a.target_type = 'COLUMN' AND a.target_id = ?)
			OR (a.target_type = 'TASK' AND a.target_id IN (SELECT id FROM tasks WHERE column_id = ?))
			OR (a.target_type = 'COMMENT' AND a.target_id IN (SELECT cm.id FROM comments cm JOIN tasks t ON cm.task_id = t.id WHERE t.column_id = ?)))`, f.columnID, f.columnID, f.columnID)
	}
	if f.boardID != "" {
		// BOARD rows direct; COLUMN rows whose column.board_id matches;
		// TASK rows resolved via tasks → columns.board_id; COMMENT
		// rows resolved via comments → tasks → columns.board_id.
		add(`((a.target_type = 'BOARD' AND a.target_id = ?)
			OR (a.target_type = 'COLUMN' AND a.target_id IN (SELECT id FROM columns WHERE board_id = ?))
			OR (a.target_type = 'TASK' AND a.target_id IN (SELECT t.id FROM tasks t JOIN columns c ON t.column_id = c.id WHERE c.board_id = ?))
			OR (a.target_type = 'COMMENT' AND a.target_id IN (SELECT cm.id FROM comments cm JOIN tasks t ON cm.task_id = t.id JOIN columns c ON t.column_id = c.id WHERE c.board_id = ?)))`, f.boardID, f.boardID, f.boardID, f.boardID)
	}

	return clause, args
}

// buildActivityListQuery produces the SELECT used by GetActivities and
// ExportActivities. Both endpoints must run the same row scan so the
// exported CSV is byte-for-byte identical to the on-screen slice.
func buildActivityListQuery(f activityFilters) (string, []interface{}) {
	q := "SELECT a.id, a.user_id, a.action, a.target_type, a.target_id, a.target_title, a.details, a.ip_address, a.source, a.created_at FROM activities a"
	if f.joinsAgent {
		q += " JOIN users u ON a.user_id = u.id AND u.type = 'AGENT'"
	}
	where, args := f.appendActivityWhere()
	if where != "" {
		q += " WHERE " + where
	}
	return q, args
}

func buildActivityCountQuery(f activityFilters) (string, []interface{}) {
	q := "SELECT COUNT(*) FROM activities a"
	if f.joinsAgent {
		q += " JOIN users u ON a.user_id = u.id AND u.type = 'AGENT'"
	}
	where, args := f.appendActivityWhere()
	if where != "" {
		q += " WHERE " + where
	}
	return q, args
}

// ExportActivities streams the same activity slice returned by
// GetActivities as a CSV download. Server-side streaming keeps memory
// flat for large exports — rows are written to the gin.ResponseWriter
// directly through encoding/csv rather than buffered into a slice.
//
// The endpoint honours every filter accepted by GetActivities (scope
// + actor + type + time) so a CSV export reflects exactly what the
// caller sees on screen. The header row is stable; clients can diff
// exports across runs without spurious schema churn.
func ExportActivities(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		filters := parseActivityFilters(c, user)
		if filters.forbidden {
			c.JSON(http.StatusForbidden, gin.H{"error": "Only admin or board owner can export activity scope outside your account"})
			return
		}

		format := strings.ToLower(c.DefaultQuery("format", "csv"))
		if format != "csv" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Unsupported export format, only csv is supported"})
			return
		}

		query, args := buildActivityListQuery(filters)
		query += " ORDER BY a.created_at DESC"
		// Cap each individual scan; if the dataset is larger the
		// client can use the existing pagination parameters, but
		// exports are intentionally unbounded to back the
		// "download the whole slice" DoD.
		rows, err := db.Query(query, args...)
		if err != nil {
			slog.Error("ExportActivities: query failed", "error", err, "userID", user.ID)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to export activity records"})
			return
		}
		defer rows.Close()

		filename := fmt.Sprintf("activity_log_%s.csv", time.Now().UTC().Format("20060102_150405"))
		c.Header("Content-Description", "File Transfer")
		c.Header("Content-Disposition", "attachment; filename="+filename)
		c.Header("Content-Type", "text/csv; charset=utf-8")
		c.Status(http.StatusOK)

		writer := csv.NewWriter(c.Writer)
		if err := writer.Write([]string{
			"id", "userId", "action", "targetType", "targetId",
			"targetTitle", "details", "ipAddress", "source", "createdAt",
		}); err != nil {
			slog.Error("ExportActivities: failed to write header", "error", err)
			return
		}

		for rows.Next() {
			var a Activity
			if err := rows.Scan(&a.ID, &a.UserID, &a.Action, &a.TargetType, &a.TargetID, &a.TargetTitle, &a.Details, &a.IPAddress, &a.Source, &a.CreatedAt); err != nil {
				slog.Error("ExportActivities: row scan failed", "error", err)
				continue
			}
			row := []string{
				a.ID,
				a.UserID,
				a.Action,
				a.TargetType,
				a.TargetID,
				a.TargetTitle,
				a.Details,
				a.IPAddress,
				a.Source,
				a.CreatedAt.UTC().Format(time.RFC3339),
			}
			if err := writer.Write(row); err != nil {
				slog.Error("ExportActivities: row write failed", "error", err)
				return
			}
		}
		if err := rows.Err(); err != nil {
			slog.Error("ExportActivities: rows iteration", "error", err)
		}
		writer.Flush()
		if err := writer.Error(); err != nil {
			slog.Error("ExportActivities: flush", "error", err)
		}
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
