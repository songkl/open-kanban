import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { setGlobalErrorHandler } from '../services/api';
import { useBoard } from './useBoard';
import { useColumns } from './useColumns';
import { useTasks } from './useTasks';
import { useBoardWebSocket } from './useBoardWebSocket';
import { useBoardRefresh } from './useBoardRefresh';
import type { Board, Column as ColumnType, Task, User } from '../types/kanban';

const FILTER_PRESETS_KEY = 'filterPresets';

export interface FilterState {
  priority: string;
  assignee: string;
  searchQuery: string;
  dateRange: string;
  tag: string;
}

export interface FilterPreset {
  id: string;
  name: string;
  filters: FilterState;
}

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
  const { t } = useTranslation();
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
    loading: columnsLoading,
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
  } = useTasks({ currentBoardId: currentBoard?.id });

  const [searchQuery, setSearchQuery] = useState('');
  const [filters, setFilters] = useState<FilterState>({ priority: '', assignee: '', searchQuery: '', dateRange: '', tag: '' });
  const [filterPresets, setFilterPresets] = useState<FilterPreset[]>(() => {
    const saved = localStorage.getItem(FILTER_PRESETS_KEY);
    return saved ? JSON.parse(saved) : [];
  });

  const {
    handleTaskNotificationUpdate,
    processOfflineQueue,
  } = useBoardRefresh({
    columns,
    setColumns,
    lastLocalUpdateRef,
    offlineQueueRef,
    isProcessingQueueRef,
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
    offlineQueueRef,
    isProcessingQueueRef,
  });

  const allTasks = columns.flatMap(col => col.tasks || []);
  const uniqueAssignees = [...new Set(allTasks.filter(task => task.assignee).map(task => task.assignee as string))];
  const uniqueTags = [...new Set(allTasks.filter(task => task.meta && typeof task.meta === 'object' && '标签' in task.meta).map(task => (task.meta as Record<string, unknown>)['标签'] as string).filter(Boolean))];

  const isInDateRange = useCallback((taskCreatedAt: string): boolean => {
    if (!filters.dateRange) return true;
    const created = new Date(taskCreatedAt);
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    switch (filters.dateRange) {
      case 'today':
        return created >= todayStart;
      case 'thisWeek':
        return created >= weekStart;
      case 'thisMonth':
        return created >= monthStart;
      default:
        return true;
    }
  }, [filters.dateRange]);

  const getFilteredColumns = useCallback(() => {
    if (!filters.searchQuery && !filters.priority && !filters.assignee && !filters.dateRange && !filters.tag) {
      return columns;
    }
    return columns.map(col => ({
      ...col,
      tasks: (col.tasks || []).filter(task => {
        if (filters.searchQuery) {
          const query = filters.searchQuery.toLowerCase();
          const titleMatch = task.title.toLowerCase().includes(query);
          const descMatch = (task.description || '').toLowerCase().includes(query);
          if (!titleMatch && !descMatch) return false;
        }
        if (filters.priority && task.priority !== filters.priority) return false;
        if (filters.assignee && task.assignee !== filters.assignee) return false;
        if (filters.dateRange && !isInDateRange(task.createdAt)) return false;
        if (filters.tag) {
          const taskTag = task.meta && typeof task.meta === 'object' ? (task.meta as Record<string, unknown>)['标签'] : null;
          if (taskTag !== filters.tag) return false;
        }
        return true;
      })
    }));
  }, [columns, filters, isInDateRange]);

  const saveCurrentAsPreset = useCallback(() => {
    const name = prompt(t('filter.presetName'));
    if (!name?.trim()) return;
    const newPreset: FilterPreset = {
      id: Date.now().toString(),
      name: name.trim(),
      filters: { ...filters }
    };
    setFilterPresets(prev => [...prev, newPreset]);
  }, [filters, t]);

  const applyPreset = useCallback((preset: FilterPreset) => {
    setFilters(preset.filters);
    setSearchQuery(preset.filters.searchQuery);
  }, []);

  const deletePreset = useCallback((presetId: string) => {
    setFilterPresets(prev => prev.filter(p => p.id !== presetId));
  }, []);

  const clearFilters = useCallback(() => {
    setFilters({ priority: '', assignee: '', searchQuery: '', dateRange: '', tag: '' });
    setSearchQuery('');
  }, []);

  const hasActiveFilters = !!(filters.searchQuery || filters.priority || filters.assignee || filters.dateRange || filters.tag);

  useEffect(() => {
    localStorage.setItem(FILTER_PRESETS_KEY, JSON.stringify(filterPresets));
  }, [filterPresets]);

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

  const loading = columnsLoading;
  const boardSwitching = boardBoardSwitching || columnsBoardSwitching;

  const updateTask = useCallback(async (task: Task) => {
    await taskUpdateTask(task, columns, setColumns, taskSetSelectedTask, boards);
  }, [taskUpdateTask, columns, boards]);

  const deleteTask = useCallback(async (taskId: string) => {
    await taskDeleteTask(taskId, columns, setColumns, taskSetSelectedTask);
  }, [taskDeleteTask, columns]);

  const archiveTask = useCallback(async (taskId: string) => {
    await taskArchiveTask(taskId, columns, setColumns, taskSetSelectedTask);
  }, [taskArchiveTask, columns]);

  const addTask = useCallback(async (columnId?: string, title?: string, description?: string, published?: boolean, boardId?: string, priority?: string) => {
    await taskAddTask(columnId, title, description, published, boardId, priority, columns, setColumns, boards);
  }, [taskAddTask, columns, boards]);

  const addComment = useCallback(async (taskId: string, content: string, author: string) => {
    await taskAddComment(taskId, content, author, columns, setColumns, selectedTask, taskSetSelectedTask);
  }, [taskAddComment, columns, selectedTask]);

  const handleTaskSelect = useCallback((taskId: string, task: Task, e?: React.MouseEvent) => {
    taskHandleTaskSelect(taskId, task, columns, e);
  }, [taskHandleTaskSelect, columns]);

  const clearSelection = useCallback(() => {
    taskClearSelection();
  }, [taskClearSelection]);

  const batchDelete = useCallback(async () => {
    await taskBatchDelete(columns, selectedTasks, setColumns);
  }, [taskBatchDelete, columns, selectedTasks]);

  const batchArchive = useCallback(async () => {
    await taskBatchArchive(columns, selectedTasks, setColumns);
  }, [taskBatchArchive, columns, selectedTasks]);

  const batchMove = useCallback(async (targetColumnId: string) => {
    await taskBatchMove(targetColumnId, columns, selectedTasks, setColumns);
  }, [taskBatchMove, columns, selectedTasks]);

  const batchUpdatePriority = useCallback(async (priority: string) => {
    await taskBatchUpdatePriority(priority, columns, selectedTasks, setColumns);
  }, [taskBatchUpdatePriority, columns, selectedTasks]);

  const batchUpdateAssignee = useCallback(async (assignee: string) => {
    await taskBatchUpdateAssignee(assignee, columns, selectedTasks, setColumns);
  }, [taskBatchUpdateAssignee, columns, selectedTasks]);

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