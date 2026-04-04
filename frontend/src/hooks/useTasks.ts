import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { tasksApi, commentsApi } from '../services/api';
import { showErrorToast } from '../components/ErrorToast';
import type { Task, Column as ColumnType, Board } from '../types/kanban';

const FAILED_TASK_CREATIONS_KEY = 'failedTaskCreations';

export interface FailedTaskCreation {
  title: string;
  description: string;
  columnId: string;
  position: number;
  priority?: string;
  published: boolean;
  createdAt: string;
}

interface UseTasksOptions {
  columns: ColumnType[];
  currentBoard: Board | null;
  onColumnsChange: React.Dispatch<React.SetStateAction<ColumnType[]>>;
  onLastLocalUpdate: () => void;
}

interface UseTasksReturn {
  activeTask: Task | null;
  selectedTask: Task | null;
  selectedTasks: Set<string>;
  lastSelectedTaskId: string | null;
  updateTask: (task: Task) => Promise<void>;
  deleteTask: (taskId: string) => Promise<void>;
  archiveTask: (taskId: string) => Promise<void>;
  addTask: (columnId?: string, title?: string, description?: string, published?: boolean, boardId?: string, priority?: string) => Promise<void>;
  addComment: (taskId: string, content: string, author: string) => Promise<void>;
  handleTaskSelect: (taskId: string, task: Task, e?: any) => void;
  clearSelection: () => void;
  batchDelete: () => Promise<void>;
  batchArchive: () => Promise<void>;
  batchMove: (targetColumnId: string) => Promise<void>;
  batchUpdatePriority: (priority: string) => Promise<void>;
  batchUpdateAssignee: (assignee: string) => Promise<void>;
  setSelectedTask: (task: Task | null) => void;
  setActiveTask: (task: Task | null) => void;
}

const saveFailedTaskToLocalStorage = (taskData: FailedTaskCreation) => {
  try {
    const existing = localStorage.getItem(FAILED_TASK_CREATIONS_KEY);
    const failedTasks: FailedTaskCreation[] = existing ? JSON.parse(existing) : [];
    failedTasks.push(taskData);
    localStorage.setItem(FAILED_TASK_CREATIONS_KEY, JSON.stringify(failedTasks));
  } catch (e) {
    console.error('Failed to save task to localStorage:', e);
  }
};

