package handlers

import (
	"database/sql"
	"log/slog"
	"strconv"
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
	_, err = db.Exec("UPDATE users SET last_active_at = datetime('now') WHERE id = ?", userID)
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

		if user.Role != "ADMIN" {
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
