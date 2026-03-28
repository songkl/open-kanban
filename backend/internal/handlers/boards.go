package handlers

import (
	"database/sql"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

// Default columns configuration
var defaultColumns = []struct {
	Name     string
	Position int
	Color    string
	Status   string
}{
	{Name: "待办", Position: 0, Color: "#ef4444", Status: "todo"},
	{Name: "进行中", Position: 1, Color: "#f59e0b", Status: "in_progress"},
	{Name: "待测试", Position: 2, Color: "#8b5cf6", Status: "testing"},
	{Name: "待审核", Position: 3, Color: "#3b82f6", Status: "review"},
	{Name: "已完成", Position: 4, Color: "#22c55e", Status: "done"},
}

// GetBoards returns all boards
func GetBoards(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		rows, err := db.Query(`
			SELECT id, name, deleted, created_at, updated_at,
				(SELECT COUNT(*) FROM columns WHERE board_id = b.id) as column_count
			FROM boards b
			WHERE deleted = false
			ORDER BY created_at ASC
		`)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "获取看板失败"})
			return
		}
		defer rows.Close()

		var boards []gin.H
		for rows.Next() {
			var id, name string
			var deleted bool
			var createdAt, updatedAt time.Time
			var columnCount int
			if err := rows.Scan(&id, &name, &deleted, &createdAt, &updatedAt, &columnCount); err == nil {
				boards = append(boards, gin.H{
					"id":        id,
					"name":      name,
					"deleted":   deleted,
					"createdAt": createdAt,
					"updatedAt": updatedAt,
					"_count": gin.H{
						"columns": columnCount,
					},
				})
			}
		}

		c.JSON(http.StatusOK, boards)
	}
}

// CreateBoardRequest represents board creation request
type CreateBoardRequest struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// CreateBoard creates a new board with default columns
func CreateBoard(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req CreateBoardRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "看板名称不能为空"})
			return
		}

		boardID := req.ID
		if boardID == "" {
			boardID = generateID()
		}

		tx, err := db.Begin()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "创建看板失败"})
			return
		}
		defer tx.Rollback()

		// Create board
		now := time.Now()
		_, err = tx.Exec(
			"INSERT INTO boards (id, name, deleted, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
			boardID, req.Name, false, now, now,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "创建看板失败"})
			return
		}

		// Create default columns
		for _, col := range defaultColumns {
			colID := generateID()
			_, err = tx.Exec(
				"INSERT INTO columns (id, name, status, position, color, board_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				colID, col.Name, col.Status, col.Position, col.Color, boardID, now, now,
			)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "创建列失败"})
				return
			}
		}

		if err := tx.Commit(); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "创建看板失败"})
			return
		}

		// Get created board with columns
		var board gin.H
		board = gin.H{
			"id":        boardID,
			"name":      req.Name,
			"deleted":   false,
			"createdAt": now,
			"updatedAt": now,
		}

		c.JSON(http.StatusOK, board)
	}
}

// UpdateBoardRequest represents board update request
type UpdateBoardRequest struct {
	Name string `json:"name"`
}

// UpdateBoard updates a board
func UpdateBoard(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id := c.Param("id")
		if id == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "看板 ID 不能为空"})
			return
		}

		var req UpdateBoardRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "参数错误"})
			return
		}

		now := time.Now()
		_, err := db.Exec(
			"UPDATE boards SET name = ?, updated_at = ? WHERE id = ?",
			req.Name, now, id,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "更新失败"})
			return
		}

		// Get updated board
		var board gin.H
		err = db.QueryRow(
			"SELECT id, name, deleted, created_at, updated_at FROM boards WHERE id = ?",
			id,
		).Scan(&board, &board, &board, &board, &board)

		c.JSON(http.StatusOK, gin.H{
			"id":        id,
			"name":      req.Name,
			"updatedAt": now,
		})
	}
}

// DeleteBoard soft deletes a board
func DeleteBoard(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id := c.Param("id")
		if id == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "看板 ID 不能为空"})
			return
		}

		now := time.Now()
		_, err := db.Exec(
			"UPDATE boards SET deleted = ?, updated_at = ? WHERE id = ?",
			true, now, id,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "删除失败"})
			return
		}

		c.JSON(http.StatusOK, gin.H{"success": true})
	}
}
