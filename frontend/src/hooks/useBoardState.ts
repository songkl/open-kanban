import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { boardsApi, columnsApi, tasksApi, commentsApi, authApi, setGlobalErrorHandler } from '../services/api';
import { showErrorToast } from '../components/ErrorToast';
import type { Board, Column as ColumnType, Task, User } from '../types/kanban';

const LAST_BOARD_KEY = 'lastSelectedBoardId';
const FAILED_TASK_CREATIONS_KEY = 'failedTaskCreations';
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

export function useBoardState({ boardIdFromUrl, taskIdFromUrl }: UseBoardStateOptions = {}): UseBoardStateReturn {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [boards, setBoards] = useState<Board[]>([]);
  const [currentBoard, setCurrentBoard] = useState<Board | null>(null);
  const [columns, setColumns] = useState<ColumnType[]>([]);
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [selectedTasks, setSelectedTasks] = useState<Set<string>>(new Set());
  const [lastSelectedTaskId, setLastSelectedTaskId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [boardSwitching, setBoardSwitching] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [wsStatus, setWsStatus] = useState<'connected' | 'disconnected' | 'failed'>('disconnected');
  const [_reconnectCount, setReconnectCount] = useState(0);
  const reconnectAttemptRef = useRef(0);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filters, setFilters] = useState<FilterState>({ priority: '', assignee: '', searchQuery: '', dateRange: '', tag: '' });
  const [filterPresets, setFilterPresets] = useState<FilterPreset[]>(() => {
    const saved = localStorage.getItem(FILTER_PRESETS_KEY);
    return saved ? JSON.parse(saved) : [];
  });
  const [columnPagination, setColumnPagination] = useState<Record<string, ColumnPagination>>({});

  const currentBoardRef = useRef<Board | null>(null);
  const offlineQueueRef = useRef<Array<{ action: string; data: any; timestamp: number }>>([]);
  const isProcessingQueueRef = useRef<boolean>(false);
  const lastLocalUpdateRef = useRef<number>(0);
  const wsRef = useRef<WebSocket | null>(null);
  const REFRESH_DEBOUNCE_MS = 1000;

  const allTasks = columns.flatMap(col => col.tasks || []);
  const uniqueAssignees = [...new Set(allTasks.filter(t => t.assignee).map(t => t.assignee as string))];
  const uniqueTags = [...new Set(allTasks.filter(t => t.meta && typeof t.meta === 'object' && '标签' in t.meta).map(t => (t.meta as Record<string, any>)['标签'] as string).filter(Boolean))];

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
          const taskTag = task.meta && typeof task.meta === 'object' ? (task.meta as Record<string, any>)['标签'] : null;
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
    currentBoardRef.current = currentBoard;
  }, [currentBoard]);

  useEffect(() => {
    setFilters(prev => ({ ...prev, searchQuery }));
  }, [searchQuery]);

  useEffect(() => {
    localStorage.setItem(FILTER_PRESETS_KEY, JSON.stringify(filterPresets));
  }, [filterPresets]);

  useEffect(() => {
    setGlobalErrorHandler((error) => {
      showErrorToast(error.message, 'error');
    });
    return () => setGlobalErrorHandler(null);
  }, []);

  const fetchBoards = useCallback(async () => {
    try {
      const data = await boardsApi.getAll();
      setBoards(data || []);
    } catch (error) {
      console.error('Failed to fetch boards:', error);
    }
  }, []);

  const fetchColumns = useCallback(async (boardId: string, silent = false) => {
    if (!silent) {
      setLoading(true);
      setLoadError(null);
    }
    try {
      const data = await columnsApi.getByBoard(boardId);
      setColumns(data.map(col => ({
        ...col,
        tasks: col.tasks?.map(t => ({
          ...t,
          comments: t.comments ?? [],
          subtasks: t.subtasks ?? [],
        })) ?? [],
      })));
      setColumnPagination({});
    } catch (error) {
      console.error('Failed to fetch columns:', error);
      if (!silent) {
        setLoadError(error instanceof Error ? error.message : t('app.error.loadFailed'));
      }
    } finally {
      if (!silent) {
        setLoading(false);
        setBoardSwitching(false);
      }
    }
  }, [t]);

  const handleLoadMoreTasks = useCallback(async (columnId: string) => {
    const currentPagination = columnPagination[columnId] || { page: 1, hasMore: true, isLoadingMore: false };
    if (currentPagination.isLoadingMore || !currentPagination.hasMore) return;

    setColumnPagination(prev => ({
      ...prev,
      [columnId]: { ...currentPagination, isLoadingMore: true }
    }));

    try {
      const nextPage = currentPagination.page + 1;
      const response = await tasksApi.getByColumn(columnId, nextPage, 20);
      const newTasks = response.data.map(t => ({
        ...t,
        comments: t.comments ?? [],
        subtasks: t.subtasks ?? [],
      }));

      setColumns(prev => prev.map(col => {
        if (col.id === columnId) {
          const existingTaskIds = new Set(col.tasks.map(t => t.id));
          const uniqueNewTasks = newTasks.filter(t => !existingTaskIds.has(t.id));
          return { ...col, tasks: [...col.tasks, ...uniqueNewTasks] };
        }
        return col;
      }));

      setColumnPagination(prev => ({
        ...prev,
        [columnId]: {
          page: nextPage,
          hasMore: nextPage < response.pageCount,
          isLoadingMore: false
        }
      }));
    } catch (error) {
      console.error('Failed to load more tasks:', error);
      setColumnPagination(prev => ({
        ...prev,
        [columnId]: { ...currentPagination, isLoadingMore: false }
      }));
    }
  }, [columnPagination]);

  const handleTaskNotificationUpdate = useCallback(async (taskId: string) => {
    try {
      const updatedTask = await tasksApi.getById(taskId);
      if (!updatedTask) return;

      const parsedTask = {
        ...updatedTask,
        meta: typeof updatedTask.meta === 'string' ? JSON.parse(updatedTask.meta || '{}') : updatedTask.meta || null,
      };

      const oldColumn = columns.find(col => col.tasks.some(t => t.id === taskId));
      const newColumnId = parsedTask.columnId;

      if (oldColumn && oldColumn.id !== newColumnId) {
        setColumns(cols => cols.map(col => {
          if (col.id === oldColumn.id) {
            return { ...col, tasks: col.tasks.filter(t => t.id !== taskId) };
          }
          if (col.id === newColumnId) {
            return { ...col, tasks: [...col.tasks, parsedTask] };
          }
          return col;
        }));
      } else if (oldColumn) {
        setColumns(cols => cols.map(col => ({
          ...col,
          tasks: col.tasks.map(t => t.id === taskId ? parsedTask : t)
        })));
      }
    } catch (error) {
      console.error('Failed to handle task notification update:', error);
    }
  }, [columns]);

  const processOfflineQueue = useCallback(async () => {
    if (isProcessingQueueRef.current || offlineQueueRef.current.length === 0) return;
    isProcessingQueueRef.current = true;
    const queue = [...offlineQueueRef.current];
    offlineQueueRef.current = [];
    console.log(`Processing ${queue.length} offline actions`);
    for (const item of queue) {
      try {
        switch (item.action) {
          case 'updateTask':
            await tasksApi.update(item.data.id, item.data);
            break;
          case 'deleteTask':
            await tasksApi.delete(item.data.id);
            break;
          case 'archiveTask':
            await tasksApi.archive(item.data.id, true);
            break;
          case 'addTask':
            await tasksApi.create(item.data);
            break;
        }
      } catch (error) {
        console.error(`Failed to process offline action ${item.action}:`, error);
        offlineQueueRef.current.push(item);
      }
    }
    isProcessingQueueRef.current = false;
    if (offlineQueueRef.current.length > 0) {
      console.log(`${offlineQueueRef.current.length} actions failed, keeping in queue`);
    }
  }, []);

  const connectWebSocket = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.onclose = null;
      if (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING) {
        wsRef.current.close();
      }
    }
    const getWsUrl = () => {
      if (import.meta.env.VITE_WS_URL) return import.meta.env.VITE_WS_URL;
      if (import.meta.env.DEV) {
        return `ws://localhost:8080/ws`;
      }
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${protocol}//${window.location.host}/ws`;
    };
    const wsUrl = getWsUrl();
    const ws = new WebSocket(wsUrl);
    const MAX_RECONNECT_ATTEMPTS = 10;
    const MAX_RECONNECT_DELAY = 30000;

    const getReconnectDelay = (attempt: number) => {
      const delay = Math.min(1000 * Math.pow(2, attempt), MAX_RECONNECT_DELAY);
      return delay;
    };

    ws.onopen = () => {
      console.log('WebSocket connected');
      setWsStatus('connected');
      setReconnectCount(0);
      reconnectAttemptRef.current = 0;
      processOfflineQueue();
      if (currentBoardRef.current) {
        fetchColumns(currentBoardRef.current.id, true);
      }
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
          return;
        }
        if (message.type === 'refresh') {
          const now = Date.now();
          if (now - lastLocalUpdateRef.current < REFRESH_DEBOUNCE_MS) {
            console.log('Skipping redundant refresh after local update');
            return;
          }
          if (currentBoardRef.current) {
            fetchColumns(currentBoardRef.current.id, true);
          }
        } else if (message.type === 'task_notification') {
          const { boardId, taskId, action } = message;
          if (currentBoardRef.current && boardId === currentBoardRef.current.id) {
            const now = Date.now();
            if (now - lastLocalUpdateRef.current < REFRESH_DEBOUNCE_MS) {
              return;
            }
            if (action === 'create') {
              fetchColumns(currentBoardRef.current.id, true);
            } else if (action === 'update' || action === 'update_status') {
              handleTaskNotificationUpdate(taskId);
            }
          }
        }
      } catch {
        console.error('Failed to parse WebSocket message');
      }
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected');
      const attempt = reconnectAttemptRef.current;
      if (attempt < MAX_RECONNECT_ATTEMPTS) {
        setWsStatus('disconnected');
        setReconnectCount(attempt + 1);
        const delay = getReconnectDelay(attempt);
        console.log(`Reconnecting in ${delay}ms (attempt ${attempt + 1}/${MAX_RECONNECT_ATTEMPTS})`);
        reconnectAttemptRef.current = attempt + 1;
        setTimeout(connectWebSocket, delay);
      } else {
        console.log('Max reconnect attempts reached');
        setWsStatus('failed');
      }
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    wsRef.current = ws;
  }, [fetchColumns, handleTaskNotificationUpdate, processOfflineQueue]);

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

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []);

  useEffect(() => {
    authApi.me().then((data) => {
      if (data.user) {
        setCurrentUser(data.user);
      }
    }).catch(console.error);
  }, []);

  useEffect(() => {
    if (!boardIdFromUrl && boards.length > 0) {
      const lastBoardId = localStorage.getItem(LAST_BOARD_KEY);
      const lastBoard = lastBoardId ? boards.find((b: Board) => b.id === lastBoardId) : null;
      const targetBoard = lastBoard || boards[0];
      navigate(`/board/${targetBoard.id}`);
    }
  }, [boardIdFromUrl, boards, navigate]);

  useEffect(() => {
    if (!boardIdFromUrl || boards.length === 0) return;

    const board = boards.find((b) => b.id === boardIdFromUrl);
    if (board) {
      if (currentBoard?.id !== board.id) {
        setBoardSwitching(true);
        setCurrentBoard(board);
      }
    } else {
      console.warn(`Board ${boardIdFromUrl} not found, redirecting to ${boards[0].id}`);
      navigate(`/board/${boards[0].id}`);
    }
  }, [boardIdFromUrl, boards, navigate, currentBoard?.id]);

  useEffect(() => {
    if (currentBoard) {
      fetchColumns(currentBoard.id);
    }
  }, [currentBoard?.id]);

  useEffect(() => {
    if (taskIdFromUrl && columns.length > 0) {
      const allTasks = columns.flatMap(col => col.tasks || []);
      const task = allTasks.find(t => t.id === taskIdFromUrl);
      if (task) {
        setSelectedTask(task);
        navigate('', { replace: true });
      }
    }
  }, [taskIdFromUrl, columns]);

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
        lastLocalUpdateRef.current = Date.now();
        const oldColumnId = columns.find(col => col.tasks.some(t => t.id === task.id))?.id;

        if (oldColumnId && oldColumnId !== task.columnId) {
          setColumns((cols) =>
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
          setColumns((cols) =>
            cols.map((col) => ({
              ...col,
              tasks: col.tasks.map((t) => (t.id === task.id ? parsedUpdated : t)),
            }))
          );
        }
        setSelectedTask(parsedUpdated);
      } else {
        const boardName = boards.find(b => b.id === targetBoardId)?.name || targetBoardId;
        console.log(boardName);
        setSelectedTask(null);
      }
    } catch (error) {
      console.error('Failed to update task:', error);
    }
  }, [columns, currentBoard?.id, boards]);

  const deleteTask = useCallback(async (taskId: string) => {
    lastLocalUpdateRef.current = Date.now();
    await tasksApi.delete(taskId);
    setColumns((cols) =>
      cols.map((col) => ({
        ...col,
        tasks: col.tasks.filter((t) => t.id !== taskId),
      }))
    );
    setSelectedTask(null);
  }, []);

  const archiveTask = useCallback(async (taskId: string) => {
    lastLocalUpdateRef.current = Date.now();
    await tasksApi.archive(taskId, true);
    setColumns((cols) =>
      cols.map((col) => ({
        ...col,
        tasks: col.tasks.filter((t) => t.id !== taskId),
      }))
    );
    setSelectedTask(null);
  }, []);

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
        lastLocalUpdateRef.current = Date.now();
        setColumns((cols) =>
          cols.map((col) =>
            col.id === targetColumnId
              ? { ...col, tasks: [{ ...newTask, comments: [], subtasks: [] }, ...col.tasks] }
              : col
          )
        );
      } else {
        const boardName = boards.find(b => b.id === targetBoardId)?.name || targetBoardId;
        console.log(boardName);
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
  }, [currentBoard?.id, boards, t]);

  const addComment = useCallback(async (taskId: string, content: string, author: string) => {
    try {
      lastLocalUpdateRef.current = Date.now();
      const comment = await commentsApi.create({ taskId, content, author });
      setColumns((cols) =>
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
  }, [selectedTask]);

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
      lastLocalUpdateRef.current = Date.now();
      await Promise.all(Array.from(selectedTasks).map(id => tasksApi.delete(id)));
      setColumns(cols => cols.map(col => ({
        ...col,
        tasks: col.tasks.filter(t => !selectedTasks.has(t.id))
      })));
      clearSelection();
    } catch (error) {
      console.error('Failed to batch delete:', error);
    }
  }, [selectedTasks, clearSelection]);

  const batchArchive = useCallback(async () => {
    if (selectedTasks.size === 0) return;

    try {
      lastLocalUpdateRef.current = Date.now();
      await Promise.all(Array.from(selectedTasks).map(id => tasksApi.archive(id, true)));
      setColumns(cols => cols.map(col => ({
        ...col,
        tasks: col.tasks.filter(t => !selectedTasks.has(t.id))
      })));
      clearSelection();
    } catch (error) {
      console.error('Failed to batch archive:', error);
    }
  }, [selectedTasks, clearSelection]);

  const batchMove = useCallback(async (targetColumnId: string) => {
    if (selectedTasks.size === 0) return;

    try {
      lastLocalUpdateRef.current = Date.now();
      await Promise.all(Array.from(selectedTasks).map(id => tasksApi.update(id, { columnId: targetColumnId })));
      const tasksToMove = columns.flatMap(col => col.tasks).filter(t => selectedTasks.has(t.id));
      
      setColumns(cols => cols.map(col => {
        if (col.id === targetColumnId) {
          return { ...col, tasks: [...col.tasks.filter(t => !selectedTasks.has(t.id)), ...tasksToMove.map(t => ({ ...t, columnId: targetColumnId }))] };
        }
        return { ...col, tasks: col.tasks.filter(t => !selectedTasks.has(t.id)) };
      }));
      clearSelection();
    } catch (error) {
      console.error('Failed to batch move:', error);
    }
  }, [selectedTasks, columns, clearSelection]);

  const batchUpdatePriority = useCallback(async (priority: string) => {
    if (selectedTasks.size === 0) return;

    try {
      lastLocalUpdateRef.current = Date.now();
      await Promise.all(Array.from(selectedTasks).map(id => tasksApi.update(id, { priority })));
      setColumns(cols => cols.map(col => ({
        ...col,
        tasks: col.tasks.map(t => selectedTasks.has(t.id) ? { ...t, priority } : t)
      })));
      clearSelection();
    } catch (error) {
      console.error('Failed to batch update priority:', error);
    }
  }, [selectedTasks, clearSelection]);

  const batchUpdateAssignee = useCallback(async (assignee: string) => {
    if (selectedTasks.size === 0) return;

    try {
      lastLocalUpdateRef.current = Date.now();
      await Promise.all(Array.from(selectedTasks).map(id => tasksApi.update(id, { assignee: assignee || null })));
      setColumns(cols => cols.map(col => ({
        ...col,
        tasks: col.tasks.map(t => selectedTasks.has(t.id) ? { ...t, assignee: assignee || null } : t)
      })));
      clearSelection();
    } catch (error) {
      console.error('Failed to batch update assignee:', error);
    }
  }, [selectedTasks, clearSelection]);

  const handleColumnRename = useCallback(async (columnId: string, newName: string) => {
    try {
      await columnsApi.update(columnId, { name: newName });
      setColumns((cols) =>
        cols.map((col) =>
          col.id === columnId ? { ...col, name: newName } : col
        )
      );
    } catch (error) {
      console.error('Failed to rename column:', error);
    }
  }, []);

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
    reconnectCount: _reconnectCount,
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