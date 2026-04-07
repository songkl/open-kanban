import { create } from 'zustand';
import type { Column as ColumnType, Task } from '../types/kanban';
import { columnsApi, tasksApi } from '../services/api';

interface ColumnPagination {
  page: number;
  hasMore: boolean;
  isLoadingMore: boolean;
}

interface ColumnState {
  columns: ColumnType[];
  columnPagination: Record<string, ColumnPagination>;
  loading: boolean;
  loadError: string | null;

  setColumns: (columns: ColumnType[]) => void;
  setColumnPagination: (pagination: Record<string, ColumnPagination>) => void;
  updateColumnPagination: (columnId: string, pagination: ColumnPagination) => void;
  fetchColumns: (boardId: string, silent?: boolean) => Promise<void>;

  addTaskToColumn: (columnId: string, task: Task) => void;
  updateTaskInColumn: (taskId: string, task: Task) => void;
  removeTaskFromColumn: (taskId: string) => void;
  moveTask: (taskId: string, fromColumnId: string, toColumnId: string, newIndex: number) => void;
  reorderTasks: (columnId: string, oldIndex: number, newIndex: number) => Promise<void>;
  loadMoreTasks: (columnId: string) => Promise<void>;
}

export const useColumnStore = create<ColumnState>((set, get) => ({
  columns: [],
  columnPagination: {},
  loading: true,
  loadError: null,

  setColumns: (columns) => set({ columns }),
  setColumnPagination: (pagination) => set({ columnPagination: pagination }),
  updateColumnPagination: (columnId, pagination) => set((state) => ({
    columnPagination: { ...state.columnPagination, [columnId]: pagination }
  })),

  fetchColumns: async (boardId: string, silent = false) => {
    if (!silent) {
      set({ loading: true, loadError: null });
    }
    try {
      const data = await columnsApi.getByBoard(boardId);
      set({
        columns: data.map(col => ({
          ...col,
          tasks: col.tasks?.map(t => ({
            ...t,
            comments: t.comments ?? [],
            subtasks: t.subtasks ?? [],
          })) ?? [],
        })),
        columnPagination: {},
        loading: false,
      });
    } catch (error) {
      console.error('Failed to fetch columns:', error);
      if (!silent) {
        set({ loadError: error instanceof Error ? error.message : 'Failed to load', loading: false });
      }
    }
  },

  addTaskToColumn: (columnId, task) => set((state) => ({
    columns: state.columns.map(col =>
      col.id === columnId
        ? { ...col, tasks: [{ ...task, comments: [], subtasks: [] }, ...col.tasks] }
        : col
    )
  })),

  updateTaskInColumn: (taskId, task) => set((state) => {
    const oldColumnId = state.columns.find(col => col.tasks.some(t => t.id === taskId))?.id;
    if (oldColumnId && oldColumnId !== task.columnId) {
      return {
        columns: state.columns.map(col => {
          if (col.id === oldColumnId) {
            return { ...col, tasks: col.tasks.filter(t => t.id !== taskId) };
          }
          if (col.id === task.columnId) {
            return { ...col, tasks: [...col.tasks, task] };
          }
          return col;
        })
      };
    }
    return {
      columns: state.columns.map(col => ({
        ...col,
        tasks: col.tasks.map(t => t.id === taskId ? task : t)
      }))
    };
  }),

  removeTaskFromColumn: (taskId) => set((state) => ({
    columns: state.columns.map(col => ({
      ...col,
      tasks: col.tasks.filter(t => t.id !== taskId)
    }))
  })),

  moveTask: (taskId, fromColumnId, toColumnId, newIndex) => set((state) => {
    const sourceColumn = state.columns.find(col => col.id === fromColumnId);
    if (!sourceColumn) return state;

    const task = sourceColumn.tasks.find(t => t.id === taskId);
    if (!task) return state;

    const newColumns = state.columns.map(col => {
      if (col.id === fromColumnId) {
        return { ...col, tasks: col.tasks.filter(t => t.id !== taskId) };
      }
      if (col.id === toColumnId) {
        const newTasks = [...col.tasks];
        newTasks.splice(newIndex, 0, { ...task, columnId: toColumnId });
        return { ...col, tasks: newTasks };
      }
      return col;
    });

    return { columns: newColumns };
  }),

  reorderTasks: async (columnId, oldIndex, newIndex) => {
    const state = get();
    const column = state.columns.find(col => col.id === columnId);
    if (!column) return;

    const tasks = [...column.tasks];
    const [removed] = tasks.splice(oldIndex, 1);
    tasks.splice(newIndex, 0, removed);
    const reorderedTasks = tasks.map((t, i) => ({ ...t, position: i }));

    set((state) => ({
      columns: state.columns.map(col =>
        col.id === columnId ? { ...col, tasks: reorderedTasks } : col
      )
    }));

    await tasksApi.update(reorderedTasks[newIndex].id, { position: newIndex });
  },

  loadMoreTasks: async (columnId) => {
    const state = get();
    const currentPagination = state.columnPagination[columnId] || { page: 1, hasMore: true, isLoadingMore: false };
    if (currentPagination.isLoadingMore || !currentPagination.hasMore) return;

    set((state) => ({
      columnPagination: {
        ...state.columnPagination,
        [columnId]: { ...currentPagination, isLoadingMore: true }
      }
    }));

    try {
      const nextPage = currentPagination.page + 1;
      const response = await tasksApi.getByColumn(columnId, nextPage, 20);
      const newTasks = response.data.map(t => ({
        ...t,
        comments: t.comments ?? [],
        subtasks: t.subtasks ?? [],
      }));

      set((state) => ({
        columns: state.columns.map(col => {
          if (col.id === columnId) {
            const existingTaskIds = new Set(col.tasks.map(t => t.id));
            const uniqueNewTasks = newTasks.filter(t => !existingTaskIds.has(t.id));
            return { ...col, tasks: [...col.tasks, ...uniqueNewTasks] };
          }
          return col;
        }),
        columnPagination: {
          ...state.columnPagination,
          [columnId]: {
            page: nextPage,
            hasMore: nextPage < response.pageCount,
            isLoadingMore: false
          }
        }
      }));
    } catch (error) {
      console.error('Failed to load more tasks:', error);
      set((state) => ({
        columnPagination: {
          ...state.columnPagination,
          [columnId]: { ...currentPagination, isLoadingMore: false }
        }
      }));
    }
  },
}));