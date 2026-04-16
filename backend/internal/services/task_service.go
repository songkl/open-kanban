package services

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/gin-gonic/gin"
	"open-kanban/internal/models"
	"open-kanban/internal/repositories"
)

type TaskService struct {
	db       *sql.DB
	taskRepo *repositories.TaskRepository
}

func NewTaskService(db *sql.DB) *TaskService {
	return &TaskService{
		db:       db,
		taskRepo: repositories.NewTaskRepository(db),
	}
}

type TaskListResult struct {
	Tasks     []gin.H
	Total     int
	Page      int
	PageSize  int
	PageCount int
}

func (s *TaskService) GetTasks(userID, role, columnID, boardID, status string, page, pageSize int, includeDrafts, includeArchived bool) (*TaskListResult, error) {
	columnIDs := []string{}
	if boardID != "" || status != "" {
		query := "SELECT c.id FROM columns c"
		var args []interface{}
		var conditions []string
		if boardID != "" {
			conditions = append(conditions, "c.board_id = ?")
			args = append(args, boardID)
		}
		if status != "" {
			conditions = append(conditions, "c.status = ?")
			args = append(args, status)
		}
		if len(conditions) > 0 {
			query += " WHERE " + joinConditions(conditions)
		}
		rows, err := s.db.Query(query, args...)
		if err == nil {
			defer func() { _ = rows.Close() }()
			for rows.Next() {
				var colID string
				if err := rows.Scan(&colID); err == nil {
					columnIDs = append(columnIDs, colID)
				}
			}
		}
	}

	if columnID != "" && len(columnIDs) == 0 {
		columnIDs = append(columnIDs, columnID)
	}

	tasks, total, err := s.taskRepo.GetTasksByColumnIDs(columnIDs, page, pageSize, includeDrafts, includeArchived)
	if err != nil {
		return nil, err
	}

	result := []gin.H{}
	for _, task := range tasks {
		commentCount := 0
		subtaskCount := 0
		if task.CommentCount != nil {
			commentCount = *task.CommentCount
		}
		if task.SubtaskCount != nil {
			subtaskCount = *task.SubtaskCount
		}

		result = append(result, gin.H{
			"id":          task.ID,
			"title":       task.Title,
			"description": task.Description,
			"priority":    task.Priority,
			"assignee":    task.Assignee,
			"meta":        task.Meta,
			"columnId":    task.ColumnID,
			"position":    task.Position,
			"published":   task.Published,
			"archived":    task.Archived,
			"archivedAt":  task.ArchivedAt,
			"agentId":     task.AgentID,
			"agentPrompt": task.AgentPrompt,
			"createdBy":   task.CreatedBy,
			"createdAt":   task.CreatedAt,
			"updatedAt":   task.UpdatedAt,
			"_count": gin.H{
				"comments": commentCount,
				"subtasks": subtaskCount,
			},
		})
	}

	pageCount := total / pageSize
	if total%pageSize != 0 {
		pageCount++
	}

	return &TaskListResult{
		Tasks:     result,
		Total:     total,
		Page:      page,
		PageSize:  pageSize,
		PageCount: pageCount,
	}, nil
}

func (s *TaskService) GetTask(taskID, userID, role string) (*models.Task, int, int, error) {
	task, err := s.taskRepo.GetTaskByID(taskID)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, 0, 0, fmt.Errorf("task not found")
		}
		return nil, 0, 0, err
	}

	commentCount, _ := s.taskRepo.GetTaskCommentCount(task.ID)
	subtaskCount, _ := s.taskRepo.GetTaskSubtaskCount(task.ID)

	return task, commentCount, subtaskCount, nil
}

type CreateTaskInput struct {
	Title       string
	Description *string
	Priority    string
	Assignee    *string
	Meta        interface{}
	ColumnID    string
	Position    int
	Published   bool
	AgentID     *string
	AgentPrompt *string
	CreatedBy   string
}

