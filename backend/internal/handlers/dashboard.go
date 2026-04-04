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
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		stats := DashboardStats{
			TasksByStatus:   make(map[string]int),
			TasksByPriority: make(map[string]int),
		}

		rows, err := db.Query(`
			SELECT 
				col.status,
				SUM(CASE WHEN t.published = 1 AND t.archived = 0 THEN 1 ELSE 0 END) as published,
				SUM(CASE WHEN t.published = 0 AND t.archived = 0 THEN 1 ELSE 0 END) as draft
			FROM tasks t
			JOIN columns col ON t.column_id = col.id
			WHERE t.archived = 0
			GROUP BY col.status
		`)
		if err == nil {
			defer rows.Close()
			totalTasks := 0
			for rows.Next() {
				var status string
				var published, draft int
				if rows.Scan(&status, &published, &draft) == nil {
					stats.TasksByStatus[status] = published + draft
					stats.PublishedTasks += published
					stats.DraftTasks += draft
					totalTasks += published + draft
				}
			}
			stats.TotalTasks = totalTasks
		}

		db.QueryRow(`
			SELECT 
				SUM(CASE WHEN archived = 1 THEN 1 ELSE 0 END) as archived
			FROM tasks
		`).Scan(&stats.ArchivedTasks)

		rows, err = db.Query(`
			SELECT priority, COUNT(*) as cnt FROM tasks
			WHERE archived = 0
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

		db.QueryRow("SELECT COUNT(*) FROM boards WHERE deleted = 0").Scan(&stats.TotalBoards)
		db.QueryRow("SELECT COUNT(*) FROM columns").Scan(&stats.TotalColumns)
		db.QueryRow("SELECT COUNT(*) FROM users").Scan(&stats.TotalUsers)

		c.JSON(http.StatusOK, stats)
	}
}
