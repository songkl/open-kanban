import { useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { setGlobalErrorHandler } from '../services/api';
import { useBoard } from './useBoard';
import { useColumns } from './useColumns';
import { useTasks } from './useTasks';
import { useBoardWebSocket } from './useBoardWebSocket';
import { useBoardRefresh } from './useBoardRefresh';
import { useFilters } from './useFilters';
import type { FilterState, FilterPreset } from './useFilters';
import type { Board, Column as ColumnType, Task, User } from '../types/kanban';

export interface FailedTaskCreation {
  title: string;
  description: string;
  columnId: string;
  position: number;
  priority?: string;
  published: boolean;
  createdAt: string;
}

export interface ColumnPagination {
  page: number;
  hasMore: boolean;
  isLoadingMore: boolean;
}

interface UseBoardStateOptions {
  boardIdFromUrl?: string;
  taskIdFromUrl?: string | null;
}

interface UseBoardStateReturn {
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
  filters: FilterState;
  filterPresets: FilterPreset[];
  columnPagination: Record<string, ColumnPagination>;
  searchQuery: string;
  uniqueAssignees: string[];
  uniqueTags: string[];
  isInDateRange: (taskCreatedAt: string) => boolean;
  getFilteredColumns: () => ColumnType[];
  fetchBoards: () => Promise<void>;
  fetchColumns: (boardId: string, silent?: boolean) => Promise<void>;
  handleLoadMoreTasks: (columnId: string) => Promise<void>;
  updateTask: (task: Task) => Promise<void>;
  deleteTask: (taskId: string) => Promise<void>;
  archiveTask: (taskId: string) => Promise<void>;
  addTask: (columnId?: string, title?: string, description?: string, published?: boolean, boardId?: string, priority?: string) => Promise<void>;
  addComment: (taskId: string, content: string, author: string) => Promise<void>;
  handleTaskSelect: (taskId: string, task: Task, e?: React.MouseEvent) => void;
  clearSelection: () => void;
  batchDelete: () => Promise<void>;
  batchArchive: () => Promise<void>;
  batchMove: (targetColumnId: string) => Promise<void>;
  batchUpdatePriority: (priority: string) => Promise<void>;
  batchUpdateAssignee: (assignee: string) => Promise<void>;
  handleColumnRename: (columnId: string, newName: string) => Promise<void>;
  setSelectedTask: (task: Task | null) => void;
  setActiveTask: (task: Task | null) => void;
  setFilters: React.Dispatch<React.SetStateAction<FilterState>>;
  setFilterPresets: React.Dispatch<React.SetStateAction<FilterPreset[]>>;
  setSearchQuery: React.Dispatch<React.SetStateAction<string>>;
  setColumnPagination: React.Dispatch<React.SetStateAction<Record<string, ColumnPagination>>>;
  saveCurrentAsPreset: () => void;
  applyPreset: (preset: FilterPreset) => void;
  deletePreset: (presetId: string) => void;
  clearFilters: () => void;
  hasActiveFilters: boolean;
  handleTaskNotificationUpdate: (taskId: string) => Promise<void>;
  lastLocalUpdateRef: React.MutableRefObject<number>;
  offlineQueueRef: React.MutableRefObject<Array<{ action: string; data: unknown; timestamp: number }>>;
  isProcessingQueueRef: React.MutableRefObject<boolean>;
  processOfflineQueue: () => Promise<void>;
}

export function useBoardState({ boardIdFromUrl, taskIdFromUrl }: UseBoardStateOptions = {}): UseBoardStateReturn {
  const navigate = useNavigate();

  const {
    boards,
    currentBoard,
    boardSwitching: boardBoardSwitching,
    fetchBoards,
  } = useBoard({ boardIdFromUrl });

  const {
    columns,
    columnPagination,
    boardSwitching: columnsBoardSwitching,
    loadError,
    fetchColumns,
    handleLoadMoreTasks,
    handleColumnRename,
    setColumns,
    setColumnPagination,
  } = useColumns();

  const {
    activeTask,
    selectedTask,
    selectedTasks,
    lastSelectedTaskId,
    updateTask: taskUpdateTask,
    deleteTask: taskDeleteTask,
    archiveTask: taskArchiveTask,
    addTask: taskAddTask,
    addComment: taskAddComment,
    handleTaskSelect: taskHandleTaskSelect,
    clearSelection: taskClearSelection,
    batchDelete: taskBatchDelete,
    batchArchive: taskBatchArchive,
    batchMove: taskBatchMove,
    batchUpdatePriority: taskBatchUpdatePriority,
    batchUpdateAssignee: taskBatchUpdateAssignee,
    setSelectedTask: taskSetSelectedTask,
    setActiveTask: taskSetActiveTask,
    lastLocalUpdateRef,
    offlineQueueRef,
    isProcessingQueueRef,
  } = useTasks({ columns, currentBoard, onColumnsChange: setColumns, onLastLocalUpdate: () => {} });

  const {
    filters,
    filterPresets,
    searchQuery,
    uniqueAssignees,
    uniqueTags,
    isInDateRange,
    getFilteredColumns,
    setFilters,
    setFilterPresets,
    setSearchQuery,
    saveCurrentAsPreset,
    applyPreset,
    deletePreset,
    clearFilters,
    hasActiveFilters,
  } = useFilters({ columns });

  const {
    handleTaskNotificationUpdate,
    processOfflineQueue,
  } = useBoardRefresh({
    columns,
    onColumnsChange: setColumns,
  });

  const {
    wsStatus,
    reconnectCount,
    connectWebSocket,
  } = useBoardWebSocket({
    currentBoard,
    fetchColumns,
    handleTaskNotificationUpdate,
    processOfflineQueue,
    lastLocalUpdateRef,
  });

  useEffect(() => {
    setGlobalErrorHandler((error) => {
      console.error(error);
    });
    return () => setGlobalErrorHandler(null);
  }, []);

  useEffect(() => {
    const loadInitialData = async () => {
      try {
        await Promise.all([
          fetchBoards(),
          new Promise<void>((resolve) => {
            connectWebSocket();
            resolve();
          }),
        ]);
      } catch (error) {
        console.error('Failed to load initial data:', error);
      }
    };

    loadInitialData();
  }, []);

  useEffect(() => {
    if (currentBoard) {
      fetchColumns(currentBoard.id);
    }
  }, [currentBoard?.id]);

  useEffect(() => {
    if (taskIdFromUrl && columns.length > 0) {
      const tasks = columns.flatMap(col => col.tasks || []);
      const task = tasks.find(t => t.id === taskIdFromUrl);
      if (task) {
        taskSetSelectedTask(task);
        navigate('', { replace: true });
      }
    }
  }, [taskIdFromUrl, columns]);

  const loading = !currentBoard;
  const boardSwitching = boardBoardSwitching || columnsBoardSwitching;

  const updateTask = useCallback(async (task: Task) => {
    await taskUpdateTask(task);
  }, [taskUpdateTask]);

  const deleteTask = useCallback(async (taskId: string) => {
    await taskDeleteTask(taskId);
  }, [taskDeleteTask]);

  const archiveTask = useCallback(async (taskId: string) => {
    await taskArchiveTask(taskId);
  }, [taskArchiveTask]);

  const addTask = useCallback(async (columnId?: string, title?: string, description?: string, published?: boolean, boardId?: string, priority?: string) => {
    await taskAddTask(columnId, title, description, published, boardId, priority);
  }, [taskAddTask]);

  const addComment = useCallback(async (taskId: string, content: string, author: string) => {
    await taskAddComment(taskId, content, author);
  }, [taskAddComment]);

  const handleTaskSelect = useCallback((taskId: string, task: Task, e?: React.MouseEvent) => {
    taskHandleTaskSelect(taskId, task, e);
  }, [taskHandleTaskSelect]);

  const clearSelection = useCallback(() => {
    taskClearSelection();
  }, [taskClearSelection]);

  const batchDelete = useCallback(async () => {
    await taskBatchDelete();
  }, [taskBatchDelete]);

  const batchArchive = useCallback(async () => {
    await taskBatchArchive();
  }, [taskBatchArchive]);

  const batchMove = useCallback(async (targetColumnId: string) => {
    await taskBatchMove(targetColumnId);
  }, [taskBatchMove]);

  const batchUpdatePriority = useCallback(async (priority: string) => {
    await taskBatchUpdatePriority(priority);
  }, [taskBatchUpdatePriority]);

  const batchUpdateAssignee = useCallback(async (assignee: string) => {
    await taskBatchUpdateAssignee(assignee);
  }, [taskBatchUpdateAssignee]);

  return {
    boards,
    currentBoard,
    columns,
    activeTask,
    selectedTask,
    selectedTasks,
    lastSelectedTaskId,
    loading,
    boardSwitching,
    loadError,
    wsStatus,
    reconnectCount,
    currentUser: null,
    filters,
    filterPresets,
    columnPagination,
    searchQuery,
    uniqueAssignees,
    uniqueTags,
    isInDateRange,
    getFilteredColumns,
    fetchBoards,
    fetchColumns,
    handleLoadMoreTasks,
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
    handleColumnRename,
    setSelectedTask: taskSetSelectedTask,
    setActiveTask: taskSetActiveTask,
    setFilters,
    setFilterPresets,
    setSearchQuery,
    setColumnPagination,
    saveCurrentAsPreset,
    applyPreset,
    deletePreset,
    clearFilters,
    hasActiveFilters,
    handleTaskNotificationUpdate,
    lastLocalUpdateRef,
    offlineQueueRef,
    isProcessingQueueRef,
    processOfflineQueue,
  };
}