import { useEffect, useCallback, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { setGlobalErrorHandler } from '../services/api';
import { useBoard } from './useBoard';
import { useColumns } from './useColumns';
import { useTasks } from './useTasks';
import { useBoardWebSocket } from './useBoardWebSocket';
import { useBoardRefresh } from './useBoardRefresh';
import { useFilters, decodeFiltersFromParams } from './useFilters';
import { useColumnPermissions } from './useColumnPermissions';
import { useCustomFields } from './useCustomFields';
import { useRunStore } from '../store/runStore';
import type { ColumnAccess } from './useColumnPermissions';
import type { FilterState, FilterPreset } from './useFilters';
import type { Board, Column as ColumnType, CustomField, Task, User } from '../types/kanban';

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
  hasAccess: boolean;
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
  uniqueCustomFieldValues: Record<string, string[]>;
  customFields: CustomField[];
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
  selectAllInColumn: (columnId: string, taskIds: string[]) => void;
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
  setColumns: React.Dispatch<React.SetStateAction<ColumnType[]>>;
  saveCurrentAsPreset: () => void;
  applyPreset: (preset: FilterPreset) => void;
  deletePreset: (presetId: string) => void;
  clearFilters: () => void;
  clearSingleFilter: (dimension: keyof FilterState | 'customField.fieldId' | 'customField.value') => void;
  hasActiveFilters: boolean;
  activeFilterCount: number;
  handleTaskNotificationUpdate: (taskId: string) => Promise<void>;
  lastLocalUpdateRef: React.MutableRefObject<number>;
  offlineQueueRef: React.MutableRefObject<Array<{ action: string; data: unknown; timestamp: number }>>;
  isProcessingQueueRef: React.MutableRefObject<boolean>;
  processOfflineQueue: () => Promise<void>;
  // Per-column permission gating (s-1053): the create-task
  // affordances (toolbar button, column empty-state, modal
  // submit, keyboard shortcuts) read from these instead of
  // asking the user to click first and discover a 403.
  columnAccess: Record<string, ColumnAccess>;
  columnPermissionsLoading: boolean;
  columnPermissionsError: string | null;
  canCreateTaskInColumn: (columnId: string) => boolean;
  canCreateTaskAnywhere: boolean;
  refreshColumnPermissions: () => void;
}

export function useBoardState({ boardIdFromUrl, taskIdFromUrl }: UseBoardStateOptions = {}): UseBoardStateReturn {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // s-1201: hydrate the filter state from URL search params so a
  // shared or bookmarked board link preserves the user's filters.
  // Only the keys that are present are populated; missing keys keep
  // their default values via `withDefaults` inside the hook.
  const initial = useMemo(
    () => decodeFiltersFromParams(searchParams),
    // searchParams identity changes on every setSearchParams, so
    // pinning the seed to first-mount avoids re-seeding on every
    // filter edit. The bidirectional URL sync in BoardPage writes
    // the URL; we just consume it once on entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // s-1201: subscribe to the shared run store so the new
  // `runStatus` filter dimension has live data. Selector keeps the
  // re-render narrow — we only need the `runs` map, not actions.
  const runs = useRunStore((s) => s.runs);

  const {
    boards,
    currentBoard,
    currentUser,
    hasAccess,
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
    selectAllInColumn: taskSelectAllInColumn,
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

  const { customFields } = useCustomFields(currentBoard?.id);

  const {
    filters,
    filterPresets,
    searchQuery,
    uniqueAssignees,
    uniqueTags,
    uniqueCustomFieldValues,
    isInDateRange,
    getFilteredColumns,
    setFilters,
    setFilterPresets,
    setSearchQuery,
    saveCurrentAsPreset,
    applyPreset,
    deletePreset,
    clearFilters,
    clearSingleFilter,
    hasActiveFilters,
    activeFilterCount,
  } = useFilters({ columns, customFields, runsByTaskId: runs, initial });

  const {
    handleTaskNotificationUpdate,
    processOfflineQueue,
  } = useBoardRefresh({
    columns,
    onColumnsChange: setColumns,
  });

  const {
    columnAccess,
    loading: columnPermissionsLoading,
    error: columnPermissionsError,
    canCreateAnywhere: canCreateTaskAnywhere,
    canCreateIn: canCreateTaskInColumn,
    refresh: refreshColumnPermissions,
  } = useColumnPermissions(currentBoard?.id);

  const {
    wsStatus,
    reconnectCount,
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
    fetchBoards();
  }, [fetchBoards]);

  useEffect(() => {
    if (currentBoard) {
      fetchColumns(currentBoard.id);
    }
  }, [currentBoard, fetchColumns]);

  useEffect(() => {
    if (taskIdFromUrl && columns.length > 0) {
      const tasks = columns.flatMap(col => col.tasks || []);
      const task = tasks.find(t => t.id === taskIdFromUrl);
      if (task) {
        taskSetSelectedTask(task);
        navigate('', { replace: true });
      }
    }
  }, [taskIdFromUrl, columns, taskSetSelectedTask, navigate]);

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

  const selectAllInColumn = useCallback((columnId: string, taskIds: string[]) => {
    taskSelectAllInColumn(columnId, taskIds);
  }, [taskSelectAllInColumn]);

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
    hasAccess,
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
    currentUser,
    filters,
    filterPresets,
    columnPagination,
    searchQuery,
    uniqueAssignees,
    uniqueTags,
    uniqueCustomFieldValues,
    customFields,
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
    selectAllInColumn,
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
    clearSingleFilter,
    hasActiveFilters,
    activeFilterCount,
    handleTaskNotificationUpdate,
    lastLocalUpdateRef,
    offlineQueueRef,
    isProcessingQueueRef,
    processOfflineQueue,
    setColumns,
    columnAccess,
    columnPermissionsLoading,
    columnPermissionsError,
    canCreateTaskInColumn,
    canCreateTaskAnywhere,
    refreshColumnPermissions,
  };
}