func (s *TaskService) CreateTask(input CreateTaskInput) (*models.Task, error) {
	taskID, err := s.generateTaskID(input.ColumnID)
	if err != nil {
		return nil, fmt.Errorf("failed to generate task ID: %w", err)
	}

	now := time.Now()
	priority := input.Priority
	if priority == "" {
		priority = "medium"
	}

	position := input.Position
	if position == 0 {
		position, err = s.calculatePosition(input.ColumnID, priority)
		if err != nil {
			return nil, fmt.Errorf("failed to calculate position: %w", err)
		}
	}

	var metaStr *string
	if input.Meta != nil {
		metaJSON, _ := json.Marshal(input.Meta)
		s := string(metaJSON)
		metaStr = &s
	}

	task := &models.Task{
		ID:          taskID,
		Title:       input.Title,
		Description: input.Description,
		Priority:    priority,
		Assignee:    input.Assignee,
		Meta:        metaStr,
		ColumnID:    input.ColumnID,
		Position:    position,
		Published:   input.Published,
		Archived:    false,
		AgentID:     input.AgentID,
		AgentPrompt: input.AgentPrompt,
		CreatedBy:   input.CreatedBy,
		CreatedAt:   now,
		UpdatedAt:   now,
	}

	if err := s.taskRepo.CreateTask(task); err != nil {
		return nil, fmt.Errorf("failed to create task: %w", err)
	}

	return task, nil
}

type UpdateTaskInput struct {
	Title       string
	Description *string
	Priority    string
	Assignee    *string
	Meta        interface{}
	ColumnID    string
	Position    *int
	Published   *bool
	AgentID     *string
	AgentPrompt *string
}

type TaskChanges struct {
	Changes []string
}

