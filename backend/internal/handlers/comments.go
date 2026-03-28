package handlers

import (
	"database/sql"
	"net/http"
	"time"

	"kanban-go/internal/models"

	"github.com/gin-gonic/gin"
)

// GetComments returns comments for a task
func GetComments(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		taskID := c.Query("taskId")
		if taskID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "任务 ID 不能为空"})
			return
		}

		rows, err := db.Query(`
			SELECT id, content, author, task_id, created_at, updated_at
			FROM comments
			WHERE task_id = ?
			ORDER BY created_at DESC
		`, taskID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "获取评论失败"})
			return
		}
		defer rows.Close()

		var comments []gin.H
		for rows.Next() {
			var comment models.Comment
			if err := rows.Scan(&comment.ID, &comment.Content, &comment.Author, &comment.TaskID, &comment.CreatedAt, &comment.UpdatedAt); err == nil {
				comments = append(comments, gin.H{
					"id":        comment.ID,
					"content":   comment.Content,
					"author":    comment.Author,
					"taskId":    comment.TaskID,
					"createdAt": comment.CreatedAt,
					"updatedAt": comment.UpdatedAt,
				})
			}
		}

		c.JSON(http.StatusOK, comments)
	}
}

// CreateCommentRequest represents comment creation request
type CreateCommentRequest struct {
	Content string `json:"content"`
	Author  string `json:"author"`
	TaskID  string `json:"taskId"`
}

// CreateComment creates a new comment
func CreateComment(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req CreateCommentRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "评论内容不能为空"})
			return
		}

		commentID := generateID()
		now := time.Now()
		author := req.Author
		if author == "" {
			author = "Anonymous"
		}

		_, err := db.Exec(
			"INSERT INTO comments (id, content, author, task_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			commentID, req.Content, author, req.TaskID, now, now,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "创建评论失败"})
			return
		}

		broadcast()

		c.JSON(http.StatusOK, gin.H{
			"id":        commentID,
			"content":   req.Content,
			"author":    author,
			"taskId":    req.TaskID,
			"createdAt": now,
			"updatedAt": now,
		})
	}
}
