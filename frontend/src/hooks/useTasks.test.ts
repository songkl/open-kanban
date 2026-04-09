import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTasks } from './useTasks';
import type { Task, Column as ColumnType } from '@/types/kanban';

vi.mock('../services/api', () => ({
  tasksApi: {
    update: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
    archive: vi.fn().mockResolvedValue({}),
    create: vi.fn().mockResolvedValue({ id: 'new-task-id', title: 'New Task' }),
  },
  commentsApi: {
    create: vi.fn().mockResolvedValue({ id: 'comment-1', content: 'Test comment' }),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));

import { tasksApi, commentsApi } from '../services/api';

const mockTask: Task = {
  id: 'task-1',
  title: 'Test Task',
  description: 'Test Description',
  position: 0,
  priority: 'high',
  assignee: 'John',
  meta: null,
  columnId: 'col-1',
  archived: false,
  archivedAt: null,
  published: true,
  createdBy: 'user-1',
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  comments: [],
  subtasks: [],
};

const mockColumns: ColumnType[] = [
  {
    id: 'col-1',
    name: 'To Do',
    status: 'todo',
    position: 0,
    color: '#3b82f6',
    tasks: [mockTask],
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
  },
  {
    id: 'col-2',
    name: 'In Progress',
    status: 'in_progress',
    position: 1,
    color: '#f59e0b',
    tasks: [],
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
  },
];

describe('useTasks', () => {
  const mockOnColumnsChange = vi.fn();
  const mockCurrentBoard = { id: 'board-1', name: 'Test Board', createdAt: '2024-01-01', updatedAt: '2024-01-01' };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  describe('initial state', () => {
    it('should initialize with null activeTask', () => {
      const { result } = renderHook(() =>
        useTasks({ columns: mockColumns, currentBoard: mockCurrentBoard, onColumnsChange: mockOnColumnsChange })
      );
      expect(result.current.activeTask).toBeNull();
    });

    it('should initialize with null selectedTask', () => {
      const { result } = renderHook(() =>
        useTasks({ columns: mockColumns, currentBoard: mockCurrentBoard, onColumnsChange: mockOnColumnsChange })
      );
      expect(result.current.selectedTask).toBeNull();
    });

    it('should initialize with empty selectedTasks Set', () => {
      const { result } = renderHook(() =>
        useTasks({ columns: mockColumns, currentBoard: mockCurrentBoard, onColumnsChange: mockOnColumnsChange })
      );
      expect(result.current.selectedTasks.size).toBe(0);
    });
  });

  describe('setSelectedTask', () => {
    it('should set selected task', () => {
      const { result } = renderHook(() =>
        useTasks({ columns: mockColumns, currentBoard: mockCurrentBoard, onColumnsChange: mockOnColumnsChange })
      );
      act(() => {
        result.current.setSelectedTask(mockTask);
      });
      expect(result.current.selectedTask).toEqual(mockTask);
    });

    it('should clear selected task when set to null', () => {
      const { result } = renderHook(() =>
        useTasks({ columns: mockColumns, currentBoard: mockCurrentBoard, onColumnsChange: mockOnColumnsChange })
      );
      act(() => {
        result.current.setSelectedTask(mockTask);
      });
      expect(result.current.selectedTask).toEqual(mockTask);
      act(() => {
        result.current.setSelectedTask(null);
      });
      expect(result.current.selectedTask).toBeNull();
    });
  });

  describe('setActiveTask', () => {
    it('should set active task', () => {
      const { result } = renderHook(() =>
        useTasks({ columns: mockColumns, currentBoard: mockCurrentBoard, onColumnsChange: mockOnColumnsChange })
      );
      act(() => {
        result.current.setActiveTask(mockTask);
      });
      expect(result.current.activeTask).toEqual(mockTask);
    });

    it('should clear active task when set to null', () => {
      const { result } = renderHook(() =>
        useTasks({ columns: mockColumns, currentBoard: mockCurrentBoard, onColumnsChange: mockOnColumnsChange })
      );
      act(() => {
        result.current.setActiveTask(mockTask);
      });
      expect(result.current.activeTask).toEqual(mockTask);
      act(() => {
        result.current.setActiveTask(null);
      });
      expect(result.current.activeTask).toBeNull();
    });
  });

  describe('handleTaskSelect', () => {
    it('should select single task without modifier keys', () => {
      const { result } = renderHook(() =>
        useTasks({ columns: mockColumns, currentBoard: mockCurrentBoard, onColumnsChange: mockOnColumnsChange })
      );
      act(() => {
        result.current.handleTaskSelect('task-1', mockTask, {});
      });
      expect(result.current.selectedTasks).toEqual(new Set(['task-1']));
      expect(result.current.lastSelectedTaskId).toBe('task-1');
    });

    it('should add task to selection with Ctrl/Cmd key', () => {
      const { result } = renderHook(() =>
        useTasks({ columns: mockColumns, currentBoard: mockCurrentBoard, onColumnsChange: mockOnColumnsChange })
      );
      act(() => {
        result.current.handleTaskSelect('task-1', mockTask, { metaKey: true });
      });
      expect(result.current.selectedTasks).toEqual(new Set(['task-1']));
      act(() => {
        result.current.handleTaskSelect('task-2', { ...mockTask, id: 'task-2' }, { metaKey: true });
      });
      expect(result.current.selectedTasks).toEqual(new Set(['task-1', 'task-2']));
    });

    it('should remove task from selection with Ctrl/Cmd key when already selected', () => {
      const { result } = renderHook(() =>
        useTasks({ columns: mockColumns, currentBoard: mockCurrentBoard, onColumnsChange: mockOnColumnsChange })
      );
      act(() => {
        result.current.handleTaskSelect('task-1', mockTask, { metaKey: true });
        result.current.handleTaskSelect('task-2', { ...mockTask, id: 'task-2' }, { metaKey: true });
      });
      expect(result.current.selectedTasks).toEqual(new Set(['task-1', 'task-2']));
      act(() => {
        result.current.handleTaskSelect('task-1', mockTask, { metaKey: true });
      });
      expect(result.current.selectedTasks).toEqual(new Set(['task-2']));
    });

    it('should handle checkbox target', () => {
      const { result } = renderHook(() =>
        useTasks({ columns: mockColumns, currentBoard: mockCurrentBoard, onColumnsChange: mockOnColumnsChange })
      );
      act(() => {
        result.current.handleTaskSelect('task-1', mockTask, { target: { checked: true } });
      });
      expect(result.current.selectedTasks).toEqual(new Set(['task-1']));
      act(() => {
        result.current.handleTaskSelect('task-1', mockTask, { target: { checked: false } });
      });
      expect(result.current.selectedTasks).toEqual(new Set());
    });
  });

  describe('clearSelection', () => {
    it('should clear all selections', () => {
      const { result } = renderHook(() =>
        useTasks({ columns: mockColumns, currentBoard: mockCurrentBoard, onColumnsChange: mockOnColumnsChange })
      );
      act(() => {
        result.current.handleTaskSelect('task-1', mockTask, { metaKey: true });
        result.current.handleTaskSelect('task-2', { ...mockTask, id: 'task-2' }, { metaKey: true });
      });
      expect(result.current.selectedTasks.size).toBe(2);
      act(() => {
        result.current.clearSelection();
      });
      expect(result.current.selectedTasks.size).toBe(0);
      expect(result.current.lastSelectedTaskId).toBeNull();
    });
  });

  describe('updateTask', () => {
    it('should call tasksApi.update with correct parameters', async () => {
      const { result } = renderHook(() =>
        useTasks({ columns: mockColumns, currentBoard: mockCurrentBoard, onColumnsChange: mockOnColumnsChange })
      );
      const updatedTask = { ...mockTask, title: 'Updated Title' };
      await act(async () => {
        await result.current.updateTask(updatedTask);
      });
      expect(tasksApi.update).toHaveBeenCalledWith('task-1', {
        title: 'Updated Title',
        description: mockTask.description,
        priority: mockTask.priority,
        assignee: mockTask.assignee,
        columnId: mockTask.columnId,
        position: mockTask.position ?? 0,
        published: mockTask.published,
        meta: mockTask.meta,
      });
    });
  });

  describe('deleteTask', () => {
    it('should call tasksApi.delete with taskId', async () => {
      const { result } = renderHook(() =>
        useTasks({ columns: mockColumns, currentBoard: mockCurrentBoard, onColumnsChange: mockOnColumnsChange })
      );
      await act(async () => {
        await result.current.deleteTask('task-1');
      });
      expect(tasksApi.delete).toHaveBeenCalledWith('task-1');
    });

    it('should clear selected task after deletion', async () => {
      const { result } = renderHook(() =>
        useTasks({ columns: mockColumns, currentBoard: mockCurrentBoard, onColumnsChange: mockOnColumnsChange })
      );
      act(() => {
        result.current.setSelectedTask(mockTask);
      });
      expect(result.current.selectedTask).toEqual(mockTask);
      await act(async () => {
        await result.current.deleteTask('task-1');
      });
      expect(result.current.selectedTask).toBeNull();
    });
  });

  describe('archiveTask', () => {
    it('should call tasksApi.archive with taskId and true', async () => {
      const { result } = renderHook(() =>
        useTasks({ columns: mockColumns, currentBoard: mockCurrentBoard, onColumnsChange: mockOnColumnsChange })
      );
      await act(async () => {
        await result.current.archiveTask('task-1');
      });
      expect(tasksApi.archive).toHaveBeenCalledWith('task-1', true);
    });

    it('should clear selected task after archiving', async () => {
      const { result } = renderHook(() =>
        useTasks({ columns: mockColumns, currentBoard: mockCurrentBoard, onColumnsChange: mockOnColumnsChange })
      );
      act(() => {
        result.current.setSelectedTask(mockTask);
      });
      expect(result.current.selectedTask).toEqual(mockTask);
      await act(async () => {
        await result.current.archiveTask('task-1');
      });
      expect(result.current.selectedTask).toBeNull();
    });
  });

  describe('addComment', () => {
    it('should call commentsApi.create with correct parameters', async () => {
      const { result } = renderHook(() =>
        useTasks({ columns: mockColumns, currentBoard: mockCurrentBoard, onColumnsChange: mockOnColumnsChange })
      );
      await act(async () => {
        await result.current.addComment('task-1', 'Test comment content', 'TestAuthor');
      });
      expect(commentsApi.create).toHaveBeenCalledWith({
        taskId: 'task-1',
        content: 'Test comment content',
        author: 'TestAuthor',
      });
    });
  });

  describe('batchDelete', () => {
    it('should not call API when selectedTasks is empty', async () => {
      const { result } = renderHook(() =>
        useTasks({ columns: mockColumns, currentBoard: mockCurrentBoard, onColumnsChange: mockOnColumnsChange })
      );
      await act(async () => {
        await result.current.batchDelete();
      });
      expect(tasksApi.delete).not.toHaveBeenCalled();
    });

    it('should call delete for all selected tasks', async () => {
      const { result } = renderHook(() =>
        useTasks({ columns: mockColumns, currentBoard: mockCurrentBoard, onColumnsChange: mockOnColumnsChange })
      );
      act(() => {
        result.current.handleTaskSelect('task-1', mockTask, { metaKey: true });
        result.current.handleTaskSelect('task-2', { ...mockTask, id: 'task-2' }, { metaKey: true });
      });
      await act(async () => {
        await result.current.batchDelete();
      });
      expect(tasksApi.delete).toHaveBeenCalledTimes(2);
    });

    it('should clear selection after batch delete', async () => {
      const { result } = renderHook(() =>
        useTasks({ columns: mockColumns, currentBoard: mockCurrentBoard, onColumnsChange: mockOnColumnsChange })
      );
      act(() => {
        result.current.handleTaskSelect('task-1', mockTask, {});
      });
      expect(result.current.selectedTasks.size).toBe(1);
      await act(async () => {
        await result.current.batchDelete();
      });
      expect(result.current.selectedTasks.size).toBe(0);
    });
  });

  describe('batchArchive', () => {
    it('should not call API when selectedTasks is empty', async () => {
      const { result } = renderHook(() =>
        useTasks({ columns: mockColumns, currentBoard: mockCurrentBoard, onColumnsChange: mockOnColumnsChange })
      );
      await act(async () => {
        await result.current.batchArchive();
      });
      expect(tasksApi.archive).not.toHaveBeenCalled();
    });

    it('should call archive for all selected tasks', async () => {
      const { result } = renderHook(() =>
        useTasks({ columns: mockColumns, currentBoard: mockCurrentBoard, onColumnsChange: mockOnColumnsChange })
      );
      act(() => {
        result.current.handleTaskSelect('task-1', mockTask, { metaKey: true });
        result.current.handleTaskSelect('task-2', { ...mockTask, id: 'task-2' }, { metaKey: true });
      });
      await act(async () => {
        await result.current.batchArchive();
      });
      expect(tasksApi.archive).toHaveBeenCalledTimes(2);
    });
  });

  describe('batchMove', () => {
    it('should not call API when selectedTasks is empty', async () => {
      const { result } = renderHook(() =>
        useTasks({ columns: mockColumns, currentBoard: mockCurrentBoard, onColumnsChange: mockOnColumnsChange })
      );
      await act(async () => {
        await result.current.batchMove('col-2');
      });
      expect(tasksApi.update).not.toHaveBeenCalled();
    });

    it('should call update with new columnId for all selected tasks', async () => {
      const { result } = renderHook(() =>
        useTasks({ columns: mockColumns, currentBoard: mockCurrentBoard, onColumnsChange: mockOnColumnsChange })
      );
      act(() => {
        result.current.handleTaskSelect('task-1', mockTask, {});
      });
      await act(async () => {
        await result.current.batchMove('col-2');
      });
      expect(tasksApi.update).toHaveBeenCalledWith('task-1', { columnId: 'col-2' });
    });
  });

  describe('batchUpdatePriority', () => {
    it('should not call API when selectedTasks is empty', async () => {
      const { result } = renderHook(() =>
        useTasks({ columns: mockColumns, currentBoard: mockCurrentBoard, onColumnsChange: mockOnColumnsChange })
      );
      await act(async () => {
        await result.current.batchUpdatePriority('high');
      });
      expect(tasksApi.update).not.toHaveBeenCalled();
    });

    it('should call update with new priority for all selected tasks', async () => {
      const { result } = renderHook(() =>
        useTasks({ columns: mockColumns, currentBoard: mockCurrentBoard, onColumnsChange: mockOnColumnsChange })
      );
      act(() => {
        result.current.handleTaskSelect('task-1', mockTask, {});
      });
      await act(async () => {
        await result.current.batchUpdatePriority('high');
      });
      expect(tasksApi.update).toHaveBeenCalledWith('task-1', { priority: 'high' });
    });
  });

  describe('batchUpdateAssignee', () => {
    it('should not call API when selectedTasks is empty', async () => {
      const { result } = renderHook(() =>
        useTasks({ columns: mockColumns, currentBoard: mockCurrentBoard, onColumnsChange: mockOnColumnsChange })
      );
      await act(async () => {
        await result.current.batchUpdateAssignee('Alice');
      });
      expect(tasksApi.update).not.toHaveBeenCalled();
    });

    it('should call update with new assignee for all selected tasks', async () => {
      const { result } = renderHook(() =>
        useTasks({ columns: mockColumns, currentBoard: mockCurrentBoard, onColumnsChange: mockOnColumnsChange })
      );
      act(() => {
        result.current.handleTaskSelect('task-1', mockTask, {});
      });
      await act(async () => {
        await result.current.batchUpdateAssignee('Alice');
      });
      expect(tasksApi.update).toHaveBeenCalledWith('task-1', { assignee: 'Alice' });
    });

    it('should pass null when assignee is empty string', async () => {
      const { result } = renderHook(() =>
        useTasks({ columns: mockColumns, currentBoard: mockCurrentBoard, onColumnsChange: mockOnColumnsChange })
      );
      act(() => {
        result.current.handleTaskSelect('task-1', mockTask, {});
      });
      await act(async () => {
        await result.current.batchUpdateAssignee('');
      });
      expect(tasksApi.update).toHaveBeenCalledWith('task-1', { assignee: null });
    });
  });

  describe('selectAllInColumn', () => {
    it('should select all tasks in column when none are selected', () => {
      const { result } = renderHook(() =>
        useTasks({ columns: mockColumns, currentBoard: mockCurrentBoard, onColumnsChange: mockOnColumnsChange })
      );
      act(() => {
        result.current.selectAllInColumn('col-1', ['task-1', 'task-2']);
      });
      expect(result.current.selectedTasks).toEqual(new Set(['task-1', 'task-2']));
    });

    it('should deselect all tasks when all are already selected', () => {
      const { result } = renderHook(() =>
        useTasks({ columns: mockColumns, currentBoard: mockCurrentBoard, onColumnsChange: mockOnColumnsChange })
      );
      act(() => {
        result.current.handleTaskSelect('task-1', mockTask, { metaKey: true });
        result.current.handleTaskSelect('task-2', { ...mockTask, id: 'task-2' }, { metaKey: true });
      });
      expect(result.current.selectedTasks.size).toBe(2);
      act(() => {
        result.current.selectAllInColumn('col-1', ['task-1', 'task-2']);
      });
      expect(result.current.selectedTasks.size).toBe(0);
    });

    it('should do nothing when column does not exist', () => {
      const { result } = renderHook(() =>
        useTasks({ columns: mockColumns, currentBoard: mockCurrentBoard, onColumnsChange: mockOnColumnsChange })
      );
      act(() => {
        result.current.selectAllInColumn('nonexistent', ['task-1']);
      });
      expect(result.current.selectedTasks.size).toBe(0);
    });

    it('should do nothing when taskIds is empty', () => {
      const { result } = renderHook(() =>
        useTasks({ columns: mockColumns, currentBoard: mockCurrentBoard, onColumnsChange: mockOnColumnsChange })
      );
      act(() => {
        result.current.selectAllInColumn('col-1', []);
      });
      expect(result.current.selectedTasks.size).toBe(0);
    });
  });

  describe('handleTaskSelect with shift key', () => {
    it('should select range with shift key', () => {
      const allTasksColumns: typeof mockColumns = [
        {
          id: 'col-1',
          name: 'To Do',
          status: 'todo',
          position: 0,
          color: '#3b82f6',
          tasks: [
            { ...mockTask, id: 'task-1' },
            { ...mockTask, id: 'task-2' },
            { ...mockTask, id: 'task-3' },
          ],
          createdAt: '2024-01-01',
          updatedAt: '2024-01-01',
        },
      ];
      const { result } = renderHook(() =>
        useTasks({ columns: allTasksColumns, currentBoard: mockCurrentBoard, onColumnsChange: mockOnColumnsChange })
      );
      act(() => {
        result.current.handleTaskSelect('task-1', { ...mockTask, id: 'task-1' }, { shiftKey: true });
      });
      expect(result.current.selectedTasks).toEqual(new Set(['task-1']));
      act(() => {
        result.current.handleTaskSelect('task-3', { ...mockTask, id: 'task-3' }, { shiftKey: true });
      });
      expect(result.current.selectedTasks).toEqual(new Set(['task-1', 'task-2', 'task-3']));
    });
  });

  describe('ref access', () => {
    it('should provide access to lastLocalUpdateRef', () => {
      const { result } = renderHook(() =>
        useTasks({ columns: mockColumns, currentBoard: mockCurrentBoard, onColumnsChange: mockOnColumnsChange })
      );
      expect(result.current.lastLocalUpdateRef).toBeDefined();
      expect(typeof result.current.lastLocalUpdateRef.current).toBe('number');
    });

    it('should provide access to offlineQueueRef', () => {
      const { result } = renderHook(() =>
        useTasks({ columns: mockColumns, currentBoard: mockCurrentBoard, onColumnsChange: mockOnColumnsChange })
      );
      expect(result.current.offlineQueueRef).toBeDefined();
      expect(Array.isArray(result.current.offlineQueueRef.current)).toBe(true);
    });

    it('should provide access to isProcessingQueueRef', () => {
      const { result } = renderHook(() =>
        useTasks({ columns: mockColumns, currentBoard: mockCurrentBoard, onColumnsChange: mockOnColumnsChange })
      );
      expect(result.current.isProcessingQueueRef).toBeDefined();
      expect(typeof result.current.isProcessingQueueRef.current).toBe('boolean');
    });
  });
});