func (s *TaskService) UpdateTask(taskID string, userID, role string, input UpdateTaskInput) (*models.Task, *TaskChanges, error) {
	oldTask, err := s.taskRepo.GetTaskByID(taskID)
	if err != nil {
		return nil, nil, fmt.Errorf("task not found")
	}

	var changes []string

	if input.Title != "" && input.Title != oldTask.Title {
		changes = append(changes, fmt.Sprintf("标题: '%s' → '%s'", oldTask.Title, input.Title))
	}
	if input.Description != nil {
		oldDesc := ""
		if oldTask.Description != nil {
			oldDesc = *oldTask.Description
		}
		if *input.Description != oldDesc {
			changes = append(changes, fmt.Sprintf("描述: '%s' → '%s'", oldDesc, *input.Description))
		}
	}
	if input.Priority != "" && input.Priority != oldTask.Priority {
		changes = append(changes, fmt.Sprintf("优先级: '%s' → '%s'", oldTask.Priority, input.Priority))
	}
	if input.Assignee != nil {
		oldAssignee := ""
		if oldTask.Assignee != nil {
			oldAssignee = *oldTask.Assignee
		}
		if *input.Assignee != oldAssignee {
			changes = append(changes, fmt.Sprintf("负责人: '%s' → '%s'", oldAssignee, *input.Assignee))
		}
	}
	if input.Meta != nil {
		oldMeta := ""
		if oldTask.Meta != nil {
			oldMeta = *oldTask.Meta
		}
		newMeta, _ := json.Marshal(input.Meta)
		if string(newMeta) != oldMeta {
			changes = append(changes, fmt.Sprintf("元数据: '%s' → '%s'", oldMeta, string(newMeta)))
		}
	}
	if input.ColumnID != "" && input.ColumnID != oldTask.ColumnID {
		oldBoardID, err := s.getBoardIDForColumn(oldTask.ColumnID)
		if err != nil {
			return nil, nil, fmt.Errorf("failed to get board for current column")
		}
		newBoardID, err := s.getBoardIDForColumn(input.ColumnID)
		if err != nil {
			return nil, nil, fmt.Errorf("failed to get board for target column")
		}
		if oldBoardID != newBoardID {
			return nil, nil, fmt.Errorf("cannot move task to a column in a different board")
		}
		var oldStatus, newStatus sql.NullString
		_ = s.db.QueryRow("SELECT status FROM columns WHERE id = ?", oldTask.ColumnID).Scan(&oldStatus)
		_ = s.db.QueryRow("SELECT status FROM columns WHERE id = ?", input.ColumnID).Scan(&newStatus)
		oldStatusVal := ""
		if oldStatus.Valid {
			oldStatusVal = oldStatus.String
		}
		newStatusVal := ""
		if newStatus.Valid {
			newStatusVal = newStatus.String
		}
		if oldStatusVal != "" || newStatusVal != "" {
			changes = append(changes, fmt.Sprintf("状态: '%s' → '%s'", oldStatusVal, newStatusVal))
		}
	}
	if input.Position != nil && *input.Position != oldTask.Position {
		changes = append(changes, fmt.Sprintf("位置: %d → %d", oldTask.Position, *input.Position))
		targetColumnID := input.ColumnID
		if targetColumnID == "" {
			targetColumnID = oldTask.ColumnID
		}
		newPos := *input.Position
		oldPos := oldTask.Position
		isSameColumn := targetColumnID == oldTask.ColumnID
		if isSameColumn {
			if newPos < oldPos {
				_ = s.taskRepo.ShiftPositionsUp(targetColumnID, newPos, oldPos, taskID)
			} else if newPos > oldPos {
				_ = s.taskRepo.ShiftPositionsDown(targetColumnID, oldPos, newPos, taskID)
			}
		} else {
			_ = s.taskRepo.ShiftPositionsLeft(oldTask.ColumnID, oldPos)
			_ = s.taskRepo.ShiftPositionsRight(targetColumnID, newPos, taskID)
		}
	}
	if input.Published != nil && *input.Published != oldTask.Published {
		oldPub := "否"
		if oldTask.Published {
			oldPub = "是"
		}
		newPub := "否"
		if *input.Published {
			newPub = "是"
		}
		changes = append(changes, fmt.Sprintf("发布: %s → %s", oldPub, newPub))
	}
	if input.AgentID != nil {
		oldAgentID := ""
		if oldTask.AgentID != nil {
			oldAgentID = *oldTask.AgentID
		}
		if *input.AgentID != oldAgentID {
			changes = append(changes, fmt.Sprintf("Agent: '%s' → '%s'", oldAgentID, *input.AgentID))
		}
	}
	if input.AgentPrompt != nil {
		oldAgentPrompt := ""
		if oldTask.AgentPrompt != nil {
			oldAgentPrompt = *oldTask.AgentPrompt
		}
		if *input.AgentPrompt != oldAgentPrompt {
			changes = append(changes, fmt.Sprintf("Agent Prompt: '%s' → '%s'", oldAgentPrompt, *input.AgentPrompt))
		}
	}

	if input.Title != "" {
		oldTask.Title = input.Title
	}
	if input.Description != nil {
		oldTask.Description = input.Description
	}
	if input.Priority != "" {
		oldTask.Priority = input.Priority
	}
	if input.Assignee != nil {
		oldTask.Assignee = input.Assignee
	}
	if input.Meta != nil {
		metaJSON, _ := json.Marshal(input.Meta)
		s := string(metaJSON)
		oldTask.Meta = &s
	}
	if input.ColumnID != "" {
		oldTask.ColumnID = input.ColumnID
	}
	if input.Position != nil {
		oldTask.Position = *input.Position
	}
	if input.Published != nil {
		oldTask.Published = *input.Published
	}
	if input.AgentID != nil {
		oldTask.AgentID = input.AgentID
	}
	if input.AgentPrompt != nil {
		oldTask.AgentPrompt = input.AgentPrompt
	}

	if err := s.taskRepo.UpdateTask(oldTask); err != nil {
		return nil, nil, fmt.Errorf("failed to update task: %w", err)
	}

	return oldTask, &TaskChanges{Changes: changes}, nil
}

func (s *TaskService) DeleteTask(taskID string) error {
	return s.taskRepo.DeleteTask(taskID)
}

