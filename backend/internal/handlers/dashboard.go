package handlers

import (
	"database/sql"
	"net/http"

	"github.com/gin-gonic/gin"
)

type DashboardAgentActivity struct {
	UserID      string `json:"userId"`
	Nickname    string `json:"nickname"`
	Avatar      string `json:"avatar"`
	ActivityCnt int    `json:"activityCount"`
}

type DashboardBlockedTask struct {
	TaskID      string `json:"taskId"`
	Title       string `json:"title"`
	BoardID     string `json:"boardId"`
	BoardName   string `json:"boardName"`
	ColumnID    string `json:"columnId"`
	ColumnName  string `json:"columnName"`
	UpdatedAt   string `json:"updatedAt"`
	DaysBlocked int    `json:"daysBlocked"`
	Assignee    string `json:"assignee"`
	Priority    string `json:"priority"`
}

type DashboardStats struct {
	TotalTasks            int                      `json:"totalTasks"`
	TasksByStatus         map[string]int           `json:"tasksByStatus"`
	TasksByPriority       map[string]int           `json:"tasksByPriority"`
	PublishedTasks        int                      `json:"publishedTasks"`
	DraftTasks            int                      `json:"draftTasks"`
	ArchivedTasks         int                      `json:"archivedTasks"`
	TotalBoards           int                      `json:"totalBoards"`
	ActiveBoardCount      int                      `json:"activeBoardCount"`
	TotalColumns          int                      `json:"totalColumns"`
	TotalUsers            int                      `json:"totalUsers"`
	TasksCompletedLast7d  int                      `json:"tasksCompletedLast7Days"`
	TopAgentsByActivity   []DashboardAgentActivity `json:"topAgentsByActivity"`
	LongestBlockedCards   []DashboardBlockedTask   `json:"longestBlockedCards"`
}

func GetDashboardStats(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		stats := DashboardStats{
			TasksByStatus:       make(map[string]int),
			TasksByPriority:     make(map[string]int),
			TopAgentsByActivity: []DashboardAgentActivity{},
			LongestBlockedCards: []DashboardBlockedTask{},
		}

		rows, err := db.Query(`
			SELECT
				col.status,
				SUM(CASE WHEN t.priority = 'high' AND t.archived = 0 THEN 1 ELSE 0 END) as high_priority,
				SUM(CASE WHEN t.priority = 'medium' AND t.archived = 0 THEN 1 ELSE 0 END) as medium_priority,
				SUM(CASE WHEN t.priority = 'low' AND t.archived = 0 THEN 1 ELSE 0 END) as low_priority,
				SUM(CASE WHEN t.published = 1 AND t.archived = 0 THEN 1 ELSE 0 END) as published,
				SUM(CASE WHEN t.published = 0 AND t.archived = 0 THEN 1 ELSE 0 END) as draft,
				SUM(CASE WHEN t.archived = 1 THEN 1 ELSE 0 END) as archived
			FROM tasks t
			JOIN columns col ON t.column_id = col.id
			GROUP BY col.status
		`)
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var status string
				var high, medium, low, published, draft, archived int
				if rows.Scan(&status, &high, &medium, &low, &published, &draft, &archived) == nil {
					stats.TasksByStatus[status] = high + medium + low
					stats.TasksByPriority["high"] += high
					stats.TasksByPriority["medium"] += medium
					stats.TasksByPriority["low"] += low
					stats.PublishedTasks += published
					stats.DraftTasks += draft
					stats.ArchivedTasks += archived
				}
			}
		}

		stats.TotalTasks = stats.PublishedTasks + stats.DraftTasks

		db.QueryRow(`
			SELECT
				(SELECT COUNT(*) FROM boards WHERE deleted = 0) as total_boards,
				(SELECT COUNT(*) FROM columns) as total_columns,
				(SELECT COUNT(*) FROM users) as total_users
		`).Scan(&stats.TotalBoards, &stats.TotalColumns, &stats.TotalUsers)
		stats.ActiveBoardCount = stats.TotalBoards

		db.QueryRow(`
			SELECT COUNT(*) FROM activities
			WHERE action = 'COMPLETE_TASK'
			  AND created_at >= datetime('now', '-7 days')
		`).Scan(&stats.TasksCompletedLast7d)

		agentRows, err := db.Query(`
			SELECT u.id, u.nickname, COALESCE(u.avatar, ''), COUNT(a.id) as activity_count
			FROM activities a
			JOIN users u ON u.id = a.user_id
			WHERE u.type = 'AGENT'
			  AND a.created_at >= datetime('now', '-7 days')
			GROUP BY u.id, u.nickname, u.avatar
			ORDER BY activity_count DESC, u.nickname ASC
			LIMIT 3
		`)
		if err == nil {
			defer agentRows.Close()
			for agentRows.Next() {
				var a DashboardAgentActivity
				if agentRows.Scan(&a.UserID, &a.Nickname, &a.Avatar, &a.ActivityCnt) == nil {
					stats.TopAgentsByActivity = append(stats.TopAgentsByActivity, a)
				}
			}
		}

		blockedRows, err := db.Query(`
			SELECT
				t.id,
				t.title,
				b.id,
				b.name,
				col.id,
				col.name,
				t.updated_at,
				CAST((julianday('now') - julianday(t.updated_at)) AS INTEGER) as days_blocked,
				COALESCE(t.assignee, ''),
				COALESCE(t.priority, '')
			FROM tasks t
			JOIN columns col ON col.id = t.column_id
			JOIN boards b ON b.id = col.board_id
			WHERE t.archived = 0
			  AND t.published = 1
			  AND (col.status IS NULL OR col.status != 'done')
			ORDER BY t.updated_at ASC
			LIMIT 3
		`)
		if err == nil {
			defer blockedRows.Close()
			for blockedRows.Next() {
				var t DashboardBlockedTask
				var updatedAt sql.NullString
				if blockedRows.Scan(&t.TaskID, &t.Title, &t.BoardID, &t.BoardName,
					&t.ColumnID, &t.ColumnName, &updatedAt, &t.DaysBlocked, &t.Assignee, &t.Priority) == nil {
					if updatedAt.Valid {
						t.UpdatedAt = updatedAt.String
					}
					stats.LongestBlockedCards = append(stats.LongestBlockedCards, t)
				}
			}
		}

		c.JSON(http.StatusOK, stats)
	}
}
