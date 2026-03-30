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

		var todoCount, inProgressCount, reviewCount, doneCount int
		db.QueryRow(`
			SELECT COUNT(*) FROM tasks t
			JOIN columns col ON t.column_id = col.id
			WHERE col.status = 'todo' AND t.archived = false
		`).Scan(&todoCount)
		stats.TasksByStatus["todo"] = todoCount

		db.QueryRow(`
			SELECT COUNT(*) FROM tasks t
			JOIN columns col ON t.column_id = col.id
			WHERE col.status = 'in_progress' AND t.archived = false
		`).Scan(&inProgressCount)
		stats.TasksByStatus["in_progress"] = inProgressCount

		db.QueryRow(`
			SELECT COUNT(*) FROM tasks t
			JOIN columns col ON t.column_id = col.id
			WHERE col.status = 'review' AND t.archived = false
		`).Scan(&reviewCount)
		stats.TasksByStatus["review"] = reviewCount

		db.QueryRow(`
			SELECT COUNT(*) FROM tasks t
			JOIN columns col ON t.column_id = col.id
			WHERE col.status = 'done' AND t.archived = false
		`).Scan(&doneCount)
		stats.TasksByStatus["done"] = doneCount

		var lowCount, mediumCount, highCount int
		db.QueryRow("SELECT COUNT(*) FROM tasks WHERE priority = 'low' AND archived = false").Scan(&lowCount)
		stats.TasksByPriority["low"] = lowCount
		db.QueryRow("SELECT COUNT(*) FROM tasks WHERE priority = 'medium' AND archived = false").Scan(&mediumCount)
		stats.TasksByPriority["medium"] = mediumCount
		db.QueryRow("SELECT COUNT(*) FROM tasks WHERE priority = 'high' AND archived = false").Scan(&highCount)
		stats.TasksByPriority["high"] = highCount

		db.QueryRow("SELECT COUNT(*) FROM tasks WHERE published = true AND archived = false").Scan(&stats.PublishedTasks)
		db.QueryRow("SELECT COUNT(*) FROM tasks WHERE published = false AND archived = false").Scan(&stats.DraftTasks)
		db.QueryRow("SELECT COUNT(*) FROM tasks WHERE archived = true").Scan(&stats.ArchivedTasks)

		db.QueryRow("SELECT COUNT(*) FROM boards WHERE deleted = false").Scan(&stats.TotalBoards)
		db.QueryRow("SELECT COUNT(*) FROM columns").Scan(&stats.TotalColumns)
		db.QueryRow("SELECT COUNT(*) FROM users").Scan(&stats.TotalUsers)

		c.JSON(http.StatusOK, stats)
	}
}