func (s *TaskService) ArchiveTask(taskID string, archived bool) (*models.Task, error) {
	task, err := s.taskRepo.GetTaskByID(taskID)
	if err != nil {
		return nil, err
	}

	task.Archived = archived
	if archived {
		now := time.Now()
		task.ArchivedAt = &now
	} else {
		task.ArchivedAt = nil
	}

	if err := s.taskRepo.UpdateTask(task); err != nil {
		return nil, err
	}

	return task, nil
}

func (s *TaskService) CompleteTask(taskID string) (*models.Task, error) {
	currentColumnID, err := s.taskRepo.GetColumnIDForTask(taskID)
	if err != nil {
		return nil, fmt.Errorf("failed to get task column: %w", err)
	}

	currentPosition, boardID, err := s.taskRepo.GetColumnPositionAndBoardID(currentColumnID)
	if err != nil {
		return nil, fmt.Errorf("failed to get column info: %w", err)
	}

	nextColumnID, err := s.taskRepo.GetNextColumn(boardID, currentPosition)
	if err != nil {
		return nil, fmt.Errorf("failed to get next column: %w", err)
	}

	if nextColumnID == "" {
		return nil, fmt.Errorf("task is already in the last column")
	}

	maxPos, err := s.taskRepo.GetMaxPosition(nextColumnID)
	if err != nil {
		return nil, fmt.Errorf("failed to get max position: %w", err)
	}

	if err := s.taskRepo.MoveTaskToColumn(taskID, nextColumnID, maxPos+1); err != nil {
		return nil, fmt.Errorf("failed to move task: %w", err)
	}

	return s.taskRepo.GetTaskByID(taskID)
}

func (s *TaskService) generateTaskID(columnID string) (string, error) {
	boardID, err := s.getBoardIDForColumn(columnID)
	if err != nil {
		return "", err
	}

	var shortAlias string
	err = s.db.QueryRow("SELECT COALESCE(short_alias, '') FROM boards WHERE id = ?", boardID).Scan(&shortAlias)
	if err != nil {
		return "", err
	}

	if shortAlias == "" {
		shortAlias = "T"
	}

	var counter int
	tx, err := s.db.Begin()
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback() }()

	err = tx.QueryRow("SELECT task_counter FROM boards WHERE id = ? FOR UPDATE", boardID).Scan(&counter)
	if err != nil {
		_ = tx.Rollback()
		tx, err = s.db.Begin()
		if err != nil {
			return "", err
		}
		defer func() { _ = tx.Rollback() }()
		err = tx.QueryRow("SELECT task_counter FROM boards WHERE id = ?", boardID).Scan(&counter)
		if err != nil {
			return "", err
		}
	}

	counter++
	_, err = tx.Exec("UPDATE boards SET task_counter = ? WHERE id = ?", counter, boardID)
	if err != nil {
		return "", err
	}

	err = tx.Commit()
	if err != nil {
		return "", err
	}

	digits := 4
	if counter >= 10000 {
		digits = 6
	}
	if counter >= 1000000 {
		digits = 8
	}

	return fmt.Sprintf("%s-%0*d", shortAlias, digits, counter), nil
}

func (s *TaskService) getBoardIDForColumn(columnID string) (string, error) {
	var boardID string
	err := s.db.QueryRow("SELECT board_id FROM columns WHERE id = ?", columnID).Scan(&boardID)
	return boardID, err
}

