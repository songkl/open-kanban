import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useBoardRefresh } from './useBoardRefresh';
import type { Column as ColumnType } from '@/types/kanban';

const mockTasksApiUpdate = vi.fn();
const mockTasksApiDelete = vi.fn();
const mockTasksApiArchive = vi.fn();
const mockTasksApiCreate = vi.fn();
const mockTasksApiGetById = vi.fn();

vi.mock('../services/api', () => ({
  tasksApi: {
    getById: (...args: unknown[]) => mockTasksApiGetById(...args),
    update: (...args: unknown[]) => mockTasksApiUpdate(...args),
    delete: (...args: unknown[]) => mockTasksApiDelete(...args),
    archive: (...args: unknown[]) => mockTasksApiArchive(...args),
    create: (...args: unknown[]) => mockTasksApiCreate(...args),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const mockTask = {
  id: 'task-1',
  title: 'Test Task',
  description: '',
  position: 0,
  priority: 'high' as const,
  assignee: null,
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

describe('useBoardRefresh', () => {
  const mockOnColumnsChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockOnColumnsChange.mockClear();
    mockTasksApiUpdate.mockReset();
    mockTasksApiDelete.mockReset();
    mockTasksApiArchive.mockReset();
    mockTasksApiCreate.mockReset();
    mockTasksApiGetById.mockReset();
  });

  describe('initial state', () => {
    it('should initialize lastLocalUpdateRef with 0', () => {
      const { result } = renderHook(() =>
        useBoardRefresh({ columns: mockColumns, onColumnsChange: mockOnColumnsChange })
      );
      expect(result.current.lastLocalUpdateRef.current).toBe(0);
    });

    it('should initialize offlineQueueRef with empty array', () => {
      const { result } = renderHook(() =>
        useBoardRefresh({ columns: mockColumns, onColumnsChange: mockOnColumnsChange })
      );
      expect(result.current.offlineQueueRef.current).toEqual([]);
    });

    it('should initialize isProcessingQueueRef with false', () => {
      const { result } = renderHook(() =>
        useBoardRefresh({ columns: mockColumns, onColumnsChange: mockOnColumnsChange })
      );
      expect(result.current.isProcessingQueueRef.current).toBe(false);
    });
  });

  describe('processOfflineQueue', () => {
    it('should not process when queue is empty', async () => {
      const { result } = renderHook(() =>
        useBoardRefresh({ columns: mockColumns, onColumnsChange: mockOnColumnsChange })
      );
      await act(async () => {
        await result.current.processOfflineQueue();
      });
      expect(mockTasksApiUpdate).not.toHaveBeenCalled();
      expect(mockTasksApiDelete).not.toHaveBeenCalled();
    });

    it('should process updateTask action', async () => {
      mockTasksApiUpdate.mockResolvedValue({});
      const { result } = renderHook(() =>
        useBoardRefresh({ columns: mockColumns, onColumnsChange: mockOnColumnsChange })
      );
      result.current.offlineQueueRef.current = [
        { action: 'updateTask', data: { id: 'task-1', title: 'Updated' }, timestamp: Date.now() },
      ];
      await act(async () => {
        await result.current.processOfflineQueue();
      });
      expect(mockTasksApiUpdate).toHaveBeenCalledWith('task-1', { id: 'task-1', title: 'Updated' });
    });

    it('should process deleteTask action', async () => {
      mockTasksApiDelete.mockResolvedValue({});
      const { result } = renderHook(() =>
        useBoardRefresh({ columns: mockColumns, onColumnsChange: mockOnColumnsChange })
      );
      result.current.offlineQueueRef.current = [
        { action: 'deleteTask', data: { id: 'task-1' }, timestamp: Date.now() },
      ];
      await act(async () => {
        await result.current.processOfflineQueue();
      });
      expect(mockTasksApiDelete).toHaveBeenCalledWith('task-1');
    });

    it('should process archiveTask action', async () => {
      mockTasksApiArchive.mockResolvedValue({});
      const { result } = renderHook(() =>
        useBoardRefresh({ columns: mockColumns, onColumnsChange: mockOnColumnsChange })
      );
      result.current.offlineQueueRef.current = [
        { action: 'archiveTask', data: { id: 'task-1' }, timestamp: Date.now() },
      ];
      await act(async () => {
        await result.current.processOfflineQueue();
      });
      expect(mockTasksApiArchive).toHaveBeenCalledWith('task-1', true);
    });

    it('should process addTask action', async () => {
      mockTasksApiCreate.mockResolvedValue({ id: 'new-task' });
      const { result } = renderHook(() =>
        useBoardRefresh({ columns: mockColumns, onColumnsChange: mockOnColumnsChange })
      );
      result.current.offlineQueueRef.current = [
        { action: 'addTask', data: { title: 'New Task', columnId: 'col-1' }, timestamp: Date.now() },
      ];
      await act(async () => {
        await result.current.processOfflineQueue();
      });
      expect(mockTasksApiCreate).toHaveBeenCalledWith({ title: 'New Task', columnId: 'col-1' });
    });

    it('should clear queue after processing', async () => {
      mockTasksApiUpdate.mockResolvedValue({});
      const { result } = renderHook(() =>
        useBoardRefresh({ columns: mockColumns, onColumnsChange: mockOnColumnsChange })
      );
      result.current.offlineQueueRef.current = [
        { action: 'updateTask', data: { id: 'task-1' }, timestamp: Date.now() },
      ];
      await act(async () => {
        await result.current.processOfflineQueue();
      });
      expect(result.current.offlineQueueRef.current).toEqual([]);
    });

    it('should not process while already processing', async () => {
      const { result } = renderHook(() =>
        useBoardRefresh({ columns: mockColumns, onColumnsChange: mockOnColumnsChange })
      );
      result.current.isProcessingQueueRef.current = true;
      result.current.offlineQueueRef.current = [
        { action: 'updateTask', data: { id: 'task-1' }, timestamp: Date.now() },
      ];
      await act(async () => {
        await result.current.processOfflineQueue();
      });
      expect(mockTasksApiUpdate).not.toHaveBeenCalled();
    });

    it('should re-queue failed actions', async () => {
      mockTasksApiUpdate.mockRejectedValue(new Error('Network error'));
      const { result } = renderHook(() =>
        useBoardRefresh({ columns: mockColumns, onColumnsChange: mockOnColumnsChange })
      );
      const failedItem = { action: 'updateTask', data: { id: 'task-1' }, timestamp: Date.now() };
      result.current.offlineQueueRef.current = [failedItem];
      await act(async () => {
        await result.current.processOfflineQueue();
      });
      expect(result.current.offlineQueueRef.current).toContainEqual(failedItem);
    });
  });

  describe('handleTaskNotificationUpdate', () => {
    it('should do nothing when task not found', async () => {
      mockTasksApiGetById.mockResolvedValue(null);
      const { result } = renderHook(() =>
        useBoardRefresh({ columns: mockColumns, onColumnsChange: mockOnColumnsChange })
      );
      await act(async () => {
        await result.current.handleTaskNotificationUpdate('nonexistent');
      });
      expect(mockOnColumnsChange).not.toHaveBeenCalled();
    });

    it('should update task in same column', async () => {
      const updatedTask = { ...mockTask, title: 'Updated Title', meta: '{}' };
      mockTasksApiGetById.mockResolvedValue(updatedTask);
      const { result } = renderHook(() =>
        useBoardRefresh({ columns: mockColumns, onColumnsChange: mockOnColumnsChange })
      );
      await act(async () => {
        await result.current.handleTaskNotificationUpdate('task-1');
      });
      expect(mockOnColumnsChange).toHaveBeenCalled();
    });

    it('should move task to different column when column changes', async () => {
      const movedTask = { ...mockTask, columnId: 'col-2', meta: '{}' };
      mockTasksApiGetById.mockResolvedValue(movedTask);
      const { result } = renderHook(() =>
        useBoardRefresh({ columns: mockColumns, onColumnsChange: mockOnColumnsChange })
      );
      await act(async () => {
        await result.current.handleTaskNotificationUpdate('task-1');
      });
      expect(mockOnColumnsChange).toHaveBeenCalled();
    });

    it('should handle task without old column but in current columns', async () => {
      const newTask = { ...mockTask, id: 'new-task', columnId: 'col-1', meta: '{}' };
      mockTasksApiGetById.mockResolvedValue(newTask);
      const columnsWithNewTask: ColumnType[] = [
        {
          ...mockColumns[0],
          tasks: [],
        },
        {
          ...mockColumns[1],
          tasks: [],
        },
      ];
      const { result } = renderHook(() =>
        useBoardRefresh({ columns: columnsWithNewTask, onColumnsChange: mockOnColumnsChange })
      );
      await act(async () => {
        await result.current.handleTaskNotificationUpdate('new-task');
      });
      expect(mockOnColumnsChange).toHaveBeenCalled();
    });

    it('should parse string meta to object', async () => {
      const taskWithStringMeta = { ...mockTask, meta: '{"key":"value"}' };
      mockTasksApiGetById.mockResolvedValue(taskWithStringMeta);
      const { result } = renderHook(() =>
        useBoardRefresh({ columns: mockColumns, onColumnsChange: mockOnColumnsChange })
      );
      await act(async () => {
        await result.current.handleTaskNotificationUpdate('task-1');
      });
      expect(mockOnColumnsChange).toHaveBeenCalled();
    });

    it('should handle errors gracefully', async () => {
      mockTasksApiGetById.mockRejectedValue(new Error('API Error'));
      const { result } = renderHook(() =>
        useBoardRefresh({ columns: mockColumns, onColumnsChange: mockOnColumnsChange })
      );
      await act(async () => {
        await result.current.handleTaskNotificationUpdate('task-1');
      });
      expect(mockOnColumnsChange).not.toHaveBeenCalled();
    });
  });
});