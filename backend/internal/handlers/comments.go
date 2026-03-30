package handlers

import (
	"database/sql"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

// GetComments returns comments for a task
func GetComments(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "未登录"})
			return
		}

		taskID := c.Query("taskId")
		if taskID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "任务 ID 不能为空"})
			return
		}

		boardID, err := getBoardIDForTask(db, taskID)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "无效的任务 ID"})
			return
		}

		if !checkBoardAccess(db, user.ID, boardID, "READ", user.Role) {
			c.JSON(http.StatusForbidden, gin.H{"error": "无权查看该任务的评论"})
			return
		}

		rows, err := db.Query(`
			SELECT id, content, author, task_id, user_id, created_at, updated_at
			FROM comments
			WHERE task_id = ?
			ORDER BY created_at ASC
		`, taskID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "获取评论失败"})
			return
		}
		defer rows.Close()

		var comments []gin.H
		for rows.Next() {
			var id, content, author, taskID, userID string
			var createdAt, updatedAt string
			if err := rows.Scan(&id, &content, &author, &taskID, &userID, &createdAt, &updatedAt); err == nil {
				comment := gin.H{
					"id":        id,
					"content":   content,
					"author":    author,
					"taskId":    taskID,
					"createdAt": createdAt,
					"updatedAt": updatedAt,
				}
				if userID != "" {
					comment["userId"] = userID
				}
				comments = append(comments, comment)
			}
		}

		c.JSON(http.StatusOK, comments)
	}
}

// GetComment returns a single comment by ID
func GetComment(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "未登录"})
			return
		}

		commentID := c.Param("id")
		if commentID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "评论 ID 不能为空"})
			return
		}

		var id, content, author, taskID, userID string
		var createdAt, updatedAt string
		err := db.QueryRow(`
			SELECT id, content, author, task_id, user_id, created_at, updated_at
			FROM comments
			WHERE id = ?
		`, commentID).Scan(&id, &content, &author, &taskID, &userID, &createdAt, &updatedAt)
		if err != nil {
			if err == sql.ErrNoRows {
				c.JSON(http.StatusNotFound, gin.H{"error": "评论不存在"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "获取评论失败"})
			return
		}

		boardID, err := getBoardIDForTask(db, taskID)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "无效的任务 ID"})
			return
		}

		if !checkBoardAccess(db, user.ID, boardID, "READ", user.Role) {
			c.JSON(http.StatusForbidden, gin.H{"error": "无权查看该评论"})
			return
		}

		comment := gin.H{
			"id":        id,
			"content":   content,
			"author":    author,
			"taskId":    taskID,
			"createdAt": createdAt,
			"updatedAt": updatedAt,
		}
		if userID != "" {
			comment["userId"] = userID
		}

		c.JSON(http.StatusOK, comment)
	}
}

// CreateCommentRequest represents comment creation request
type CreateCommentRequest struct {
	Content string `json:"content"`
	TaskID  string `json:"taskId"`
}

// CreateComment creates a new comment
func CreateComment(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "未登录"})
			return
		}

		if user.Role == "VIEWER" {
			c.JSON(http.StatusForbidden, gin.H{"error": "查看者角色无法添加评论"})
			return
		}

		if !checkRateLimit("comment:" + user.ID) {
			c.JSON(http.StatusTooManyRequests, gin.H{"error": "请求过于频繁，请稍后再试"})
			return
		}

		var req CreateCommentRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "评论内容不能为空"})
			return
		}

		if req.TaskID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "任务 ID 不能为空"})
			return
		}

		boardID, err := getBoardIDForTask(db, req.TaskID)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "无效的任务 ID"})
			return
		}

		if !checkBoardAccess(db, user.ID, boardID, "WRITE", user.Role) {
			c.JSON(http.StatusForbidden, gin.H{"error": "无权在该任务添加评论"})
			return
		}

		commentID := generateID()
		now := time.Now()
		author := user.Nickname

		_, err = db.Exec(
			"INSERT INTO comments (id, content, author, task_id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			commentID, req.Content, author, req.TaskID, user.ID, now, now,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "创建评论失败"})
			return
		}

		if user.Type == "AGENT" {
			LogActivity(db, user.ID, "ADD_COMMENT", "COMMENT", commentID, req.Content[:min(50, len(req.Content))]+"...", "", c.ClientIP(), getRequestSource(c))
		}

		broadcast()

		c.JSON(http.StatusOK, gin.H{
			"id":        commentID,
			"content":   req.Content,
			"author":    author,
			"userId":    user.ID,
			"taskId":    req.TaskID,
			"createdAt": now,
			"updatedAt": now,
		})
	}
}
