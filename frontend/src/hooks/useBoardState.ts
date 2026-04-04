import { useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBoard } from './useBoard';
import { useColumns } from './useColumns';
import { useTasks } from './useTasks';
import { useFilters } from './useFilters';
import { useBoardRefresh } from './useBoardRefresh';
import { useBoardWebSocket } from './useBoardWebSocket';
import { setGlobalErrorHandler } from '../services/api';
import { showErrorToast } from '../components/ErrorToast';
import type { Board, Column as ColumnType, Task, User } from '../types/kanban';
import type { FilterState, FilterPreset } from './useFilters';

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
  handleTaskSelect: (taskId: string, task: Task, e?: any) => void;
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
  offlineQueueRef: React.MutableRefObject<Array<{ action: string; data: any; timestamp: number }>>;
  isProcessingQueueRef: React.MutableRefObject<boolean>;
  processOfflineQueue: () => Promise<void>;
}

export function useBoardState({ boardIdFromUrl, taskIdFromUrl }: UseBoardStateOptions = {}): UseBoardStateReturn {
  const navigate = useNavigate();

  const {
    boards,
    currentBoard,
    currentUser,
    loading: boardLoading,
    boardSwitching,
    loadError,
    fetchBoards,
  } = useBoard({ boardIdFromUrl });

  const {
    columns,
    columnPagination,
    fetchColumns: fetchColumnsBase,
    handleLoadMoreTasks,
    handleColumnRename,
    setColumns,
    setColumnPagination,
  } = useColumns();

  const onLastLocalUpdateHolder = useRef<(() => void) | null>(null);

  const onLastLocalUpdate = useCallback(() => {
    onLastLocalUpdateHolder.current?.();
  }, []);

  const {
    lastLocalUpdateRef,
    offlineQueueRef,
    isProcessingQueueRef,
    processOfflineQueue: processOfflineQueueBase,
    handleTaskNotificationUpdate: handleTaskNotificationUpdateBase,
  } = useBoardRefresh({
    columns,
    onColumnsChange: setColumns,
  });

  useEffect(() => {
    onLastLocalUpdateHolder.current = () => {
      lastLocalUpdateRef.current = Date.now();
    };
  }, [lastLocalUpdateRef]);

  const {
    wsStatus,
    reconnectCount,
  } = useBoardWebSocket({
    currentBoard,
    fetchColumns: fetchColumnsBase,
    handleTaskNotificationUpdate: handleTaskNotificationUpdateBase,
    processOfflineQueue: processOfflineQueueBase,
    lastLocalUpdateRef,
  });

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
    clearFilters,
    saveCurrentAsPreset: saveCurrentAsPresetBase,
    applyPreset,
    deletePreset,
    hasActiveFilters,
  } = useFilters({ columns });

  const saveCurrentAsPreset = useCallback(() => {
    saveCurrentAsPresetBase();
  }, [saveCurrentAsPresetBase]);

  const {
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
    activeTask,
    selectedTask,
    selectedTasks,
    lastSelectedTaskId,
    setSelectedTask,
    setActiveTask,
  } = useTasks({
    columns,
    currentBoard,
    onColumnsChange: setColumns,
    onLastLocalUpdate,
  });

  const fetchColumns = useCallback(async (boardId: string, silent = false) => {
    await fetchColumnsBase(boardId, silent);
  }, [fetchColumnsBase]);

  useEffect(() => {
    if (currentBoard) {
      fetchColumns(currentBoard.id);
    }
  }, [currentBoard?.id, fetchColumns]);

  useEffect(() => {
    if (taskIdFromUrl && columns.length > 0) {
      const allTasksNow = columns.flatMap(col => col.tasks || []);
      const task = allTasksNow.find(t => t.id === taskIdFromUrl);
      if (task) {
        setSelectedTask(task);
        navigate('', { replace: true });
      }
    }
  }, [taskIdFromUrl, columns]);

  useEffect(() => {
    setGlobalErrorHandler((error) => {
      showErrorToast(error.message, 'error');
    });
    return () => setGlobalErrorHandler(null);
  }, []);

  const handleTaskNotificationUpdate = useCallback(async (taskId: string) => {
    await handleTaskNotificationUpdateBase(taskId);
  }, [handleTaskNotificationUpdateBase]);

  const processOfflineQueue = useCallback(async () => {
    await processOfflineQueueBase();
  }, [processOfflineQueueBase]);

  return {
    boards,
    currentBoard,
    columns,
    activeTask,
    selectedTask,
    selectedTasks,
    lastSelectedTaskId,
    loading: boardLoading,
    boardSwitching,
    loadError,
    wsStatus,
    reconnectCount,
    currentUser,
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
    setSelectedTask,
    setActiveTask,
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