func (s *TaskService) calculatePosition(columnID, priority string) (int, error) {
	switch priority {
	case "high":
		maxHighPos, err := s.taskRepo.GetMaxPositionForPriority(columnID, "high")
		if err != nil && err != sql.ErrNoRows {
			return 0, err
		}
		if maxHighPos > 0 {
			return maxHighPos + 1000, nil
		}
		minMedPos, _ := s.taskRepo.GetMinPositionForMediumPriority(columnID)
		if minMedPos > 0 && minMedPos > 1000 {
			return minMedPos - 1000, nil
		}
		return 1000, nil
	case "medium":
		maxMedPos, err := s.taskRepo.GetMaxPositionForPriority(columnID, "medium")
		if err != nil && err != sql.ErrNoRows {
			return 0, err
		}
		if maxMedPos > 0 {
			return maxMedPos + 1000, nil
		}
		maxHighPos, _ := s.taskRepo.GetMaxPositionForPriority(columnID, "high")
		minLowPos, _ := s.taskRepo.GetMinPositionForLowPriority(columnID)
		if maxHighPos > 0 && minLowPos > 0 {
			return (maxHighPos + minLowPos) / 2, nil
		}
		if maxHighPos > 0 {
			return maxHighPos + 1000, nil
		}
		if minLowPos > 0 && minLowPos > 2000 {
			return minLowPos - 1000, nil
		}
		return 2000, nil
	case "low":
		maxPos, err := s.taskRepo.GetMaxPosition(columnID)
		if err != nil && err != sql.ErrNoRows {
			return 0, err
		}
		if maxPos > 0 {
			return maxPos + 1, nil
		}
		return 3000, nil
	default:
		return 3000, nil
	}
}

func (s *TaskService) TriggerAgentForTask(taskID, agentID, agentPrompt, taskTitle string) {
	if agentID == "" {
		return
	}

	slog.Info("Agent trigger task", "task_id", taskID, "task_title", taskTitle, "agent_id", agentID)

	go func() {
		payload := map[string]interface{}{
			"event":       "task.published",
			"taskId":      taskID,
			"agentId":     agentID,
			"agentPrompt": agentPrompt,
			"taskTitle":   taskTitle,
			"timestamp":   time.Now().UTC().Format(time.RFC3339),
		}

		payloadBytes, err := json.Marshal(payload)
		if err != nil {
			slog.Error("Agent trigger failed to marshal payload", "task_id", taskID, "error", err)
			return
		}

		slog.Info("Agent trigger payload", "task_id", taskID, "agent_id", agentID, "payload", string(payloadBytes))
	}()
}

type SearchTasksInput struct {
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

func (s *TaskService) SearchTasks(input SearchTasksInput) (*TaskListResult, error) {
	if input.Page <= 0 {
		input.Page = 1
	}
	if input.PageSize <= 0 {
		input.PageSize = 20
	}
	if input.PageSize > 100 {
		input.PageSize = 100
	}

	params := repositories.TaskSearchParams{
		Query:     input.Query,
		Priority:  input.Priority,
		Status:    input.Status,
		BoardID:   input.BoardID,
		Assignee:  input.Assignee,
		DateRange: input.DateRange,
		TaskID:    input.TaskID,
		Page:      input.Page,
		PageSize:  input.PageSize,
	}

	tasks, total, err := s.taskRepo.SearchTasks(params)
	if err != nil {
		return nil, err
	}

	result := []gin.H{}
	for _, task := range tasks {
		commentCount := 0
		subtaskCount := 0
		if task.CommentCount != nil {
			commentCount = *task.CommentCount
		}
		if task.SubtaskCount != nil {
			subtaskCount = *task.SubtaskCount
		}

		result = append(result, gin.H{
			"id":          task.ID,
			"title":       task.Title,
			"description": task.Description,
			"priority":    task.Priority,
			"assignee":    task.Assignee,
			"meta":        task.Meta,
			"columnId":    task.ColumnID,
			"position":    task.Position,
			"published":   task.Published,
			"archived":    task.Archived,
			"archivedAt":  task.ArchivedAt,
			"agentId":     task.AgentID,
			"agentPrompt": task.AgentPrompt,
			"createdBy":   task.CreatedBy,
			"createdAt":   task.CreatedAt,
			"updatedAt":   task.UpdatedAt,
			"_count": gin.H{
				"comments": commentCount,
				"subtasks": subtaskCount,
			},
		})
	}

	pageCount := total / input.PageSize
	if total%input.PageSize != 0 {
		pageCount++
	}

	return &TaskListResult{
		Tasks:     result,
		Total:     total,
		Page:      input.Page,
		PageSize:  input.PageSize,
		PageCount: pageCount,
	}, nil
}

func joinConditions(conditions []string) string {
	result := ""
	for i, c := range conditions {
		if i > 0 {
			result += " AND "
		}
		result += c
	}
	return result
}
