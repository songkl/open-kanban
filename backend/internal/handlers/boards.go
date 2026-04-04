package handlers

import (
	"database/sql"
	"fmt"
	"net/http"

	"open-kanban/internal/utils"
	"strings"
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

func ensureUniqueBoardAlias(tx *sql.Tx, alias string) string {
	base := alias
	counter := 1
	for {
		var count int
		err := tx.QueryRow("SELECT COUNT(*) FROM boards WHERE short_alias = ?", alias).Scan(&count)
		if err != nil {
			break
		}
		if count == 0 {
			return alias
		}
		alias = fmt.Sprintf("%s-%d", base, counter)
		counter++
	}
	return alias
}

func generateColumnIDForTx(tx *sql.Tx, name string, boardID string) string {
	baseSlug := utils.ToPinyinSlug(name)
	if baseSlug == "" {
		baseSlug = "column"
	}

	shortBoardID := boardID
	if len(shortBoardID) > 8 {
		shortBoardID = shortBoardID[:8]
	}

	colID := fmt.Sprintf("%s-%s", baseSlug, shortBoardID)
	counter := 1
	for {
		var count int
		err := tx.QueryRow("SELECT COUNT(*) FROM columns WHERE id = ?", colID).Scan(&count)
		if err != nil {
			break
		}
		if count == 0 {
			return colID
		}
		colID = fmt.Sprintf("%s-%s-%d", baseSlug, shortBoardID, counter)
		counter++
	}
	return colID
}

// GetBoards returns all boards
func GetBoards(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		rows, err := db.Query(`
			SELECT id, name, COALESCE(description, ''), deleted, created_at, updated_at,
				(SELECT COUNT(*) FROM columns WHERE board_id = b.id) as column_count
			FROM boards b
			WHERE deleted = false
			ORDER BY created_at ASC
		`)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get board"})
			return
		}
		defer rows.Close()

		boards := []gin.H{}
		for rows.Next() {
			var id, name, description string
			var deleted bool
			var createdAt, updatedAt time.Time
			var columnCount int
			if err := rows.Scan(&id, &name, &description, &deleted, &createdAt, &updatedAt, &columnCount); err == nil {
				boards = append(boards, gin.H{
					"id":          id,
					"name":        name,
					"description": description,
					"deleted":     deleted,
					"createdAt":   createdAt,
					"updatedAt":   updatedAt,
					"_count": gin.H{
						"columns": columnCount,
					},
				})
			}
		}

		c.JSON(http.StatusOK, boards)
	}
}

// GetBoard returns a single board by ID
func GetBoard(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		boardID := c.Param("id")
		if boardID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Board ID is required"})
			return
		}

		var id, name, description, shortAlias string
		var deleted bool
		var createdAt, updatedAt time.Time
		var columnCount int

		err := db.QueryRow(`
			SELECT b.id, b.name, COALESCE(b.description, ''), COALESCE(b.short_alias, ''), b.deleted, b.created_at, b.updated_at,
				(SELECT COUNT(*) FROM columns WHERE board_id = b.id) as column_count
			FROM boards b
			WHERE b.id = ? AND b.deleted = false
		`, boardID).Scan(&id, &name, &description, &shortAlias, &deleted, &createdAt, &updatedAt, &columnCount)

		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "Board not found"})
			return
		}
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get board"})
			return
		}

		c.JSON(http.StatusOK, gin.H{
			"id":          id,
			"name":        name,
			"description": description,
			"shortAlias":  shortAlias,
			"deleted":     deleted,
			"createdAt":   createdAt,
			"updatedAt":   updatedAt,
			"_count": gin.H{
				"columns": columnCount,
			},
		})
	}
}

// CreateBoardRequest represents board creation request
type CreateBoardRequest struct {
	ShortAlias  string `json:"shortAlias" validate:"max=50"`
	ID          string `json:"id" validate:"omitempty,max=100"`
	Name        string `json:"name" validate:"required,max=255"`
	Description string `json:"description" validate:"max=1000"`
}

