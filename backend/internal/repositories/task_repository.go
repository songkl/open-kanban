package repositories

import (
	"database/sql"
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
	var desc, assignee, meta, createdBy, agentID, agentPrompt sql.NullString
	var archivedAt sql.NullTime

	err := r.db.QueryRow(`
		SELECT t.id, t.title, t.description, t.priority, t.assignee, t.meta, t.column_id, t.position, 
		       t.published, t.archived, t.archived_at, t.agent_id, t.agent_prompt, t.created_by, t.created_at, t.updated_at
		FROM tasks t
		WHERE t.id = ?
	`, id).Scan(&task.ID, &task.Title, &desc, &task.Priority, &assignee, &meta, &task.ColumnID, &task.Position,
		&task.Published, &task.Archived, &archivedAt, &agentID, &agentPrompt, &createdBy, &task.CreatedAt, &task.UpdatedAt)

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

	return &task, nil
}

func (r *TaskRepository) GetTasksByColumnIDs(columnIDs []string, page, pageSize int) ([]models.Task, int, error) {
	var total int
	if len(columnIDs) > 0 {
		placeholders := make([]string, len(columnIDs))
		countArgs := make([]interface{}, len(columnIDs))
		for i, id := range columnIDs {
			placeholders[i] = "?"
			countArgs[i] = id
		}
		countQuery := "SELECT COUNT(*) FROM tasks WHERE column_id IN (" + joinPlaceholders(len(columnIDs)) + ")"
		if err := r.db.QueryRow(countQuery, countArgs...).Scan(&total); err != nil {
			return nil, 0, err
		}
	} else {
		if err := r.db.QueryRow("SELECT COUNT(*) FROM tasks").Scan(&total); err != nil {
			return nil, 0, err
		}
	}

	offset := (page - 1) * pageSize
	var rows *sql.Rows
	var err error

	if len(columnIDs) > 0 {
		placeholders := make([]string, len(columnIDs))
		args := make([]interface{}, 0, len(columnIDs)+2)
		for i, id := range columnIDs {
			placeholders[i] = "?"
			args = append(args, id)
		}
		query := `SELECT t.id, t.title, t.description, t.priority, t.assignee, t.meta, t.column_id, t.position, 
		          t.published, t.archived, t.archived_at, t.agent_id, t.agent_prompt, t.created_by, t.created_at, t.updated_at
		          FROM tasks t
		          JOIN columns c ON t.column_id = c.id
		          WHERE t.column_id IN (` + joinPlaceholders(len(columnIDs)) + `)
		          ORDER BY c.position ASC, t.position ASC
		          LIMIT ? OFFSET ?`
		args = append(args, pageSize, offset)
		rows, err = r.db.Query(query, args...)
	} else {
		rows, err = r.db.Query(`SELECT t.id, t.title, t.description, t.priority, t.assignee, t.meta, t.column_id, t.position, 
		                         t.published, t.archived, t.archived_at, t.agent_id, t.agent_prompt, t.created_by, t.created_at, t.updated_at
		                         FROM tasks t
		                         JOIN columns c ON t.column_id = c.id
		                         ORDER BY c.position ASC, t.position ASC
		                         LIMIT ? OFFSET ?`, pageSize, offset)
	}

	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	var tasks []models.Task
	for rows.Next() {
		var task models.Task
		var desc, assignee, meta, createdBy, agentID, agentPrompt sql.NullString
		var archivedAt sql.NullTime

		if err := rows.Scan(&task.ID, &task.Title, &desc, &task.Priority, &assignee, &meta, &task.ColumnID, &task.Position,
			&task.Published, &task.Archived, &archivedAt, &agentID, &agentPrompt, &createdBy, &task.CreatedAt, &task.UpdatedAt); err != nil {
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

func (r *TaskRepository) ShiftPositionsUp(columnID string, fromPos, toPos int, excludeID string) error {
	_, err := r.db.Exec(`
		UPDATE tasks SET position = position + 1, updated_at = NOW()
		WHERE column_id = ? AND position >= ? AND position < ? AND id != ?
	`, columnID, fromPos, toPos, excludeID)
	return err
}

func (r *TaskRepository) ShiftPositionsDown(columnID string, fromPos, toPos int, excludeID string) error {
	_, err := r.db.Exec(`
		UPDATE tasks SET position = position - 1, updated_at = NOW()
		WHERE column_id = ? AND position > ? AND position <= ? AND id != ?
	`, columnID, fromPos, toPos, excludeID)
	return err
}

func (r *TaskRepository) ShiftPositionsLeft(columnID string, fromPos int) error {
	_, err := r.db.Exec(`
		UPDATE tasks SET position = position - 1, updated_at = NOW()
		WHERE column_id = ? AND position > ?
	`, columnID, fromPos)
	return err
}

func (r *TaskRepository) ShiftPositionsRight(columnID string, fromPos int, excludeID string) error {
	_, err := r.db.Exec(`
		UPDATE tasks SET position = position + 1, updated_at = NOW()
		WHERE column_id = ? AND position >= ? AND id != ?
	`, columnID, fromPos, excludeID)
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

func (r *TaskRepository) MoveTaskToColumn(taskID, columnID string) error {
	_, err := r.db.Exec("UPDATE tasks SET column_id = ?, updated_at = ? WHERE id = ?", columnID, time.Now(), taskID)
	return err
}

func (r *TaskRepository) GetColumnPositionAndBoardID(columnID string) (int, string, error) {
	var position int
	var boardID string
	err := r.db.QueryRow("SELECT position, board_id FROM columns WHERE id = ?", columnID).Scan(&position, &boardID)
	return position, boardID, err
}

func joinPlaceholders(n int) string {
	if n <= 0 {
		return ""
	}
	result := make([]byte, 2*n-1)
	for i := range result {
		if i%2 == 0 {
			result[i] = '?'
		} else {
			result[i] = ','
		}
	}
	return string(result)
}
