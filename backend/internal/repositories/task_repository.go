package repositories

import (
	"database/sql"
	"strings"
	"time"

	"open-kanban/internal/models"
)

type TaskRepository struct {
	db *sql.DB
}

func NewTaskRepository(db *sql.DB) *TaskRepository {
	return &TaskRepository{db: db}
}

func (r *TaskRepository) GetTaskByID(id string) (*models.Task, error) {
	var task models.Task
	var desc, assignee, meta, createdBy, createdByUsername, agentID, agentPrompt sql.NullString
	var archivedAt sql.NullTime

	err := r.db.QueryRow(`
		SELECT t.id, t.title, t.description, t.priority, t.assignee, t.meta, t.column_id, t.position, 
		       t.published, t.archived, t.archived_at, t.agent_id, t.agent_prompt, t.created_by, t.created_at, t.updated_at,
		       COALESCE(u.nickname, u.username) as created_by_username
		FROM tasks t
		LEFT JOIN users u ON t.created_by = u.id
		WHERE t.id = ?
	`, id).Scan(&task.ID, &task.Title, &desc, &task.Priority, &assignee, &meta, &task.ColumnID, &task.Position,
		&task.Published, &task.Archived, &archivedAt, &agentID, &agentPrompt, &createdBy, &task.CreatedAt, &task.UpdatedAt,
		&createdByUsername)

	if err != nil {
		return nil, err
	}

	if desc.Valid {
		task.Description = &desc.String
	}
	if assignee.Valid {
		task.Assignee = &assignee.String
	}
	if meta.Valid {
		task.Meta = &meta.String
	}
	if archivedAt.Valid {
		task.ArchivedAt = &archivedAt.Time
	}
	if agentID.Valid {
		task.AgentID = &agentID.String
	}
	if agentPrompt.Valid {
		task.AgentPrompt = &agentPrompt.String
	}
	if createdBy.Valid {
		task.CreatedBy = createdBy.String
	}
	if createdByUsername.Valid {
		task.CreatedByUsername = createdByUsername.String
	}

	return &task, nil
}