// CreateBoard creates a new board with default columns
func CreateBoard(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		var req CreateBoardRequest
		if err := BindAndValidate(c, &req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": formatValidationError(err)})
			return
		}

		boardID := req.ID
		if boardID == "" {
			boardID = utils.ToPinyinSlug(req.Name)
			if boardID == "" {
				boardID = generateID()
			}
		}

		tx, err := db.Begin()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create board"})
			return
		}
		defer tx.Rollback()

		shortAlias := req.ShortAlias
		if shortAlias == "" {
			shortAlias = utils.ToBoardAlias(req.Name)
		}
		shortAlias = ensureUniqueBoardAlias(tx, shortAlias)

		// Create board
		now := time.Now()
		_, err = tx.Exec(
			"INSERT INTO boards (id, name, description, short_alias, task_counter, deleted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			boardID, req.Name, req.Description, shortAlias, 1000, false, now, now,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create board"})
			return
		}

		// Create default columns
		for _, col := range defaultColumns {
			colID := generateColumnIDForTx(tx, col.Name, boardID)
			_, err = tx.Exec(
				"INSERT INTO columns (id, name, status, position, color, board_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				colID, col.Name, col.Status, col.Position, col.Color, boardID, now, now,
			)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create column"})
				return
			}
		}

		if err := tx.Commit(); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create board"})
			return
		}

		LogActivity(db, user.ID, "BOARD_CREATE", "BOARD", boardID, req.Name, "", c.ClientIP(), getRequestSource(c))

		// Get created board with columns
		var board gin.H
		board = gin.H{
			"id":          boardID,
			"name":        req.Name,
			"description": req.Description,
			"shortAlias":  shortAlias,
			"deleted":     false,
			"createdAt":   now,
			"updatedAt":   now,
		}

		c.JSON(http.StatusOK, board)
	}
}

// UpdateBoardRequest represents board update request
type UpdateBoardRequest struct {
	Name        string `json:"name" validate:"required,max=255"`
	Description string `json:"description" validate:"max=1000"`
}

// UpdateBoard updates a board
func UpdateBoard(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		id := c.Param("id")
		if id == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Board ID is required"})
			return
		}

		if !checkBoardAccess(db, user.ID, id, "ADMIN", user.Role) {
			c.JSON(http.StatusForbidden, gin.H{"error": "No permission to modify this board"})
			return
		}

		var req UpdateBoardRequest
		if err := BindAndValidate(c, &req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": formatValidationError(err)})
			return
		}

		var oldName, oldDesc string
		db.QueryRow("SELECT name, COALESCE(description, '') FROM boards WHERE id = ?", id).Scan(&oldName, &oldDesc)

		details := ""
		if req.Name != "" && req.Name != oldName {
			details = fmt.Sprintf("名称: '%s' → '%s'", oldName, req.Name)
		}
		if req.Description != oldDesc {
			if details != "" {
				details += "; "
			}
			details += fmt.Sprintf("说明: '%s' → '%s'", oldDesc, req.Description)
		}

		now := time.Now()
		_, err := db.Exec(
			"UPDATE boards SET name = ?, description = ?, updated_at = ? WHERE id = ?",
			req.Name, req.Description, now, id,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to update"})
			return
		}

		LogActivity(db, user.ID, "BOARD_UPDATE", "BOARD", id, req.Name, details, c.ClientIP(), getRequestSource(c))

		c.JSON(http.StatusOK, gin.H{
			"id":          id,
			"name":        req.Name,
			"description": req.Description,
			"updatedAt":   now,
		})
	}
}

// DeleteBoard soft deletes a board
func DeleteBoard(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		id := c.Param("id")
		if id == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Board ID is required"})
			return
		}

		if !checkBoardAccess(db, user.ID, id, "ADMIN", user.Role) {
			c.JSON(http.StatusForbidden, gin.H{"error": "No permission to delete this board"})
			return
		}

		now := time.Now()
		_, err := db.Exec(
			"UPDATE boards SET deleted = ?, updated_at = ? WHERE id = ?",
			true, now, id,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete"})
			return
		}

		LogActivity(db, user.ID, "BOARD_DELETE", "BOARD", id, "", "", c.ClientIP(), getRequestSource(c))

		c.JSON(http.StatusOK, gin.H{"success": true})
	}
}

// ExportBoardRequest represents export request
type ExportBoardRequest struct {
	Format string `json:"format"` // json or csv
}

