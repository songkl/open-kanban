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

		c.JSON(http.StatusOK, stats)
	}
}
