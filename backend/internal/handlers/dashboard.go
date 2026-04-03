package handlers

import (
	"database/sql"
	"net/http"

	"github.com/gin-gonic/gin"
)

type DashboardStats struct {
	TotalTasks      int            `json:"totalTasks"`
	TasksByStatus   map[string]int `json:"tasksByStatus"`
	TasksByPriority map[string]int `json:"tasksByPriority"`
	PublishedTasks  int            `json:"publishedTasks"`
	DraftTasks      int            `json:"draftTasks"`
	ArchivedTasks   int            `json:"archivedTasks"`
	TotalBoards     int            `json:"totalBoards"`
	TotalColumns    int            `json:"totalColumns"`
	TotalUsers      int            `json:"totalUsers"`
}

func GetDashboardStats(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "未登录"})
			return
		}

		stats := DashboardStats{
			TasksByStatus:   make(map[string]int),
			TasksByPriority: make(map[string]int),
		}

		db.QueryRow("SELECT COUNT(*) FROM tasks WHERE archived = false").Scan(&stats.TotalTasks)

		rows, err := db.Query(`
			SELECT col.status, COUNT(*) as cnt FROM tasks t
			JOIN columns col ON t.column_id = col.id
			WHERE t.archived = false
			GROUP BY col.status
		`)
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var status string
				var count int
				if rows.Scan(&status, &count) == nil {
					stats.TasksByStatus[status] = count
				}
			}
		}

		rows, err = db.Query(`
			SELECT priority, COUNT(*) as cnt FROM tasks
			WHERE archived = false
			GROUP BY priority
		`)
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var priority string
				var count int
				if rows.Scan(&priority, &count) == nil {
					stats.TasksByPriority[priority] = count
				}
			}
		}

		db.QueryRow("SELECT COUNT(*) FROM tasks WHERE published = true AND archived = false").Scan(&stats.PublishedTasks)
		db.QueryRow("SELECT COUNT(*) FROM tasks WHERE published = false AND archived = false").Scan(&stats.DraftTasks)
		db.QueryRow("SELECT COUNT(*) FROM tasks WHERE archived = true").Scan(&stats.ArchivedTasks)

		db.QueryRow("SELECT COUNT(*) FROM boards WHERE deleted = false").Scan(&stats.TotalBoards)
		db.QueryRow("SELECT COUNT(*) FROM columns").Scan(&stats.TotalColumns)
		db.QueryRow("SELECT COUNT(*) FROM users").Scan(&stats.TotalUsers)

		c.JSON(http.StatusOK, stats)
	}
}
