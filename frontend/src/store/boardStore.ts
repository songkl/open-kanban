import { create } from 'zustand';
import type { Board, Column as ColumnType, Task, User } from '../types/kanban';
import { boardsApi, columnsApi, tasksApi, commentsApi, authApi } from '../services/api';

interface BoardState {
  boards: Board[];
  currentBoard: Board | null;
  columns: ColumnType[];
  activeTask: Task | null;
  selectedTask: Task | null;
  selectedTasks: Set<string>;
  lastSelectedTaskId: string | null;
  loading: boolean;
  boardSwitching: boolean;
  loadError: string | null;
  wsStatus: 'connected' | 'disconnected' | 'failed';
  reconnectCount: number;
  currentUser: User | null;
  columnPagination: Record<string, { page: number; hasMore: boolean; isLoadingMore: boolean }>;
  offlineQueue: Array<{ action: string; data: any; timestamp: number }>;
  isProcessingQueue: boolean;
  lastLocalUpdate: number;
  REFRESH_DEBOUNCE_MS: number;

  setBoards: (boards: Board[]) => void;
  setCurrentBoard: (board: Board | null) => void;
  setColumns: (columns: ColumnType[]) => void;
  setActiveTask: (task: Task | null) => void;
  setSelectedTask: (task: Task | null) => void;
  setSelectedTasks: (tasks: Set<string>) => void;
  toggleTaskSelection: (taskId: string) => void;
  selectTasks: (taskIds: string[]) => void;
  clearSelection: () => void;
  setLastSelectedTaskId: (id: string | null) => void;
  setLoading: (loading: boolean) => void;
  setBoardSwitching: (switching: boolean) => void;
  setLoadError: (error: string | null) => void;
  setWsStatus: (status: 'connected' | 'disconnected' | 'failed') => void;
  setReconnectCount: (count: number) => void;
  setCurrentUser: (user: User | null) => void;
  setColumnPagination: (pagination: Record<string, { page: number; hasMore: boolean; isLoadingMore: boolean }>) => void;
  updateColumnPagination: (columnId: string, pagination: { page: number; hasMore: boolean; isLoadingMore: boolean }) => void;

  fetchBoards: () => Promise<void>;
  fetchColumns: (boardId: string, silent?: boolean) => Promise<void>;
  fetchUser: () => Promise<void>;

  addTaskToColumn: (columnId: string, task: Task) => void;
  updateTaskInColumn: (taskId: string, task: Task) => void;
  removeTaskFromColumn: (taskId: string) => void;
  moveTask: (taskId: string, fromColumnId: string, toColumnId: string, newIndex: number) => void;

  updateTask: (task: Task) => Promise<void>;
  deleteTask: (taskId: string) => Promise<void>;
  archiveTask: (taskId: string) => Promise<void>;
  addComment: (taskId: string, content: string, author: string) => Promise<void>;

  reorderTasks: (columnId: string, oldIndex: number, newIndex: number) => Promise<void>;
  loadMoreTasks: (columnId: string) => Promise<void>;
}

export const useBoardStore = create<BoardState>((set, get) => ({
  boards: [],
  currentBoard: null,
  columns: [],
  activeTask: null,
  selectedTask: null,
  selectedTasks: new Set(),
  lastSelectedTaskId: null,
  loading: true,
  boardSwitching: false,
  loadError: null,
  wsStatus: 'disconnected',
  reconnectCount: 0,
  currentUser: null,
  columnPagination: {},
  offlineQueue: [],
  isProcessingQueue: false,
  lastLocalUpdate: 0,
  REFRESH_DEBOUNCE_MS: 1000,

  setBoards: (boards) => set({ boards }),
  setCurrentBoard: (board) => set({ currentBoard: board }),
  setColumns: (columns) => set({ columns }),
  setActiveTask: (task) => set({ activeTask: task }),
  setSelectedTask: (task) => set({ selectedTask: task }),
  setSelectedTasks: (tasks) => set({ selectedTasks: tasks }),
  toggleTaskSelection: (taskId) => set((state) => {
    const newSet = new Set(state.selectedTasks);
    if (newSet.has(taskId)) {
      newSet.delete(taskId);
    } else {
      newSet.add(taskId);
    }
    return { selectedTasks: newSet };
  }),
  selectTasks: (taskIds) => set({ selectedTasks: new Set(taskIds) }),
  clearSelection: () => set({ selectedTasks: new Set(), lastSelectedTaskId: null }),
  setLastSelectedTaskId: (id) => set({ lastSelectedTaskId: id }),
  setLoading: (loading) => set({ loading }),
  setBoardSwitching: (switching) => set({ boardSwitching: switching }),
  setLoadError: (error) => set({ loadError: error }),
  setWsStatus: (status) => set({ wsStatus: status }),
  setReconnectCount: (count) => set({ reconnectCount: count }),
  setCurrentUser: (user) => set({ currentUser: user }),
  setColumnPagination: (pagination) => set({ columnPagination: pagination }),
  updateColumnPagination: (columnId, pagination) => set((state) => ({
    columnPagination: { ...state.columnPagination, [columnId]: pagination }
  })),

  fetchBoards: async () => {
    try {
      const data = await boardsApi.getAll();
      set({ boards: data || [] });
    } catch (error) {
      console.error('Failed to fetch boards:', error);
    }
  },

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
        columnPagination: {}
      });
    } catch (error) {
      console.error('Failed to fetch columns:', error);
      if (!silent) {
        set({ loadError: error instanceof Error ? error.message : 'Failed to load' });
      }
    } finally {
      if (!silent) {
        set({ loading: false, boardSwitching: false });
      }
    }
  },

  fetchUser: async () => {
    try {
      const data = await authApi.me();
      if (data.user) {
        set({ currentUser: data.user });
      }
    } catch (error) {
      console.error('Failed to fetch user:', error);
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

  updateTask: async (task) => {
    const state = get();
    const currentBoardId = state.currentBoard?.id || '';
    const targetColumnId = task.columnId;
    const targetBoardId = targetColumnId?.split('_')[0] || '';
    const isSameBoard = targetBoardId === currentBoardId;

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
        set({ lastLocalUpdate: Date.now() });
        get().updateTaskInColumn(task.id, parsedUpdated);
        set({ selectedTask: parsedUpdated });
      }
    } catch (error) {
      console.error('Failed to update task:', error);
      throw error;
    }
  },

  deleteTask: async (taskId) => {
    set({ lastLocalUpdate: Date.now() });
    await tasksApi.delete(taskId);
    get().removeTaskFromColumn(taskId);
    set({ selectedTask: null });
  },

  archiveTask: async (taskId) => {
    set({ lastLocalUpdate: Date.now() });
    await tasksApi.archive(taskId, true);
    get().removeTaskFromColumn(taskId);
    set({ selectedTask: null });
  },

  addComment: async (taskId, content, author) => {
    set({ lastLocalUpdate: Date.now() });
    const comment = await commentsApi.create({ taskId, content, author });
    set((state) => ({
      columns: state.columns.map(col => ({
        ...col,
        tasks: col.tasks.map(t =>
          t.id === taskId ? { ...t, comments: [...(t.comments ?? []), comment] } : t
        )
      }))
    }));
    const selectedTask = get().selectedTask;
    if (selectedTask?.id === taskId) {
      set({ selectedTask: { ...selectedTask, comments: [...(selectedTask.comments ?? []), comment] } });
    }
  },

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