func (r *TaskRepository) GetTasksByColumnIDs(columnIDs []string, page, pageSize int, includeDrafts, includeArchived bool) ([]models.Task, int, error) {
	var total int
	if len(columnIDs) > 0 {
		countArgs := make([]interface{}, len(columnIDs))
		for i, id := range columnIDs {
			countArgs[i] = id
		}
		inClause := buildInClause(len(columnIDs))
		countQuery := "SELECT COUNT(*) FROM tasks WHERE column_id IN " + inClause
		if !includeDrafts {
			countQuery += " AND published = 1"
		}
		if !includeArchived {
			countQuery += " AND archived = 0"
		}
		if err := r.db.QueryRow(countQuery, countArgs...).Scan(&total); err != nil {
			return nil, 0, err
		}
	} else {
		countQuery := "SELECT COUNT(*) FROM tasks"
		if !includeDrafts {
			countQuery += " WHERE published = 1"
		}
		if !includeArchived {
			if !includeDrafts {
				countQuery += " AND archived = 0"
			} else {
				countQuery += " WHERE archived = 0"
			}
		}
		if err := r.db.QueryRow(countQuery).Scan(&total); err != nil {
			return nil, 0, err
		}
	}

	offset := (page - 1) * pageSize
	var rows *sql.Rows
	var err error

	if len(columnIDs) > 0 {
		args := make([]interface{}, 0, len(columnIDs)+2)
		for _, id := range columnIDs {
			args = append(args, id)
		}
		inClause := buildInClause(len(columnIDs))
		whereClause := "WHERE t.column_id IN " + inClause
		if !includeDrafts {
			whereClause += " AND t.published = 1"
		}
		if !includeArchived {
			whereClause += " AND t.archived = 0"
		}
		query := `SELECT t.id, t.title, t.description, t.priority, t.assignee, t.meta, t.column_id, t.position,
		          t.published, t.archived, t.archived_at, t.agent_id, t.agent_prompt, t.created_by, t.created_at, t.updated_at,
		          COALESCE(cc.cnt, 0) as comment_count,
		          COALESCE(sc.cnt, 0) as subtask_count,
		          COALESCE(u.nickname, u.username) as created_by_username
		          FROM tasks t
		          JOIN columns col ON t.column_id = col.id
		          LEFT JOIN (SELECT task_id, COUNT(*) as cnt FROM comments GROUP BY task_id) cc ON t.id = cc.task_id
		          LEFT JOIN (SELECT task_id, COUNT(*) as cnt FROM subtasks GROUP BY task_id) sc ON t.id = sc.task_id
		          LEFT JOIN users u ON t.created_by = u.id
		          ` + whereClause + `
		          ORDER BY col.position ASC, t.position ASC
		          LIMIT ? OFFSET ?`
		args = append(args, pageSize, offset)
		rows, err = r.db.Query(query, args...)
	} else {
		whereClause := ""
		if !includeDrafts {
			whereClause += " WHERE t.published = 1"
		}
		if !includeArchived {
			if whereClause == "" {
				whereClause += " WHERE t.archived = 0"
			} else {
				whereClause += " AND t.archived = 0"
			}
		}
		rows, err = r.db.Query(`SELECT t.id, t.title, t.description, t.priority, t.assignee, t.meta, t.column_id, t.position,
		                         t.published, t.archived, t.archived_at, t.agent_id, t.agent_prompt, t.created_by, t.created_at, t.updated_at,
		                         COALESCE(cc.cnt, 0) as comment_count,
		                         COALESCE(sc.cnt, 0) as subtask_count,
		                         COALESCE(u.nickname, u.username) as created_by_username
		                         FROM tasks t
		                         JOIN columns col ON t.column_id = col.id
		                         LEFT JOIN (SELECT task_id, COUNT(*) as cnt FROM comments GROUP BY task_id) cc ON t.id = cc.task_id
		                         LEFT JOIN (SELECT task_id, COUNT(*) as cnt FROM subtasks GROUP BY task_id) sc ON t.id = sc.task_id
		                         LEFT JOIN users u ON t.created_by = u.id
		                         `+whereClause+`
		                         ORDER BY col.position ASC, t.position ASC
		                         LIMIT ? OFFSET ?`, pageSize, offset)
	}

	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	var tasks []models.Task
	for rows.Next() {
		var task models.Task
		var desc, assignee, meta, createdBy, createdByUsername, agentID, agentPrompt sql.NullString
		var archivedAt sql.NullTime
		var commentCount, subtaskCount int

		if err := rows.Scan(&task.ID, &task.Title, &desc, &task.Priority, &assignee, &meta, &task.ColumnID, &task.Position,
			&task.Published, &task.Archived, &archivedAt, &agentID, &agentPrompt, &createdBy, &task.CreatedAt, &task.UpdatedAt,
			&commentCount, &subtaskCount, &createdByUsername); err != nil {
			continue
		}

		if desc.Valid {
			task.Description = &desc.String
		}
		if assignee.Valid {
			task.Assignee = &assignee.String
		}
		if meta.Valid {
			task.Meta = &meta.String
		}
		if archivedAt.Valid {
			task.ArchivedAt = &archivedAt.Time
		}
		if agentID.Valid {
			task.AgentID = &agentID.String
		}
		if agentPrompt.Valid {
			task.AgentPrompt = &agentPrompt.String
		}
		if createdBy.Valid {
			task.CreatedBy = createdBy.String
		}
		if createdByUsername.Valid {
			task.CreatedByUsername = createdByUsername.String
		}

		task.CommentCount = &commentCount
		task.SubtaskCount = &subtaskCount

		tasks = append(tasks, task)
	}

	return tasks, total, nil
}

