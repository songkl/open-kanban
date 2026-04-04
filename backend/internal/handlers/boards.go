package handlers

import (
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"open-kanban/internal/utils"
)

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

type CreateBoardRequest struct {
	ShortAlias  string `json:"shortAlias" validate:"max=50"`
	ID          string `json:"id" validate:"omitempty,max=100"`
	Name        string `json:"name" validate:"required,max=255"`
	Description string `json:"description" validate:"max=1000"`
}

type UpdateBoardRequest struct {
	Name        string `json:"name" validate:"required,max=255"`
	Description string `json:"description" validate:"max=1000"`
}

type ExportBoardRequest struct {
	Format string `json:"format"`
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