// ExportBoard exports board data as JSON or CSV
func ExportBoard(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		boardID := c.Param("id")
		if boardID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Board ID is required"})
			return
		}

		if !checkBoardAccess(db, user.ID, boardID, "READ", user.Role) {
			c.JSON(http.StatusForbidden, gin.H{"error": "No permission to access this board"})
			return
		}

		format := c.Query("format")
		if format == "" {
			format = "json"
		}

		if format != "json" && format != "csv" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Unsupported export format, only json and csv are supported"})
			return
		}

		var boardName string
		err := db.QueryRow("SELECT name FROM boards WHERE id = ? AND deleted = false", boardID).Scan(&boardName)
		if err != nil {
			if err == sql.ErrNoRows {
				c.JSON(http.StatusNotFound, gin.H{"error": "Board not found"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get board"})
			return
		}

		exportData := gin.H{
			"boardId":    boardID,
			"boardName":  boardName,
			"exportedAt": time.Now(),
			"columns":    []gin.H{},
		}

		colRows, err := db.Query(`
			SELECT id, name, status, position, color, board_id, created_at, updated_at
			FROM columns WHERE board_id = ? ORDER BY position ASC
		`, boardID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get column"})
			return
		}
		defer colRows.Close()

		var columns []gin.H
		for colRows.Next() {
			var col struct {
				ID        string
				Name      string
				Status    sql.NullString
				Position  int
				Color     string
				BoardID   string
				CreatedAt time.Time
				UpdatedAt time.Time
			}
			if err := colRows.Scan(&col.ID, &col.Name, &col.Status, &col.Position, &col.Color, &col.BoardID, &col.CreatedAt, &col.UpdatedAt); err != nil {
				continue
			}

			var statusVal *string
			if col.Status.Valid {
				statusVal = &col.Status.String
			}

			taskRows, err := db.Query(`
				SELECT id, title, description, priority, assignee, meta, column_id, position, published, archived, archived_at, created_at, updated_at
				FROM tasks WHERE column_id = ? ORDER BY position ASC
			`, col.ID)
			if err != nil {
				continue
			}

			var tasks []gin.H
			for taskRows.Next() {
				var task struct {
					ID          string
					Title       string
					Description sql.NullString
					Priority    string
					Assignee    sql.NullString
					Meta        sql.NullString
					ColumnID    string
					Position    int
					Published   bool
					Archived    bool
					ArchivedAt  sql.NullTime
					CreatedAt   time.Time
					UpdatedAt   time.Time
				}
				if err := taskRows.Scan(&task.ID, &task.Title, &task.Description, &task.Priority, &task.Assignee, &task.Meta, &task.ColumnID, &task.Position, &task.Published, &task.Archived, &task.ArchivedAt, &task.CreatedAt, &task.UpdatedAt); err != nil {
					continue
				}

				var descVal, assigneeVal, metaVal *string
				if task.Description.Valid {
					descVal = &task.Description.String
				}
				if task.Assignee.Valid {
					assigneeVal = &task.Assignee.String
				}
				if task.Meta.Valid {
					metaVal = &task.Meta.String
				}

				comments, _ := getCommentsForTask(db, task.ID)
				subtasks, _ := getSubtasksForTask(db, task.ID)

				tasks = append(tasks, gin.H{
					"id":          task.ID,
					"title":       task.Title,
					"description": descVal,
					"priority":    task.Priority,
					"assignee":    assigneeVal,
					"meta":        metaVal,
					"columnId":    task.ColumnID,
					"position":    task.Position,
					"published":   task.Published,
					"archived":    task.Archived,
					"archivedAt":  task.ArchivedAt.Time,
					"createdAt":   task.CreatedAt,
					"updatedAt":   task.UpdatedAt,
					"comments":    comments,
					"subtasks":    subtasks,
				})
			}
			taskRows.Close()

			columns = append(columns, gin.H{
				"id":        col.ID,
				"name":      col.Name,
				"status":    statusVal,
				"position":  col.Position,
				"color":     col.Color,
				"boardId":   col.BoardID,
				"createdAt": col.CreatedAt,
				"updatedAt": col.UpdatedAt,
				"tasks":     tasks,
			})
		}
		exportData["columns"] = columns

		if format == "json" {
			c.JSON(http.StatusOK, exportData)
		} else {
			csv := generateCSV(exportData)
			timestamp := time.Now().Format("20060102_150405")
			filename := fmt.Sprintf("%s_%s.csv", boardName, timestamp)
			c.Header("Content-Description", "File Transfer")
			c.Header("Content-Disposition", "attachment; filename="+filename)
			c.Data(http.StatusOK, "text/csv; charset=utf-8", []byte(csv))
		}
	}
}

func generateCSV(data gin.H) string {
	var sb strings.Builder
	sb.WriteString("\xEF\xBB\xBF")

	sb.WriteString("列名称,任务标题,任务描述,优先级,负责人,状态,创建时间,更新时间,子任务,评论\n")

	columns, _ := data["columns"].([]gin.H)
	for _, col := range columns {
		colName, _ := col["name"].(string)
		tasks, _ := col["tasks"].([]gin.H)
		for _, task := range tasks {
			title, _ := task["title"].(string)
			desc, _ := task["description"].(string)
			priority, _ := task["priority"].(string)
			assignee, _ := task["assignee"].(string)
			published := task["published"].(bool)
			createdAt := task["createdAt"].(time.Time).Format("2006-01-02 15:04:05")
			updatedAt := task["updatedAt"].(time.Time).Format("2006-01-02 15:04:05")

			status := "进行中"
			if !published {
				status = "草稿"
			}

			subtasks, _ := task["subtasks"].([]gin.H)
			subtaskTitles := []string{}
			for _, st := range subtasks {
				if t, ok := st["title"].(string); ok {
					completed := st["completed"].(bool)
					mark := "○"
					if completed {
						mark = "●"
					}
					subtaskTitles = append(subtaskTitles, mark+t)
				}
			}

			comments, _ := task["comments"].([]gin.H)
			commentContents := []string{}
			for _, cm := range comments {
				if content, ok := cm["content"].(string); ok {
					author, _ := cm["author"].(string)
					commentContents = append(commentContents, author+": "+content)
				}
			}

			sb.WriteString(fmt.Sprintf("\"%s\",\"%s\",\"%s\",\"%s\",\"%s\",\"%s\",\"%s\",\"%s\",\"%s\",\"%s\"\n",
				escapeCSV(colName),
				escapeCSV(title),
				escapeCSV(desc),
				priority,
				escapeCSV(assignee),
				status,
				createdAt,
				updatedAt,
				escapeCSV(strings.Join(subtaskTitles, "; ")),
				escapeCSV(strings.Join(commentContents, "; ")),
			))
		}
	}

	return sb.String()
}

func escapeCSV(s string) string {
	s = strings.ReplaceAll(s, "\"", "\"\"")
	s = strings.ReplaceAll(s, "\n", " ")
	s = strings.ReplaceAll(s, "\r", " ")
	return s
}

type ImportData struct {
	BoardName string         `json:"boardName"`
	Columns   []ImportColumn `json:"columns"`
}

type ImportColumn struct {
	ID       string       `json:"id"`
	Name     string       `json:"name"`
	Status   *string      `json:"status"`
	Position int          `json:"position"`
	Color    string       `json:"color"`
	Tasks    []ImportTask `json:"tasks"`
}

type ImportTask struct {
	ID          string          `json:"id"`
	Title       string          `json:"title"`
	Description *string         `json:"description"`
	Priority    string          `json:"priority"`
	Assignee    *string         `json:"assignee"`
	Meta        *string         `json:"meta"`
	Position    int             `json:"position"`
	Published   bool            `json:"published"`
	Archived    bool            `json:"archived"`
	Comments    []ImportComment `json:"comments"`
	Subtasks    []ImportSubtask `json:"subtasks"`
}

type ImportComment struct {
	Content string `json:"content"`
	Author  string `json:"author"`
}

type ImportSubtask struct {
	Title     string `json:"title"`
	Completed bool   `json:"completed"`
}

type ImportBoardRequest struct {
	Data    ImportData `json:"data"`
	BoardID string     `json:"boardId"`
	Reset   bool       `json:"reset"`
}

func ImportBoard(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		var req ImportBoardRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid import data"})
			return
		}

		boardID := req.BoardID
		if boardID == "" {
			boardID = generateID()
		}

		boardName := req.Data.BoardName
		if boardName == "" {
			boardName = "Imported Board"
		}

		var boardExists bool
		if boardID != "" {
			err := db.QueryRow("SELECT EXISTS(SELECT 1 FROM boards WHERE id = ? AND deleted = false)", boardID).Scan(&boardExists)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to check board"})
				return
			}
		}

		if boardExists && !req.Reset {
			c.JSON(http.StatusConflict, gin.H{"error": "Board ID already exists, please confirm and retry to overwrite"})
			return
		}

		tx, err := db.Begin()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create board"})
			return
		}
		defer tx.Rollback()

		now := time.Now()
		if boardExists && req.Reset {
			if !checkBoardAccess(db, user.ID, boardID, "WRITE", user.Role) {
				c.JSON(http.StatusForbidden, gin.H{"error": "No permission to reset this board"})
				return
			}
			_, err = tx.Exec("UPDATE boards SET name = ?, updated_at = ? WHERE id = ?", boardName, now, boardID)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to reset board"})
				return
			}
			if err := resetBoardData(tx, boardID); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to clear board data"})
				return
			}
		} else {
			_, err = tx.Exec(
				"INSERT INTO boards (id, name, deleted, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
				boardID, boardName, false, now, now,
			)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create board"})
				return
			}
		}

		columnIDMap := make(map[string]string)

		for _, col := range req.Data.Columns {
			colID := generateID()
			columnIDMap[col.ID] = colID

			status := ""
			if col.Status != nil {
				status = *col.Status
			}

			color := col.Color
			if color == "" {
				color = "#6b7280"
			}

			_, err = tx.Exec(
				"INSERT INTO columns (id, name, status, position, color, board_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				colID, col.Name, status, col.Position, color, boardID, now, now,
			)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create column"})
				return
			}
		}

		for _, col := range req.Data.Columns {
			newColID := columnIDMap[col.ID]

			for _, task := range col.Tasks {
				taskID := generateID()

				description := ""
				if task.Description != nil {
					description = *task.Description
				}

				assignee := ""
				if task.Assignee != nil {
					assignee = *task.Assignee
				}

				meta := ""
				if task.Meta != nil {
					meta = *task.Meta
				}

				priority := task.Priority
				if priority == "" {
					priority = "medium"
				}

				_, err = tx.Exec(
					"INSERT INTO tasks (id, title, description, priority, assignee, meta, column_id, position, published, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
					taskID, task.Title, description, priority, assignee, meta, newColID, task.Position, task.Published, task.Archived, now, now,
				)
				if err != nil {
					c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create task"})
					return
				}

				for _, comment := range task.Comments {
					commentID := generateID()
					_, err = tx.Exec(
						"INSERT INTO comments (id, content, author, task_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
						commentID, comment.Content, comment.Author, taskID, now, now,
					)
					if err != nil {
						c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create comment"})
						return
					}
				}

				for _, subtask := range task.Subtasks {
					subtaskID := generateID()
					_, err = tx.Exec(
						"INSERT INTO subtasks (id, title, completed, task_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
						subtaskID, subtask.Title, subtask.Completed, taskID, now, now,
					)
					if err != nil {
						c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create subtask"})
						return
					}
				}
			}
		}

		if err := tx.Commit(); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Import failed"})
			return
		}

		LogActivity(db, user.ID, "BOARD_IMPORT", "BOARD", boardID, boardName, "", c.ClientIP(), getRequestSource(c))

		c.JSON(http.StatusOK, gin.H{
			"id":   boardID,
			"name": boardName,
		})
	}
}