func (r *TaskRepository) CreateTask(task *models.Task) error {
	_, err := r.db.Exec(`
		INSERT INTO tasks (id, title, description, priority, assignee, meta, column_id, position, published, archived, agent_id, agent_prompt, created_by, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, task.ID, task.Title, task.Description, task.Priority, task.Assignee, task.Meta, task.ColumnID, task.Position,
		task.Published, task.Archived, task.AgentID, task.AgentPrompt, task.CreatedBy, task.CreatedAt, task.UpdatedAt)
	return err
}

func (r *TaskRepository) UpdateTask(task *models.Task) error {
	_, err := r.db.Exec(`
		UPDATE tasks SET title = ?, description = ?, priority = ?, assignee = ?, meta = ?, 
		                 column_id = ?, position = ?, published = ?, archived = ?, archived_at = ?,
		                 agent_id = ?, agent_prompt = ?, updated_at = ?
		WHERE id = ?
	`, task.Title, task.Description, task.Priority, task.Assignee, task.Meta,
		task.ColumnID, task.Position, task.Published, task.Archived, task.ArchivedAt,
		task.AgentID, task.AgentPrompt, time.Now(), task.ID)
	return err
}

func (r *TaskRepository) DeleteTask(id string) error {
	_, err := r.db.Exec("DELETE FROM tasks WHERE id = ?", id)
	return err
}

func (r *TaskRepository) GetColumnIDForTask(taskID string) (string, error) {
	var columnID string
	err := r.db.QueryRow("SELECT column_id FROM tasks WHERE id = ?", taskID).Scan(&columnID)
	return columnID, err
}

func (r *TaskRepository) GetMaxPositionForPriority(columnID, priority string) (int, error) {
	var maxPos sql.NullInt64
	err := r.db.QueryRow("SELECT MAX(position) FROM tasks WHERE column_id = ? AND priority = ?", columnID, priority).Scan(&maxPos)
	if err != nil && err != sql.ErrNoRows {
		return 0, err
	}
	if maxPos.Valid {
		return int(maxPos.Int64), nil
	}
	return 0, nil
}

func (r *TaskRepository) GetMaxPosition(columnID string) (int, error) {
	var maxPos sql.NullInt64
	err := r.db.QueryRow("SELECT MAX(position) FROM tasks WHERE column_id = ?", columnID).Scan(&maxPos)
	if err != nil && err != sql.ErrNoRows {
		return 0, err
	}
	if maxPos.Valid {
		return int(maxPos.Int64), nil
	}
	return 0, nil
}

func (r *TaskRepository) GetMinPositionForLowPriority(columnID string) (int, error) {
	var minPos sql.NullInt64
	err := r.db.QueryRow("SELECT MIN(position) FROM tasks WHERE column_id = ? AND priority = 'low'", columnID).Scan(&minPos)
	if err != nil && err != sql.ErrNoRows {
		return 0, err
	}
	if minPos.Valid {
		return int(minPos.Int64), nil
	}
	return 0, nil
}

func (r *TaskRepository) GetMinPositionForMediumPriority(columnID string) (int, error) {
	var minPos sql.NullInt64
	err := r.db.QueryRow("SELECT MIN(position) FROM tasks WHERE column_id = ? AND priority = 'medium'", columnID).Scan(&minPos)
	if err != nil && err != sql.ErrNoRows {
		return 0, err
	}
	if minPos.Valid {
		return int(minPos.Int64), nil
	}
	return 0, nil
}

func (r *TaskRepository) GetMinPositionForHighPriority(columnID string) (int, error) {
	var minPos sql.NullInt64
	err := r.db.QueryRow("SELECT MIN(position) FROM tasks WHERE column_id = ? AND priority = 'high'", columnID).Scan(&minPos)
	if err != nil && err != sql.ErrNoRows {
		return 0, err
	}
	if minPos.Valid {
		return int(minPos.Int64), nil
	}
	return 0, nil
}

func (r *TaskRepository) ShiftPositionsUp(columnID string, fromPos, toPos int, excludeID string) error {
	_, err := r.db.Exec(`
		UPDATE tasks SET position = position + 1, updated_at = ?
		WHERE column_id = ? AND position >= ? AND position < ? AND id != ?
	`, time.Now(), columnID, fromPos, toPos, excludeID)
	return err
}

func (r *TaskRepository) ShiftPositionsDown(columnID string, fromPos, toPos int, excludeID string) error {
	_, err := r.db.Exec(`
		UPDATE tasks SET position = position - 1, updated_at = ?
		WHERE column_id = ? AND position > ? AND position <= ? AND id != ?
	`, time.Now(), columnID, fromPos, toPos, excludeID)
	return err
}

func (r *TaskRepository) ShiftPositionsLeft(columnID string, fromPos int) error {
	_, err := r.db.Exec(`
		UPDATE tasks SET position = position - 1, updated_at = ?
		WHERE column_id = ? AND position > ?
	`, time.Now(), columnID, fromPos)
	return err
}

func (r *TaskRepository) ShiftPositionsRight(columnID string, fromPos int, excludeID string) error {
	_, err := r.db.Exec(`
		UPDATE tasks SET position = position + 1, updated_at = ?
		WHERE column_id = ? AND position >= ? AND id != ?
	`, time.Now(), columnID, fromPos, excludeID)
	return err
}

func (r *TaskRepository) GetTaskCommentCount(taskID string) (int, error) {
	var count int
	err := r.db.QueryRow("SELECT COUNT(*) FROM comments WHERE task_id = ?", taskID).Scan(&count)
	return count, err
}

func (r *TaskRepository) GetTaskSubtaskCount(taskID string) (int, error) {
	var count int
	err := r.db.QueryRow("SELECT COUNT(*) FROM subtasks WHERE task_id = ?", taskID).Scan(&count)
	return count, err
}

func (r *TaskRepository) GetNextColumn(boardID string, currentPosition int) (string, error) {
	var nextColumnID string
	rows, err := r.db.Query("SELECT id FROM columns WHERE board_id = ? AND position > ? ORDER BY position ASC LIMIT 1", boardID, currentPosition)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	if rows.Next() {
		if err := rows.Scan(&nextColumnID); err != nil {
			return "", err
		}
	}
	return nextColumnID, nil
}

func (r *TaskRepository) MoveTaskToColumn(taskID, columnID string, position int) error {
	_, err := r.db.Exec("UPDATE tasks SET column_id = ?, position = ?, updated_at = ? WHERE id = ?", columnID, position, time.Now(), taskID)
	return err
}

func (r *TaskRepository) GetColumnPositionAndBoardID(columnID string) (int, string, error) {
	var position int
	var boardID string
	err := r.db.QueryRow("SELECT position, board_id FROM columns WHERE id = ?", columnID).Scan(&position, &boardID)
	return position, boardID, err
}

func buildInClause(n int) string {
	if n <= 0 {
		return "(NULL)"
	}
	return "(" + strings.Repeat("?,", n-1) + "?)"
}

type TaskSearchParams struct {
	Query     string
	Priority  string
	Status    string
	BoardID   string
	Assignee  string
	DateRange string
	TaskID    string
	Page      int
	PageSize  int
}

func (r *TaskRepository) SearchTasks(params TaskSearchParams) ([]models.Task, int, error) {
	baseQuery := `
		SELECT DISTINCT t.id, t.title, t.description, t.priority, t.assignee, t.meta, t.column_id, t.position,
		       t.published, t.archived, t.archived_at, t.agent_id, t.agent_prompt, t.created_by, t.created_at, t.updated_at,
		       COALESCE(cc.cnt, 0) as comment_count,
		       COALESCE(sc.cnt, 0) as subtask_count,
		       COALESCE(u.nickname, u.username) as created_by_username
		FROM tasks t
		JOIN columns col ON t.column_id = col.id
		LEFT JOIN (SELECT task_id, COUNT(*) as cnt FROM comments GROUP BY task_id) cc ON t.id = cc.task_id
		LEFT JOIN (SELECT task_id, COUNT(*) as cnt FROM subtasks GROUP BY task_id) sc ON t.id = sc.task_id
		LEFT JOIN users u ON t.created_by = u.id
	`

	countQuery := `
		SELECT COUNT(DISTINCT t.id)
		FROM tasks t
		JOIN columns col ON t.column_id = col.id
	`

	var conditions []string
	var args []interface{}

	if params.Query != "" {
		q := "%" + params.Query + "%"
		titleCond := "t.title LIKE ?"
		descCond := "t.description LIKE ?"
		metaCond := "t.meta LIKE ?"
		commentCond := "EXISTS (SELECT 1 FROM comments c WHERE c.task_id = t.id AND c.content LIKE ?)"
		conditions = append(conditions, "("+titleCond+" OR "+descCond+" OR "+metaCond+" OR "+commentCond+")")
		args = append(args, q, q, q, q)
	}

	if params.Priority != "" {
		conditions = append(conditions, "t.priority = ?")
		args = append(args, params.Priority)
	}

	if params.Status != "" {
		conditions = append(conditions, "col.status = ?")
		args = append(args, params.Status)
	}

	if params.BoardID != "" {
		conditions = append(conditions, "col.board_id = ?")
		args = append(args, params.BoardID)
	}

	if params.Assignee != "" {
		conditions = append(conditions, "t.assignee = ?")
		args = append(args, params.Assignee)
	}

	if params.DateRange != "" {
		now := time.Now()
		switch params.DateRange {
		case "today":
			startOfDay := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
			conditions = append(conditions, "t.created_at >= ?")
			args = append(args, startOfDay)
		case "thisWeek":
			startOfWeek := now.AddDate(0, 0, -int(now.Weekday()))
			conditions = append(conditions, "t.created_at >= ?")
			args = append(args, startOfWeek)
		case "thisMonth":
			startOfMonth := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, now.Location())
			conditions = append(conditions, "t.created_at >= ?")
			args = append(args, startOfMonth)
		}
	}

	if params.TaskID != "" {
		conditions = append(conditions, "t.id = ?")
		args = append(args, params.TaskID)
	}

	conditions = append(conditions, "t.archived = 0")

	whereClause := ""
	if len(conditions) > 0 {
		whereClause = " WHERE " + strings.Join(conditions, " AND ")
	}

	countQueryFull := countQuery + whereClause
	var total int
	countArgs := make([]interface{}, len(args))
	copy(countArgs, args)
	if err := r.db.QueryRow(countQueryFull, countArgs...).Scan(&total); err != nil {
		return nil, 0, err
	}

	offset := (params.Page - 1) * params.PageSize
	limitClause := " ORDER BY t.updated_at DESC LIMIT ? OFFSET ?"

	query := baseQuery + whereClause + limitClause
	queryArgs := append(args, params.PageSize, offset)

	rows, err := r.db.Query(query, queryArgs...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	var tasks []models.Task
	for rows.Next() {
		var task models.Task
		var desc, assignee, meta, createdBy, createdByUsername, agentID, agentPrompt sql.NullString
		var archivedAt sql.NullTime
		var commentCount, subtaskCount int

		if err := rows.Scan(&task.ID, &task.Title, &desc, &task.Priority, &assignee, &meta, &task.ColumnID, &task.Position,
			&task.Published, &task.Archived, &archivedAt, &agentID, &agentPrompt, &createdBy, &task.CreatedAt, &task.UpdatedAt,
			&commentCount, &subtaskCount, &createdByUsername); err != nil {
			continue
		}

		if desc.Valid {
			task.Description = &desc.String
		}
		if assignee.Valid {
			task.Assignee = &assignee.String
		}
		if meta.Valid {
			task.Meta = &meta.String
		}
		if archivedAt.Valid {
			task.ArchivedAt = &archivedAt.Time
		}
		if agentID.Valid {
			task.AgentID = &agentID.String
		}
		if agentPrompt.Valid {
			task.AgentPrompt = &agentPrompt.String
		}
		if createdBy.Valid {
			task.CreatedBy = createdBy.String
		}
		if createdByUsername.Valid {
			task.CreatedByUsername = createdByUsername.String
		}

		task.CommentCount = &commentCount
		task.SubtaskCount = &subtaskCount

		tasks = append(tasks, task)
	}

	return tasks, total, nil
}