export function useTasks({ columns, currentBoard, onColumnsChange, onLastLocalUpdate }: UseTasksOptions): UseTasksReturn {
  const { t } = useTranslation();

  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [selectedTasks, setSelectedTasks] = useState<Set<string>>(new Set());
  const [lastSelectedTaskId, setLastSelectedTaskId] = useState<string | null>(null);

  const updateTask = useCallback(async (task: Task) => {
    const targetColumnId = task.columnId;
    const targetBoardId = targetColumnId?.split('_')[0] || '';
    const isSameBoard = targetBoardId === (currentBoard?.id || '');

    try {
      const updated = await tasksApi.update(task.id, {
        title: task.title,
        description: task.description,
        priority: task.priority,
        assignee: task.assignee,
        columnId: task.columnId,
        position: task.position ?? 0,
        published: task.published,
        meta: task.meta,
      });

      const parsedUpdated = {
        ...updated,
        meta: typeof updated.meta === 'string' ? JSON.parse(updated.meta || '{}') : updated.meta || null,
      };

      if (isSameBoard) {
        onLastLocalUpdate();
        const oldColumnId = columns.find(col => col.tasks.some(t => t.id === task.id))?.id;

        if (oldColumnId && oldColumnId !== task.columnId) {
          onColumnsChange((cols) =>
            cols.map((col) => {
              if (col.id === oldColumnId) {
                return { ...col, tasks: col.tasks.filter((t) => t.id !== task.id) };
              }
              if (col.id === task.columnId) {
                return { ...col, tasks: [...col.tasks, parsedUpdated] };
              }
              return col;
            })
          );
        } else {
          onColumnsChange((cols) =>
            cols.map((col) => ({
              ...col,
              tasks: col.tasks.map((t) => (t.id === task.id ? parsedUpdated : t)),
            }))
          );
        }
        setSelectedTask(parsedUpdated);
      } else {
        const board = { name: 'unknown' };
        showErrorToast(t('board.taskPublished', { boardName: board.name }), 'info');
        setSelectedTask(null);
      }
    } catch (error) {
      console.error('Failed to update task:', error);
    }
  }, [columns, currentBoard?.id, t, onColumnsChange, onLastLocalUpdate]);

  const deleteTask = useCallback(async (taskId: string) => {
    onLastLocalUpdate();
    await tasksApi.delete(taskId);
    onColumnsChange((cols) =>
      cols.map((col) => ({
        ...col,
        tasks: col.tasks.filter((t) => t.id !== taskId),
      }))
    );
    setSelectedTask(null);
  }, [onColumnsChange, onLastLocalUpdate]);

  const archiveTask = useCallback(async (taskId: string) => {
    onLastLocalUpdate();
    await tasksApi.archive(taskId, true);
    onColumnsChange((cols) =>
      cols.map((col) => ({
        ...col,
        tasks: col.tasks.filter((t) => t.id !== taskId),
      }))
    );
    setSelectedTask(null);
  }, [onColumnsChange, onLastLocalUpdate]);

  const addTask = useCallback(async (columnId?: string, title?: string, description?: string, published?: boolean, boardId?: string, priority?: string) => {
    const taskTitle = title || prompt(t('task.enterTitle'));
    if (!taskTitle?.trim()) return;

    const targetColumnId = columnId || currentBoard?.id + '_todo';
    const targetBoardId = boardId || currentBoard?.id || '';
    const currentBoardId = currentBoard?.id || '';
    const isSameBoard = targetBoardId === currentBoardId;

    try {
      const newTask = await tasksApi.create({
        title: taskTitle.trim(),
        description: description || '',
        columnId: targetColumnId,
        position: 9999,
        published: published ?? true,
        priority: priority || 'medium',
      });

      if (isSameBoard) {
        onLastLocalUpdate();
        onColumnsChange((cols) =>
          cols.map((col) =>
            col.id === targetColumnId
              ? { ...col, tasks: [{ ...newTask, comments: [], subtasks: [] }, ...col.tasks] }
              : col
          )
        );
      } else {
        const board = { name: 'unknown' };
        showErrorToast(t('board.taskCreated', { boardName: board.name }), 'info');
      }
    } catch (error) {
      console.error('Failed to create task:', error);
      saveFailedTaskToLocalStorage({
        title: taskTitle.trim(),
        description: description || '',
        columnId: targetColumnId,
        position: 9999,
        priority: priority || 'medium',
        published: published ?? true,
        createdAt: new Date().toISOString(),
      });
    }
  }, [currentBoard?.id, t, onColumnsChange, onLastLocalUpdate]);

  const addComment = useCallback(async (taskId: string, content: string, author: string) => {
    try {
      onLastLocalUpdate();
      const comment = await commentsApi.create({ taskId, content, author });
      onColumnsChange((cols) =>
        cols.map((col) => ({
          ...col,
          tasks: col.tasks.map((t) =>
            t.id === taskId ? { ...t, comments: [...(t.comments ?? []), comment] } : t
          ),
        }))
      );
      if (selectedTask?.id === taskId) {
        setSelectedTask({ ...selectedTask, comments: [...(selectedTask.comments ?? []), comment] });
      }
    } catch (error) {
      console.error('Failed to add comment:', error);
    }
  }, [selectedTask, onColumnsChange, onLastLocalUpdate]);

  const handleTaskSelect = useCallback((taskId: string, _task: Task, e?: any) => {
    if (e?.shiftKey && lastSelectedTaskId) {
      const allTasks = columns.flatMap(col => col.tasks || []);
      const lastIndex = allTasks.findIndex(t => t.id === lastSelectedTaskId);
      const currentIndex = allTasks.findIndex(t => t.id === taskId);
      if (lastIndex !== -1 && currentIndex !== -1) {
        const start = Math.min(lastIndex, currentIndex);
        const end = Math.max(lastIndex, currentIndex);
        const rangeIds = allTasks.slice(start, end + 1).map(t => t.id);
        setSelectedTasks(prev => {
          const newSet = new Set(prev);
          rangeIds.forEach(id => newSet.add(id));
          return newSet;
        });
        setLastSelectedTaskId(taskId);
        return;
      }
    }
    
    if (e?.target?.checked !== undefined) {
      setSelectedTasks(prev => {
        const newSet = new Set(prev);
        if (e.target.checked) {
          newSet.add(taskId);
        } else {
          newSet.delete(taskId);
        }
        return newSet;
      });
    } else if (e?.metaKey || e?.ctrlKey) {
      setSelectedTasks(prev => {
        const newSet = new Set(prev);
        if (newSet.has(taskId)) {
          newSet.delete(taskId);
        } else {
          newSet.add(taskId);
        }
        return newSet;
      });
    } else {
      setSelectedTasks(new Set([taskId]));
    }
    setLastSelectedTaskId(taskId);
  }, [lastSelectedTaskId, columns]);

  const clearSelection = useCallback(() => {
    setSelectedTasks(new Set());
    setLastSelectedTaskId(null);
  }, []);

  const batchDelete = useCallback(async () => {
    if (selectedTasks.size === 0) return;

    try {
      onLastLocalUpdate();
      await Promise.all(Array.from(selectedTasks).map(id => tasksApi.delete(id)));
      onColumnsChange(cols => cols.map(col => ({
        ...col,
        tasks: col.tasks.filter(t => !selectedTasks.has(t.id))
      })));
      clearSelection();
    } catch (error) {
      console.error('Failed to batch delete:', error);
    }
  }, [selectedTasks, clearSelection, onColumnsChange, onLastLocalUpdate]);

  const batchArchive = useCallback(async () => {
    if (selectedTasks.size === 0) return;

    try {
      onLastLocalUpdate();
      await Promise.all(Array.from(selectedTasks).map(id => tasksApi.archive(id, true)));
      onColumnsChange(cols => cols.map(col => ({
        ...col,
        tasks: col.tasks.filter(t => !selectedTasks.has(t.id))
      })));
      clearSelection();
    } catch (error) {
      console.error('Failed to batch archive:', error);
    }
  }, [selectedTasks, clearSelection, onColumnsChange, onLastLocalUpdate]);

  const batchMove = useCallback(async (targetColumnId: string) => {
    if (selectedTasks.size === 0) return;

    try {
      onLastLocalUpdate();
      await Promise.all(Array.from(selectedTasks).map(id => tasksApi.update(id, { columnId: targetColumnId })));
      const tasksToMove = columns.flatMap(col => col.tasks).filter(t => selectedTasks.has(t.id));
      
      onColumnsChange(cols => cols.map(col => {
        if (col.id === targetColumnId) {
          return { ...col, tasks: [...col.tasks.filter(t => !selectedTasks.has(t.id)), ...tasksToMove.map(t => ({ ...t, columnId: targetColumnId }))] };
        }
        return { ...col, tasks: col.tasks.filter(t => !selectedTasks.has(t.id)) };
      }));
      clearSelection();
    } catch (error) {
      console.error('Failed to batch move:', error);
    }
  }, [selectedTasks, columns, clearSelection, onColumnsChange, onLastLocalUpdate]);

  const batchUpdatePriority = useCallback(async (priority: string) => {
    if (selectedTasks.size === 0) return;

    try {
      onLastLocalUpdate();
      await Promise.all(Array.from(selectedTasks).map(id => tasksApi.update(id, { priority })));
      onColumnsChange(cols => cols.map(col => ({
        ...col,
        tasks: col.tasks.map(t => selectedTasks.has(t.id) ? { ...t, priority } : t)
      })));
      clearSelection();
    } catch (error) {
      console.error('Failed to batch update priority:', error);
    }
  }, [selectedTasks, clearSelection, onColumnsChange, onLastLocalUpdate]);

  const batchUpdateAssignee = useCallback(async (assignee: string) => {
    if (selectedTasks.size === 0) return;

    try {
      onLastLocalUpdate();
      await Promise.all(Array.from(selectedTasks).map(id => tasksApi.update(id, { assignee: assignee || null })));
      onColumnsChange(cols => cols.map(col => ({
        ...col,
        tasks: col.tasks.map(t => selectedTasks.has(t.id) ? { ...t, assignee: assignee || null } : t)
      })));
      clearSelection();
    } catch (error) {
      console.error('Failed to batch update assignee:', error);
    }
  }, [selectedTasks, clearSelection, onColumnsChange, onLastLocalUpdate]);

  return {
    activeTask,
    selectedTask,
    selectedTasks,
    lastSelectedTaskId,
    updateTask,
    deleteTask,
    archiveTask,
    addTask,
    addComment,
    handleTaskSelect,
    clearSelection,
    batchDelete,
    batchArchive,
    batchMove,
    batchUpdatePriority,
    batchUpdateAssignee,
    setSelectedTask,
    setActiveTask,
  };
}