func resetBoardData(tx *sql.Tx, boardID string) error {
	if _, err := tx.Exec("DELETE FROM column_permissions WHERE column_id IN (SELECT id FROM columns WHERE board_id = ?)", boardID); err != nil {
		return err
	}
	if _, err := tx.Exec("DELETE FROM column_agents WHERE column_id IN (SELECT id FROM columns WHERE board_id = ?)", boardID); err != nil {
		return err
	}
	if _, err := tx.Exec("DELETE FROM attachments WHERE task_id IN (SELECT id FROM tasks WHERE column_id IN (SELECT id FROM columns WHERE board_id = ?))", boardID); err != nil {
		return err
	}
	if _, err := tx.Exec("DELETE FROM comments WHERE task_id IN (SELECT id FROM tasks WHERE column_id IN (SELECT id FROM columns WHERE board_id = ?))", boardID); err != nil {
		return err
	}
	if _, err := tx.Exec("DELETE FROM subtasks WHERE task_id IN (SELECT id FROM tasks WHERE column_id IN (SELECT id FROM columns WHERE board_id = ?))", boardID); err != nil {
		return err
	}
	if _, err := tx.Exec("DELETE FROM tasks WHERE column_id IN (SELECT id FROM columns WHERE board_id = ?)", boardID); err != nil {
		return err
	}
	if _, err := tx.Exec("DELETE FROM columns WHERE board_id = ?", boardID); err != nil {
		return err
	}
	return nil
}

func ResetBoard(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		boardID := c.Param("id")
		if boardID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Board ID is required"})
			return
		}

		if !checkBoardAccess(db, user.ID, boardID, "WRITE", user.Role) {
			c.JSON(http.StatusForbidden, gin.H{"error": "No permission to reset this board"})
			return
		}

		var boardName string
		err := db.QueryRow("SELECT name FROM boards WHERE id = ? AND deleted = false", boardID).Scan(&boardName)
		if err != nil {
			if err == sql.ErrNoRows {
				c.JSON(http.StatusNotFound, gin.H{"error": "Board not found"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to get board"})
			return
		}

		tx, err := db.Begin()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to reset board"})
			return
		}
		defer tx.Rollback()

		if err := resetBoardData(tx, boardID); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to clear board data"})
			return
		}

		if err := tx.Commit(); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to reset board"})
			return
		}

		LogActivity(db, user.ID, "BOARD_UPDATE", "BOARD", boardID, boardName, "重置看板", c.ClientIP(), getRequestSource(c))

		c.JSON(http.StatusOK, gin.H{
			"id":   boardID,
			"name": boardName,
		})
	}
}
