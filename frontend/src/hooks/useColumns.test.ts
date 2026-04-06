import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useColumns } from './useColumns';
import { columnsApi, tasksApi } from '../services/api';
import type { Column as ColumnType } from '../types/kanban';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('../services/api', () => ({
  columnsApi: {
    getByBoard: vi.fn(),
    update: vi.fn(),
  },
  tasksApi: {
    getByColumn: vi.fn(),
  },
}));

const mockColumn: ColumnType = {
  id: 'col-1',
  name: 'To Do',
  status: 'todo',
  position: 0,
  color: '#3b82f6',
  tasks: [],
  createdAt: '2024-01-01',
  updatedAt: '2024-01-01',
  boardId: 'board-1',
};

const mockTask = {
  id: 'task-1',
  title: 'Test Task',
  description: '',
  position: 0,
  priority: 'medium',
  published: true,
  createdAt: '2024-01-01',
  updatedAt: '2024-01-01',
  columnId: 'col-1',
  comments: [],
  subtasks: [],
};

describe('useColumns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('returns correct initial state', () => {
      const { result } = renderHook(() => useColumns());
      expect(result.current.columns).toEqual([]);
      expect(result.current.columnPagination).toEqual({});
      expect(result.current.loading).toBe(false);
      expect(result.current.boardSwitching).toBe(false);
      expect(result.current.loadError).toBeNull();
    });
  });

  describe('fetchColumns', () => {
    it('fetches columns successfully', async () => {
      const mockColumns = [{ ...mockColumn, tasks: [] }];
      vi.mocked(columnsApi.getByBoard).mockResolvedValue(mockColumns);

      const { result } = renderHook(() => useColumns());

      await act(async () => {
        await result.current.fetchColumns('board-1');
      });

      expect(columnsApi.getByBoard).toHaveBeenCalledWith('board-1');
      expect(result.current.columns).toEqual(mockColumns);
      expect(result.current.loading).toBe(false);
      expect(result.current.loadError).toBeNull();
      expect(result.current.columnPagination).toEqual({});
    });

    it('handles fetch columns error', async () => {
      vi.mocked(columnsApi.getByBoard).mockRejectedValue(new Error('Failed to fetch'));

      const { result } = renderHook(() => useColumns());

      await act(async () => {
        await result.current.fetchColumns('board-1');
      });

      expect(result.current.loadError).toBe('Failed to fetch');
      expect(result.current.columns).toEqual([]);
    });

    it('normalizes tasks with empty comments and subtasks arrays', async () => {
      const columnWithNullArrays = {
        ...mockColumn,
        tasks: [{ ...mockTask, comments: null, subtasks: null }],
      };
      vi.mocked(columnsApi.getByBoard).mockResolvedValue([columnWithNullArrays]);

      const { result } = renderHook(() => useColumns());

      await act(async () => {
        await result.current.fetchColumns('board-1');
      });

      expect(result.current.columns[0].tasks[0].comments).toEqual([]);
      expect(result.current.columns[0].tasks[0].subtasks).toEqual([]);
    });

    it('resets pagination when fetching new board', async () => {
      const mockColumns = [{ ...mockColumn, tasks: [mockTask] }];
      vi.mocked(columnsApi.getByBoard).mockResolvedValue(mockColumns);

      const { result } = renderHook(() => useColumns());

      await act(async () => {
        await result.current.fetchColumns('board-1');
      });

      expect(result.current.columnPagination).toEqual({});
    });
  });

  describe('handleLoadMoreTasks', () => {
    it('loads more tasks successfully', async () => {
      const initialColumns = [{ ...mockColumn, tasks: [mockTask] }];
      vi.mocked(columnsApi.getByBoard).mockResolvedValue(initialColumns);
      vi.mocked(tasksApi.getByColumn).mockResolvedValue({
        data: [{ ...mockTask, id: 'task-2', title: 'New Task' }],
        total: 2,
        page: 2,
        pageSize: 20,
        pageCount: 1,
      });

      const { result } = renderHook(() => useColumns());

      await act(async () => {
        await result.current.fetchColumns('board-1');
      });

      await act(async () => {
        await result.current.handleLoadMoreTasks('col-1');
      });

      expect(tasksApi.getByColumn).toHaveBeenCalledWith('col-1', 2, 20);
      expect(result.current.columns[0].tasks).toHaveLength(2);
      expect(result.current.columns[0].tasks[1].title).toBe('New Task');
    });

    it('does not load more when already loading', async () => {
      const { result } = renderHook(() => useColumns());

      await act(async () => {
        await result.current.setColumnPagination({
          'col-1': { page: 1, hasMore: true, isLoadingMore: true },
        });
      });

      await act(async () => {
        await result.current.handleLoadMoreTasks('col-1');
      });

      expect(tasksApi.getByColumn).not.toHaveBeenCalled();
    });

    it('does not load more when hasMore is false', async () => {
      const { result } = renderHook(() => useColumns());

      await act(async () => {
        await result.current.setColumnPagination({
          'col-1': { page: 1, hasMore: false, isLoadingMore: false },
        });
      });

      await act(async () => {
        await result.current.handleLoadMoreTasks('col-1');
      });

      expect(tasksApi.getByColumn).not.toHaveBeenCalled();
    });

    it('handles load more error gracefully', async () => {
      const { result } = renderHook(() => useColumns());

      await act(async () => {
        await result.current.setColumnPagination({
          'col-1': { page: 1, hasMore: true, isLoadingMore: false },
        });
      });

      vi.mocked(tasksApi.getByColumn).mockRejectedValue(new Error('Failed to load'));

      await act(async () => {
        await result.current.handleLoadMoreTasks('col-1');
      });

      expect(result.current.columnPagination['col-1'].isLoadingMore).toBe(false);
    });

    it('prevents duplicate tasks when loading more', async () => {
      const existingTask = { ...mockTask, id: 'task-1' };
      const initialColumns = [{ ...mockColumn, tasks: [existingTask] }];
      vi.mocked(columnsApi.getByBoard).mockResolvedValue(initialColumns);
      vi.mocked(tasksApi.getByColumn).mockResolvedValue({
        data: [
          { ...mockTask, id: 'task-1' },
          { ...mockTask, id: 'task-2' },
        ],
        total: 2,
        page: 2,
        pageSize: 20,
        pageCount: 1,
      });

      const { result } = renderHook(() => useColumns());

      await act(async () => {
        await result.current.fetchColumns('board-1');
      });

      await act(async () => {
        await result.current.handleLoadMoreTasks('col-1');
      });

      expect(result.current.columns[0].tasks).toHaveLength(2);
      const taskIds = result.current.columns[0].tasks.map(t => t.id);
      expect(taskIds).toEqual(['task-1', 'task-2']);
    });
  });

  describe('handleColumnRename', () => {
    it('renames column successfully', async () => {
      const initialColumns = [{ ...mockColumn, tasks: [] }];
      vi.mocked(columnsApi.getByBoard).mockResolvedValue(initialColumns);
      vi.mocked(columnsApi.update).mockResolvedValue({ ...mockColumn, name: 'New Name' });

      const { result } = renderHook(() => useColumns());

      await act(async () => {
        await result.current.fetchColumns('board-1');
      });

      await act(async () => {
        await result.current.handleColumnRename('col-1', 'New Name');
      });

      expect(columnsApi.update).toHaveBeenCalledWith('col-1', { name: 'New Name' });
      expect(result.current.columns[0].name).toBe('New Name');
    });

    it('handles rename error gracefully', async () => {
      const initialColumns = [{ ...mockColumn, tasks: [] }];
      vi.mocked(columnsApi.getByBoard).mockResolvedValue(initialColumns);
      vi.mocked(columnsApi.update).mockRejectedValue(new Error('Failed to rename'));

      const { result } = renderHook(() => useColumns());

      await act(async () => {
        await result.current.fetchColumns('board-1');
      });

      const originalName = result.current.columns[0].name;

      await act(async () => {
        await result.current.handleColumnRename('col-1', 'New Name');
      });

      expect(result.current.columns[0].name).toBe(originalName);
    });

    it('only updates the specified column', async () => {
      const initialColumns = [
        { ...mockColumn, id: 'col-1', tasks: [] },
        { ...mockColumn, id: 'col-2', name: 'Other', tasks: [] },
      ];
      vi.mocked(columnsApi.getByBoard).mockResolvedValue(initialColumns);
      vi.mocked(columnsApi.update).mockResolvedValue({ ...mockColumn, name: 'Renamed' });

      const { result } = renderHook(() => useColumns());

      await act(async () => {
        await result.current.fetchColumns('board-1');
      });

      await act(async () => {
        await result.current.handleColumnRename('col-1', 'Renamed');
      });

      expect(result.current.columns[0].name).toBe('Renamed');
      expect(result.current.columns[1].name).toBe('Other');
    });
  });

  describe('setColumns', () => {
    it('allows direct column state update', async () => {
      const { result } = renderHook(() => useColumns());

      const newColumns = [{ ...mockColumn, name: 'Updated', tasks: [] }];

      await act(async () => {
        result.current.setColumns(newColumns);
      });

      expect(result.current.columns).toEqual(newColumns);
    });
  });

  describe('setColumnPagination', () => {
    it('allows direct pagination state update', async () => {
      const { result } = renderHook(() => useColumns());

      await act(async () => {
        result.current.setColumnPagination({
          'col-1': { page: 1, hasMore: true, isLoadingMore: false },
        });
      });

      expect(result.current.columnPagination['col-1']).toEqual({
        page: 1,
        hasMore: true,
        isLoadingMore: false,
      });
    });
  });
});
