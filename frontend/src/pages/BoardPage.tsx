import { useState, useEffect, useRef } from 'react';
import { Link, useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  DndContext,
  DragOverlay,
  rectIntersection,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  DragStartEvent,
  DragEndEvent,
} from '@dnd-kit/core';
import { arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { Column } from '../components/Column';
import { TaskCard } from '../components/TaskCard';
import { TaskModal } from '../components/TaskModal';
import { AddTaskModal } from '../components/AddTaskModal';
import { UserAvatar } from '../components/UserAvatar';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { boardsApi, columnsApi, tasksApi, commentsApi, authApi, setGlobalErrorHandler } from '../services/api';
import { BoardSkeleton } from '../components/Skeleton';
import { ErrorToastContainer, showErrorToast } from '../components/ErrorToast';
import type { Board, Column as ColumnType, Task, User } from '../types/kanban';

const LAST_BOARD_KEY = 'lastSelectedBoardId';
const DARK_MODE_KEY = 'darkMode';
const FILTER_PRESETS_KEY = 'filterPresets';
const FAILED_TASK_CREATIONS_KEY = 'failedTaskCreations';

interface FailedTaskCreation {
  title: string;
  description: string;
  columnId: string;
  position: number;
  priority?: string;
  published: boolean;
  createdAt: string;
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

interface FilterState {
  priority: string;
  assignee: string;
  searchQuery: string;
  dateRange: string;
  tag: string;
}

interface FilterPreset {
  id: string;
  name: string;
  filters: FilterState;
}

export function BoardPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const params = useParams();
  const [searchParams] = useSearchParams();
  const boardIdFromUrl = params.boardId as string;
  const taskIdFromUrl = searchParams.get('taskId');

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
  const [showAddTaskModal, setShowAddTaskModal] = useState(false);
  const [defaultColumnIdForNewTask, setDefaultColumnIdForNewTask] = useState<string | undefined>();
  const [toast, setToast] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [darkMode, setDarkMode] = useState(() => {
    const saved = localStorage.getItem(DARK_MODE_KEY);
    return saved === 'true' || window.matchMedia('(prefers-color-scheme: dark)').matches;
  });
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);
  const [activeMobileColumn, setActiveMobileColumn] = useState<number>(0);
  const [mobileViewMode, setMobileViewMode] = useState<'tabs' | 'scroll'>('tabs');
  const [searchQuery, setSearchQuery] = useState('');
  const [showFilterPanel, setShowFilterPanel] = useState(false);
  const [filters, setFilters] = useState<FilterState>({ priority: '', assignee: '', searchQuery: '', dateRange: '', tag: '' });
  const [filterPresets, setFilterPresets] = useState<FilterPreset[]>(() => {
    const saved = localStorage.getItem(FILTER_PRESETS_KEY);
    return saved ? JSON.parse(saved) : [];
  });
  const [showPresetDropdown, setShowPresetDropdown] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [showBoardDropdown, setShowBoardDropdown] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [showPreferencesMenu, setShowPreferencesMenu] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showWsWarning, setShowWsWarning] = useState(false);
  const [focusedColumnIndex, setFocusedColumnIndex] = useState(0);
  const [focusedTaskIndex, setFocusedTaskIndex] = useState(0);
  const [editTaskId, setEditTaskId] = useState<string | null>(null);
  const filterPanelRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const preferencesMenuRef = useRef<HTMLDivElement>(null);
  const boardDropdownRef = useRef<HTMLDivElement>(null);
  const touchStartX = useRef<number>(0);
  const touchEndX = useRef<number>(0);
  const isDraggingRef = useRef<boolean>(false);
  const wsRef = useRef<WebSocket | null>(null);
  const currentBoardRef = useRef<Board | null>(null);
  const offlineQueueRef = useRef<Array<{action: string; data: any; timestamp: number}>>([]);
  const isProcessingQueueRef = useRef<boolean>(false);
  const lastLocalUpdateRef = useRef<number>(0);
  const REFRESH_DEBOUNCE_MS = 1000;
  const [columnPagination, setColumnPagination] = useState<Record<string, { page: number; hasMore: boolean; isLoadingMore: boolean }>>({});
  const [confirmDialog, setConfirmDialog] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
    variant?: 'danger' | 'warning' | 'default';
  }>({ isOpen: false, title: '', message: '', onConfirm: () => {} });

  const showToastMessage = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 2000);
  };

  const allTasks = columns.flatMap(col => col.tasks || []);
  const uniqueAssignees = [...new Set(allTasks.filter(t => t.assignee).map(t => t.assignee as string))];
  const uniqueTags = [...new Set(allTasks.filter(t => t.meta && typeof t.meta === 'object' && '标签' in t.meta).map(t => (t.meta as Record<string, any>)['标签'] as string).filter(Boolean))];

  const isInDateRange = (taskCreatedAt: string): boolean => {
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
  };

  const getFilteredColumns = () => {
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
  };

  const saveCurrentAsPreset = () => {
    const name = prompt(t('filter.presetName'));
    if (!name?.trim()) return;
    const newPreset: FilterPreset = {
      id: Date.now().toString(),
      name: name.trim(),
      filters: { ...filters }
    };
    setFilterPresets(prev => [...prev, newPreset]);
  };

  const applyPreset = (preset: FilterPreset) => {
    setFilters(preset.filters);
    setSearchQuery(preset.filters.searchQuery);
    setShowPresetDropdown(false);
  };

  const deletePreset = (presetId: string) => {
    setFilterPresets(prev => prev.filter(p => p.id !== presetId));
  };

  const clearFilters = () => {
    setFilters({ priority: '', assignee: '', searchQuery: '', dateRange: '', tag: '' });
    setSearchQuery('');
  };

  const hasActiveFilters = filters.searchQuery || filters.priority || filters.assignee || filters.dateRange || filters.tag;

  const handleExport = async (format: 'json' | 'csv') => {
    if (!currentBoard) return;
    try {
      const response = await boardsApi.export(currentBoard.id, format);
      if (!response.ok) {
        throw new Error('Export failed');
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      a.download = `${currentBoard.name}_${timestamp}.${format}`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      setShowExportMenu(false);
      setShowMoreMenu(false);
    } catch (error) {
      console.error('Export failed:', error);
      showToastMessage(t('export.failed'));
    }
  };

  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    localStorage.setItem(DARK_MODE_KEY, String(darkMode));
  }, [darkMode]);

  useEffect(() => {
    localStorage.setItem(FILTER_PRESETS_KEY, JSON.stringify(filterPresets));
  }, [filterPresets]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (showFilterPanel && filterPanelRef.current && !filterPanelRef.current.contains(e.target as Node)) {
        setShowFilterPanel(false);
      }
      if (showMoreMenu && moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setShowMoreMenu(false);
        setShowExportMenu(false);
        setShowPreferencesMenu(false);
      }
      if (showUserMenu && userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setShowUserMenu(false);
      }
      if (showExportMenu && exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setShowExportMenu(false);
      }
      if (showPreferencesMenu && preferencesMenuRef.current && !preferencesMenuRef.current.contains(e.target as Node)) {
        setShowPreferencesMenu(false);
      }
      if (showBoardDropdown && boardDropdownRef.current && !boardDropdownRef.current.contains(e.target as Node)) {
        setShowBoardDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showFilterPanel, showMoreMenu, showUserMenu, showExportMenu, showPreferencesMenu, showBoardDropdown]);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    if (!isMobile) return;

    const handleTouchStart = (e: TouchEvent) => {
      if (isDraggingRef.current) return;
      touchStartX.current = e.touches[0].clientX;
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (isDraggingRef.current) return;
      touchEndX.current = e.touches[0].clientX;
    };

    const handleTouchEnd = () => {
      if (isDraggingRef.current) return;
      const deltaX = touchEndX.current - touchStartX.current;
      const minSwipeDistance = 50;

      if (mobileViewMode === 'tabs') {
        if (Math.abs(deltaX) > minSwipeDistance) {
          if (deltaX > 0 && activeMobileColumn > 0) {
            setActiveMobileColumn((prev) => prev - 1);
          } else if (deltaX < 0 && activeMobileColumn < columns.length - 1) {
            setActiveMobileColumn((prev) => prev + 1);
          }
        }
      } else {
        const scrollContainer = document.getElementById('mobile-scroll-container');
        if (scrollContainer && Math.abs(deltaX) > minSwipeDistance) {
          if (deltaX > 0) {
            scrollContainer.scrollLeft -= 100;
          } else {
            scrollContainer.scrollLeft += 100;
          }
        }
      }
      touchStartX.current = 0;
      touchEndX.current = 0;
    };

    const tabsContainer = document.getElementById('mobile-column-container');
    const scrollContainer = document.getElementById('mobile-scroll-container');

    if (mobileViewMode === 'tabs' && tabsContainer) {
      tabsContainer.addEventListener('touchstart', handleTouchStart, { passive: true });
      tabsContainer.addEventListener('touchmove', handleTouchMove, { passive: true });
      tabsContainer.addEventListener('touchend', handleTouchEnd, { passive: true });
    }

    if (mobileViewMode === 'scroll' && scrollContainer) {
      scrollContainer.addEventListener('touchstart', handleTouchStart, { passive: true });
      scrollContainer.addEventListener('touchmove', handleTouchMove, { passive: true });
      scrollContainer.addEventListener('touchend', handleTouchEnd, { passive: true });
    }

    return () => {
      if (tabsContainer) {
        tabsContainer.removeEventListener('touchstart', handleTouchStart);
        tabsContainer.removeEventListener('touchmove', handleTouchMove);
        tabsContainer.removeEventListener('touchend', handleTouchEnd);
      }
      if (scrollContainer) {
        scrollContainer.removeEventListener('touchstart', handleTouchStart);
        scrollContainer.removeEventListener('touchmove', handleTouchMove);
        scrollContainer.removeEventListener('touchend', handleTouchEnd);
      }
    };
  }, [isMobile, activeMobileColumn, columns.length, mobileViewMode]);

  useEffect(() => {
    setGlobalErrorHandler((error) => {
      showErrorToast(error.message, 'error');
    });
    return () => setGlobalErrorHandler(null);
  }, []);

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
    const scrollContainer = document.getElementById('columns-scroll-container');
    const fadeLeft = document.getElementById('scroll-fade-left');
    const fadeRight = document.getElementById('scroll-fade-right');
    const scrollHint = document.getElementById('scroll-hint');

    if (!scrollContainer || !fadeLeft || !fadeRight || !scrollHint) return;

    const updateScrollIndicators = () => {
      const { scrollLeft, scrollWidth, clientWidth } = scrollContainer;
      const hasOverflow = scrollWidth > clientWidth;
      const isAtStart = scrollLeft === 0;
      const isAtEnd = scrollLeft >= scrollWidth - clientWidth - 1;

      fadeLeft.style.opacity = (!isMobile && hasOverflow && !isAtStart) ? '1' : '0';
      fadeRight.style.opacity = (!isMobile && hasOverflow && !isAtEnd) ? '1' : '0';
      scrollHint.style.opacity = (!isMobile && hasOverflow && (isAtStart || isAtEnd)) ? '1' : '0';
    };

    scrollContainer.addEventListener('scroll', updateScrollIndicators);
    updateScrollIndicators();

    const resizeObserver = new ResizeObserver(updateScrollIndicators);
    resizeObserver.observe(scrollContainer);

    return () => {
      scrollContainer.removeEventListener('scroll', updateScrollIndicators);
      resizeObserver.disconnect();
    };
  }, [isMobile, columns.length]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: isMobile ? 16 : 8,
      },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 250,
        tolerance: 5,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

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
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'n') {
        e.preventDefault();
        setShowAddTaskModal(true);
        return;
      }

      const target = e.target as HTMLElement;
      const isInputFocused = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable;

      if (e.key === '/' && !isInputFocused) {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }



      if (e.key === 'e' && !isInputFocused && selectedTask) {
        e.preventDefault();
        setEditTaskId(selectedTask.id);
        return;
      }

      if ((e.key === 'n' || e.key === 'N') && !isInputFocused) {
        e.preventDefault();
        setShowAddTaskModal(true);
        return;
      }

      if (e.key === 'Escape') {
        if (showAddTaskModal) {
          setShowAddTaskModal(false);
          setDefaultColumnIdForNewTask(undefined);
        } else if (selectedTask) {
          setSelectedTask(null);
          setEditTaskId(null);
        } else if (selectedTasks.size > 0) {
          clearSelection();
        }
        return;
      }

      if (isInputFocused) return;

      const currentColumn = columns[focusedColumnIndex];
      const columnTasks = currentColumn?.tasks || [];

      if (e.key === 'j' || e.key === 'J') {
        e.preventDefault();
        if (columnTasks.length === 0) return;
        const newIndex = Math.min(focusedTaskIndex + 1, columnTasks.length - 1);
        setFocusedTaskIndex(newIndex);
        const task = columnTasks[newIndex];
        if (task) {
          setSelectedTasks(new Set([task.id]));
          setLastSelectedTaskId(task.id);
        }
        return;
      }

      if (e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        if (columnTasks.length === 0) return;
        const newIndex = Math.max(focusedTaskIndex - 1, 0);
        setFocusedTaskIndex(newIndex);
        const task = columnTasks[newIndex];
        if (task) {
          setSelectedTasks(new Set([task.id]));
          setLastSelectedTaskId(task.id);
        }
        return;
      }

      if (e.key === 'h' || e.key === 'H') {
        e.preventDefault();
        if (columns.length === 0) return;
        const newColIndex = Math.max(focusedColumnIndex - 1, 0);
        setFocusedColumnIndex(newColIndex);
        const col = columns[newColIndex];
        if (col.tasks && col.tasks.length > 0) {
          setFocusedTaskIndex(0);
          setSelectedTasks(new Set([col.tasks[0].id]));
          setLastSelectedTaskId(col.tasks[0].id);
        }
        return;
      }

      if (e.key === 'l' || e.key === 'L') {
        e.preventDefault();
        if (columns.length === 0) return;
        const newColIndex = Math.min(focusedColumnIndex + 1, columns.length - 1);
        setFocusedColumnIndex(newColIndex);
        const col = columns[newColIndex];
        if (col.tasks && col.tasks.length > 0) {
          setFocusedTaskIndex(0);
          setSelectedTasks(new Set([col.tasks[0].id]));
          setLastSelectedTaskId(col.tasks[0].id);
        }
        return;
      }

      if (e.key === 'd' || e.key === 'D') {
        if (selectedTask) {
          e.preventDefault();
          archiveTask(selectedTask.id);
        } else if (selectedTasks.size > 0) {
          e.preventDefault();
          batchArchive();
        }
        return;
      }

      if (e.key === 'Delete') {
        if (selectedTask) {
          e.preventDefault();
          setConfirmDialog({
            isOpen: true,
            title: t('task.confirmDeleteTitle') || t('modal.deleteConfirmTitle'),
            message: t('task.confirmDelete'),
            variant: 'danger',
            onConfirm: () => {
              deleteTask(selectedTask.id);
              setConfirmDialog(prev => ({ ...prev, isOpen: false }));
            },
          });
        } else if (selectedTasks.size > 0) {
          e.preventDefault();
          setConfirmDialog({
            isOpen: true,
            title: t('task.confirmBatchDeleteTitle') || t('modal.deleteConfirmTitle'),
            message: t('task.confirmBatchDelete', { count: selectedTasks.size }),
            variant: 'danger',
            onConfirm: () => {
              batchDelete();
              setConfirmDialog(prev => ({ ...prev, isOpen: false }));
            },
          });
        }
        return;
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [selectedTask, selectedTasks, showAddTaskModal, columns, focusedColumnIndex, focusedTaskIndex, t]);

  const fetchBoards = async () => {
    try {
      const data = await boardsApi.getAll();
      setBoards(data || []);
    } catch (error) {
      console.error('Failed to fetch boards:', error);
    }
  };

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

  const MAX_RECONNECT_ATTEMPTS = 10;
  const MAX_RECONNECT_DELAY = 30000;

  const getReconnectDelay = (attempt: number) => {
    const delay = Math.min(1000 * Math.pow(2, attempt), MAX_RECONNECT_DELAY);
    return delay;
  };

  const processOfflineQueue = async () => {
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
  };

  const connectWebSocket = () => {
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

    ws.onopen = () => {
      console.log('WebSocket connected');
      setWsStatus('connected');
      setShowWsWarning(false);
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
            } else if (action === 'new_comment') {
            }
          }
        }
      } catch {
        console.error('Failed to parse WebSocket message');
      }
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected');
      setShowWsWarning(true);
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
  };

  const fetchColumns = async (boardId: string, silent = false) => {
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
  };

  const handleLoadMoreTasks = async (columnId: string) => {
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
  };

  const handleTaskNotificationUpdate = async (taskId: string) => {
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
  };

  const handleDragStart = (event: DragStartEvent) => {
    isDraggingRef.current = true;
    const { active } = event;
    const task = columns.flatMap((col) => col.tasks).find((t) => t.id === active.id);
    if (task) setActiveTask(task);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    isDraggingRef.current = false;
    const { active, over } = event;
    setActiveTask(null);

    if (!over) return;

    const activeId = active.id as string;
    const overId = over.id as string;

    const activeColumn = columns.find((col) => col.tasks?.some((t) => t.id === activeId));
    const overColumn = columns.find(
      (col) => col.id === overId || col.tasks?.some((t) => t.id === overId)
    );

    if (!activeColumn || !overColumn) return;

    if (activeColumn.id === overColumn.id) {
      const tasks = activeColumn.tasks ?? [];
      const oldIndex = tasks.findIndex((t) => t.id === activeId);
      const newIndex = tasks.findIndex((t) => t.id === overId);

      if (oldIndex !== newIndex) {
        const newTasks = arrayMove(tasks, oldIndex, newIndex).map((t, i) => ({
          ...t,
          position: i,
        }));

        setColumns((cols) =>
          cols.map((col) => (col.id === activeColumn.id ? { ...col, tasks: newTasks } : col))
        );

        await tasksApi.update(activeId, { position: newTasks[newIndex].position });
      }
    } else {
      const tasks = (activeColumn.tasks ?? []).filter((t) => t.id !== activeId);
      const overTasks = [...(overColumn.tasks ?? [])];
      const newIndex = overTasks.findIndex((t) => t.id === overId);

      if (newIndex >= 0) {
        overTasks.splice(newIndex, 0, { ...activeTask!, columnId: overColumn.id });
      } else {
        overTasks.push({ ...activeTask!, columnId: overColumn.id });
      }

      const updatedTasks = overTasks.map((t, i) => ({ ...t, position: i }));
      const movedTask = updatedTasks.find((t) => t.id === activeId);
      const movedTaskNewIndex = updatedTasks.findIndex((t) => t.id === activeId);

      setColumns((cols) =>
        cols.map((col) => {
          if (col.id === activeColumn.id) return { ...col, tasks: tasks ?? [] };
          if (col.id === overColumn.id) return { ...col, tasks: updatedTasks ?? [] };
          return col;
        })
      );

      if (movedTask) {
        lastLocalUpdateRef.current = Date.now();
        await tasksApi.update(activeId, {
          position: movedTaskNewIndex,
          columnId: movedTask.columnId
        });
      }
    }
  };

  const updateTask = async (task: Task) => {
    const currentBoardId = currentBoard?.id || '';
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
        showToastMessage(t('board.taskPublished', { boardName }));
        setSelectedTask(null);
      }
    } catch (error) {
      console.error('Failed to update task:', error);
    }
  };

  const deleteTask = async (taskId: string) => {
    lastLocalUpdateRef.current = Date.now();
    await tasksApi.delete(taskId);
    setColumns((cols) =>
      cols.map((col) => ({
        ...col,
        tasks: col.tasks.filter((t) => t.id !== taskId),
      }))
    );
    setSelectedTask(null);
  };

  const archiveTask = async (taskId: string) => {
    lastLocalUpdateRef.current = Date.now();
    await tasksApi.archive(taskId, true);
    setColumns((cols) =>
      cols.map((col) => ({
        ...col,
        tasks: col.tasks.filter((t) => t.id !== taskId),
      }))
    );
    setSelectedTask(null);
  };

  const handleTaskSelect = (taskId: string, _task: Task, e?: any) => {
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
  };

  const clearSelection = () => {
    setSelectedTasks(new Set());
    setLastSelectedTaskId(null);
  };

  const batchDelete = async () => {
    if (selectedTasks.size === 0) return;

    try {
      lastLocalUpdateRef.current = Date.now();
      await Promise.all(Array.from(selectedTasks).map(id => tasksApi.delete(id)));
      setColumns(cols => cols.map(col => ({
        ...col,
        tasks: col.tasks.filter(t => !selectedTasks.has(t.id))
      })));
      showToastMessage(t('task.batchDeleted', { count: selectedTasks.size }));
      clearSelection();
    } catch (error) {
      console.error('Failed to batch delete:', error);
      showToastMessage(t('toast.saveFailed'));
    }
  };

  const batchArchive = async () => {
    if (selectedTasks.size === 0) return;

    try {
      lastLocalUpdateRef.current = Date.now();
      await Promise.all(Array.from(selectedTasks).map(id => tasksApi.archive(id, true)));
      setColumns(cols => cols.map(col => ({
        ...col,
        tasks: col.tasks.filter(t => !selectedTasks.has(t.id))
      })));
      showToastMessage(t('task.batchArchived', { count: selectedTasks.size }));
      clearSelection();
    } catch (error) {
      console.error('Failed to batch archive:', error);
      showToastMessage(t('toast.saveFailed'));
    }
  };

  const batchMove = async (targetColumnId: string) => {
    if (selectedTasks.size === 0) return;

    try {
      lastLocalUpdateRef.current = Date.now();
      await Promise.all(Array.from(selectedTasks).map(id => tasksApi.update(id, { columnId: targetColumnId })));
      const targetColumn = columns.find(col => col.id === targetColumnId);
      const tasksToMove = columns.flatMap(col => col.tasks).filter(t => selectedTasks.has(t.id));
      
      setColumns(cols => cols.map(col => {
        if (col.id === targetColumnId) {
          return { ...col, tasks: [...col.tasks.filter(t => !selectedTasks.has(t.id)), ...tasksToMove.map(t => ({ ...t, columnId: targetColumnId }))] };
        }
        return { ...col, tasks: col.tasks.filter(t => !selectedTasks.has(t.id)) };
      }));
      showToastMessage(t('task.batchMoved', { count: selectedTasks.size, column: targetColumn?.name }));
      clearSelection();
    } catch (error) {
      console.error('Failed to batch move:', error);
      showToastMessage(t('toast.saveFailed'));
    }
  };

  const batchUpdatePriority = async (priority: string) => {
    if (selectedTasks.size === 0) return;

    try {
      lastLocalUpdateRef.current = Date.now();
      await Promise.all(Array.from(selectedTasks).map(id => tasksApi.update(id, { priority })));
      setColumns(cols => cols.map(col => ({
        ...col,
        tasks: col.tasks.map(t => selectedTasks.has(t.id) ? { ...t, priority } : t)
      })));
      showToastMessage(t('task.batchPriorityUpdated', { count: selectedTasks.size }));
      clearSelection();
    } catch (error) {
      console.error('Failed to batch update priority:', error);
      showToastMessage(t('toast.saveFailed'));
    }
  };

  const batchUpdateAssignee = async (assignee: string) => {
    if (selectedTasks.size === 0) return;

    try {
      lastLocalUpdateRef.current = Date.now();
      await Promise.all(Array.from(selectedTasks).map(id => tasksApi.update(id, { assignee: assignee || null })));
      setColumns(cols => cols.map(col => ({
        ...col,
        tasks: col.tasks.map(t => selectedTasks.has(t.id) ? { ...t, assignee: assignee || null } : t)
      })));
      showToastMessage(t('task.batchAssigneeUpdated', { count: selectedTasks.size }));
      clearSelection();
    } catch (error) {
      console.error('Failed to batch update assignee:', error);
      showToastMessage(t('toast.saveFailed'));
    }
  };

  const handleColumnRename = async (columnId: string, newName: string) => {
    try {
      await columnsApi.update(columnId, { name: newName });
      setColumns((cols) =>
        cols.map((col) =>
          col.id === columnId ? { ...col, name: newName } : col
        )
      );
    } catch (error) {
      console.error('Failed to rename column:', error);
      showToastMessage(t('toast.saveFailed'));
    }
  };

  const addTask = async (columnId?: string, title?: string, description?: string, published?: boolean, boardId?: string, priority?: string) => {
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
        showToastMessage(t('board.taskCreated', { boardName }));
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
      showToastMessage(t('toast.saveFailed'));
    }
  };

  const addComment = async (taskId: string, content: string, author: string) => {
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
  };

  if (loading || boardSwitching) {
    return <BoardSkeleton />;
  }

  if (loadError) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4">
        <div className="text-red-500">{t('app.error.loadFailed')}</div>
        <div className="text-sm text-zinc-400">{loadError}</div>
        <button
          onClick={() => currentBoard && fetchColumns(currentBoard.id)}
          className="rounded-md bg-blue-500 px-4 py-2 text-sm text-white hover:bg-blue-600"
        >
          {t('app.error.retry')}
        </button>
      </div>
    );
  }

  return (
    <div className="h-screen bg-zinc-100 dark:bg-zinc-900">
      {showWsWarning && wsStatus !== 'connected' && (
        <div style={{ position: 'fixed', bottom: '1rem', left: '1rem', zIndex: 9, minWidth: 300, width: 'auto' }} className="rounded-lg bg-orange-100 border border-orange-300 px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-orange-600">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/>
              <line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
            <span className="text-sm font-medium text-orange-800">
              {wsStatus === 'failed' ? t('wsStatus.connectionFailed') : t('wsStatus.connectionLost')}
            </span>
            <span className="text-xs text-orange-600">
              {_reconnectCount > 0 && ` (${t('wsStatus.reconnecting', { attempt: _reconnectCount, max: MAX_RECONNECT_ATTEMPTS })})`}
            </span>
          </div>
          <button
            onClick={() => {
              reconnectAttemptRef.current = 0;
              setReconnectCount(0);
              setWsStatus('disconnected');
              connectWebSocket();
            }}
            className="text-xs text-orange-600 hover:text-orange-800 font-medium"
          >
            {t('wsStatus.retryNow')}
          </button>
        </div>
      )}
      <header className="p-6 pb-0 mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div ref={boardDropdownRef} className="relative">
            <button
              onClick={() => setShowBoardDropdown(!showBoardDropdown)}
              className="flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 py-1 text-sm hover:bg-zinc-50 max-w-36"
              title={currentBoard?.name || boards.find(b => b.id === boardIdFromUrl)?.name || t('board.selectBoard')}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
              </svg>
              <span className="truncate max-w-24">{currentBoard?.name || boards.find(b => b.id === boardIdFromUrl)?.name || t('board.selectBoard')}</span>
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </button>
            {showBoardDropdown && (
              <div className="absolute left-0 top-full mt-1 w-48 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg z-50">
                {boards.map((board) => (
                  <button
                    key={board.id}
                    onClick={() => {
                      localStorage.setItem(LAST_BOARD_KEY, board.id);
                      setShowBoardDropdown(false);
                      if (board.id !== boardIdFromUrl) {
                        navigate(`/board/${board.id}`);
                      }
                    }}
                    className={`w-full px-3 py-2 text-left text-sm hover:bg-zinc-100 ${board.id === boardIdFromUrl ? 'bg-blue-50 text-blue-700 font-medium' : 'text-zinc-700'}`}
                  >
                    {board.name}
                  </button>
                ))}
              </div>
            )}
          </div>
          <Link
            to={`/columns?boardId=${boardIdFromUrl}`}
            className="flex items-center rounded-md border border-zinc-200 bg-white p-1.5 text-zinc-600 hover:bg-zinc-50"
            title={t('column.manageColumns')}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/>
            </svg>
          </Link>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative flex items-center">
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setFilters(prev => ({ ...prev, searchQuery: e.target.value }));
              }}
              onBlur={() => {
                setFocusedColumnIndex(0);
                setFocusedTaskIndex(0);
              }}
              placeholder={t('filter.searchPlaceholder')}
              className="w-40 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
            {searchQuery && (
              <button
                onClick={() => {
                  setSearchQuery('');
                  setFilters(prev => ({ ...prev, searchQuery: '' }));
                }}
                className="absolute right-2 text-zinc-400 hover:text-zinc-600"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            )}
          </div>
          <div className="relative">
            <button
              onClick={() => setShowFilterPanel(!showFilterPanel)}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm ${hasActiveFilters ? 'bg-blue-100 text-blue-700 border border-blue-300' : 'bg-zinc-200 text-zinc-700 border border-transparent'} hover:bg-zinc-300`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
              </svg>
              {t('filter.filter')}
              {hasActiveFilters && (
                <span className="ml-1 rounded-full bg-blue-500 text-white text-xs w-4 h-4 flex items-center justify-center">
                  {[filters.searchQuery, filters.priority, filters.assignee, filters.dateRange, filters.tag].filter(Boolean).length}
                </span>
              )}
            </button>
            {showFilterPanel && (
              <div ref={filterPanelRef} className="absolute right-0 top-full mt-2 w-64 rounded-lg border border-zinc-200 bg-white p-3 shadow-lg z-50">
                <div className="mb-3">
                  <label className="block text-xs font-medium text-zinc-500 mb-1">{t('filter.priority')}</label>
                  <select
                    value={filters.priority}
                    onChange={(e) => setFilters(prev => ({ ...prev, priority: e.target.value }))}
                    className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-sm"
                  >
                    <option value="">{t('filter.all')}</option>
                    <option value="high">{t('filter.high')}</option>
                    <option value="medium">{t('filter.medium')}</option>
                    <option value="low">{t('filter.low')}</option>
                  </select>
                </div>
                <div className="mb-3">
                  <label className="block text-xs font-medium text-zinc-500 mb-1">{t('filter.assignee')}</label>
                  <select
                    value={filters.assignee}
                    onChange={(e) => setFilters(prev => ({ ...prev, assignee: e.target.value }))}
                    className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-sm"
                  >
                    <option value="">{t('filter.all')}</option>
                    {uniqueAssignees.map(a => (
                      <option key={a} value={a}>{a}</option>
                    ))}
                  </select>
                </div>
                <div className="mb-3">
                  <label className="block text-xs font-medium text-zinc-500 mb-1">{t('filter.dateRange')}</label>
                  <select
                    value={filters.dateRange}
                    onChange={(e) => setFilters(prev => ({ ...prev, dateRange: e.target.value }))}
                    className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-sm"
                  >
                    <option value="">{t('filter.all')}</option>
                    <option value="today">{t('filter.today')}</option>
                    <option value="thisWeek">{t('filter.thisWeek')}</option>
                    <option value="thisMonth">{t('filter.thisMonth')}</option>
                  </select>
                </div>
                {uniqueTags.length > 0 && (
                  <div className="mb-3">
                    <label className="block text-xs font-medium text-zinc-500 mb-1">{t('filter.tag')}</label>
                    <select
                      value={filters.tag}
                      onChange={(e) => setFilters(prev => ({ ...prev, tag: e.target.value }))}
                      className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-sm"
                    >
                      <option value="">{t('filter.all')}</option>
                      {uniqueTags.map(tag => (
                        <option key={tag} value={tag}>{tag}</option>
                      ))}
                    </select>
                  </div>
                )}
                <div className="flex gap-2 pt-2 border-t border-zinc-100">
                  <button
                    onClick={clearFilters}
                    className="flex-1 rounded-md bg-zinc-100 px-2 py-1.5 text-sm text-zinc-700 hover:bg-zinc-200"
                  >
                    {t('filter.clear')}
                  </button>
                  <button
                    onClick={saveCurrentAsPreset}
                    className="flex-1 rounded-md bg-blue-500 px-2 py-1.5 text-sm text-white hover:bg-blue-600"
                  >
                    {t('filter.savePreset')}
                  </button>
                </div>
                {filterPresets.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-zinc-100">
                    <div className="flex items-center justify-between mb-2">
                      <label className="text-xs font-medium text-zinc-500">{t('filter.preset')}</label>
                      <button
                        onClick={() => setShowPresetDropdown(!showPresetDropdown)}
                        className="text-xs text-blue-500 hover:text-blue-600"
                      >
                        {showPresetDropdown ? t('filter.collapse') : t('filter.expand')}
                      </button>
                    </div>
                    {showPresetDropdown && (
                      <div className="space-y-1">
                        {filterPresets.map(preset => (
                          <div key={preset.id} className="flex items-center justify-between group">
                            <button
                              onClick={() => applyPreset(preset)}
                              className="flex-1 text-left px-2 py-1 text-sm rounded hover:bg-zinc-100"
                            >
                              {preset.name}
                            </button>
                            <button
                              onClick={() => deletePreset(preset.id)}
                              className="opacity-0 group-hover:opacity-100 text-red-500 hover:text-red-600 px-1"
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                              </svg>
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          <button
            onClick={() => {
              setDefaultColumnIdForNewTask(undefined);
              setShowAddTaskModal(true);
            }}
            className="flex items-center gap-1.5 rounded-md bg-blue-500 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-600"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            {t('task.create')}
          </button>
        </div>
        <div className="flex items-center gap-3">
          {currentUser?.role === 'ADMIN' && (
            <Link
              to="/agent-activity"
              className="flex items-center gap-1.5 rounded-md bg-zinc-100 px-2.5 py-1.5 text-sm hover:bg-zinc-200"
              title={t('nav.agentActivity')}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/>
                <path d="M12 8v4"/>
                <rect x="8" y="14" width="8" height="6" rx="1"/>
                <path d="M9 17h0.01"/>
                <path d="M15 17h0.01"/>
              </svg>
            </Link>
          )}
          <div className="relative">
            <button
              onClick={() => {
                if (showUserMenu) setShowUserMenu(false);
                setShowMoreMenu(!showMoreMenu);
              }}
              className="flex items-center gap-1 rounded-md bg-zinc-100 px-2.5 py-1.5 text-sm hover:bg-zinc-200"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/>
              </svg>
            </button>
            {showMoreMenu && (
              <div ref={moreMenuRef} className="absolute right-0 top-full mt-1 w-44 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg z-50">
                <Link to="/boards" onClick={() => setShowMoreMenu(false)} className="block px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100">
                  {t('nav.manageBoards')}
                </Link>
                <Link to="/drafts" onClick={() => setShowMoreMenu(false)} className="block px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100">
                  {t('nav.drafts')}
                </Link>
                <Link to="/history" onClick={() => setShowMoreMenu(false)} className="block px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100">
                  {t('nav.history')}
                </Link>
                <Link to="/completed" onClick={() => setShowMoreMenu(false)} className="block px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100">
                  {t('nav.completed')}
                </Link>
                {currentUser?.role === 'ADMIN' && (
                  <>
                    <Link to="/settings?tab=users" onClick={() => setShowMoreMenu(false)} className="block px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100">
                      {t('nav.admin')}
                    </Link>
                    <Link to="/activities" onClick={() => setShowMoreMenu(false)} className="block px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100">
                      {t('nav.activityLog')}
                    </Link>
                    <Link to="/agent-activity" onClick={() => setShowMoreMenu(false)} className="block px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100">
                      {t('nav.agentActivity')}
                    </Link>
                  </>
                )}
                <div className="border-t border-zinc-100 my-1" />
                <div className="relative">
                  <button
                    onClick={() => setShowExportMenu(!showExportMenu)}
                    className="w-full flex items-center justify-between px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
                  >
                    <span>{t('nav.export')}</span>
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="9 18 15 12 9 6"/>
                    </svg>
                  </button>
                  {showExportMenu && (
                    <div className="absolute left-full top-0 ml-1 w-36 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg z-50">
                      <button
                        onClick={() => handleExport('json')}
                        className="w-full px-4 py-2 text-left text-sm text-zinc-700 hover:bg-zinc-100"
                      >
                        JSON
                      </button>
                      <button
                        onClick={() => handleExport('csv')}
                        className="w-full px-4 py-2 text-left text-sm text-zinc-700 hover:bg-zinc-100"
                      >
                        CSV
                      </button>
                    </div>
                  )}
                </div>
                <div className="relative">
                  <button
                    onClick={() => setShowPreferencesMenu(!showPreferencesMenu)}
                    className="w-full flex items-center justify-between px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
                  >
                    <span>{t('nav.preferences')}</span>
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="9 18 15 12 9 6"/>
                    </svg>
                  </button>
                  {showPreferencesMenu && (
                    <div className="absolute left-full top-0 ml-1 w-40 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg z-50">
                      <button
                        onClick={() => {
                          const newLang = i18n.language === 'zh' ? 'en' : 'zh';
                          i18n.changeLanguage(newLang);
                          localStorage.setItem('language', newLang);
                          setShowPreferencesMenu(false);
                          setShowMoreMenu(false);
                        }}
                        className="w-full flex items-center justify-between px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
                      >
                        <span>{t('nav.language')}</span>
                        <span className="text-xs text-zinc-500">{i18n.language === 'zh' ? t('language.en') : t('language.zh')}</span>
                      </button>
                      <button
                        onClick={() => {
                          setDarkMode(!darkMode);
                          setShowPreferencesMenu(false);
                          setShowMoreMenu(false);
                        }}
                        className="w-full flex items-center justify-between px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
                      >
                        <span>{t('nav.theme')}</span>
                        {darkMode ? (
                          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-orange-400">
                            <circle cx="12" cy="12" r="5"/>
                            <line x1="12" y1="1" x2="12" y2="3"/>
                            <line x1="12" y1="21" x2="12" y2="23"/>
                            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
                            <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
                            <line x1="1" y1="12" x2="3" y2="12"/>
                            <line x1="21" y1="12" x2="23" y2="12"/>
                            <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
                            <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
                          </svg>
                        ) : (
                          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-400">
                            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
                          </svg>
                        )}
                      </button>
                      <div className="border-t border-zinc-100 my-1" />
                      <Link
                        to="/settings"
                        onClick={() => setShowMoreMenu(false)}
                        className="block px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
                      >
                        {t('settings.title')}
                      </Link>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
          {currentUser && (
            <div className="relative">
              <button
                onClick={() => {
                  if (showMoreMenu) setShowMoreMenu(false);
                  setShowUserMenu(!showUserMenu);
                }}
                className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-zinc-100"
              >
                <UserAvatar
                  username={currentUser.nickname}
                  avatar={currentUser.avatar}
                  size="sm"
                />
                <span className={`text-xs ${wsStatus === 'connected' ? 'text-green-600' : wsStatus === 'failed' ? 'text-red-500' : 'text-red-400'}`}>
                  {wsStatus === 'connected' ? '●' : '○'}
                </span>
              </button>
              {showUserMenu && (
                <div ref={userMenuRef} className="absolute right-0 top-full mt-1 w-48 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg z-50">
                  <div className="px-4 py-2 border-b border-zinc-100">
                    <p className="text-sm font-medium text-zinc-800">{currentUser.nickname}</p>
                    <p className="text-xs text-zinc-500 capitalize">{currentUser.role.toLowerCase()}</p>
                  </div>
                  <button
                    onClick={() => {
                      if (wsStatus === 'failed') {
                        reconnectAttemptRef.current = 0;
                        setReconnectCount(0);
                        setWsStatus('disconnected');
                        connectWebSocket();
                      }
                      setShowUserMenu(false);
                    }}
                    className="w-full flex items-center gap-2 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
                  >
                    <span className={wsStatus === 'connected' ? 'text-green-600' : wsStatus === 'failed' ? 'text-red-500' : 'text-red-400'}>
                      {wsStatus === 'connected' ? '●' : '○'}
                    </span>
                    <span>{t('status.connection')}</span>
                    <span className="text-xs text-zinc-400 ml-auto">
                      {wsStatus === 'connected' ? t('status.connected') : wsStatus === 'failed' ? t('status.reconnect') : t('status.connecting')}
                    </span>
                  </button>
                  <Link
                    to="/settings"
                    onClick={() => setShowUserMenu(false)}
                    className="block px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
                  >
                    {t('settings.title')}
                  </Link>
                  <button
                    onClick={() => {
                      localStorage.removeItem('token');
                      navigate('/login');
                    }}
                    className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-zinc-100"
                  >
                    {t('auth.logout')}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </header>

    <div className="bg-zinc-100 dark:bg-zinc-900">
      <DndContext
      sensors={sensors}
      collisionDetection={rectIntersection}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      {isMobile ? (
        <div className="flex flex-col h-[calc(100vh-120px)]">
          <div className="flex items-center justify-between gap-2 p-2 border-b border-zinc-200 dark:border-zinc-700">
            <div className="flex gap-2 overflow-x-auto snap-x snap-mandatory flex-1">
              {columns.filter(Boolean).map((column, idx) => (
                <button
                  key={column.id}
                  onClick={() => setActiveMobileColumn(idx)}
                  className={`flex-shrink-0 px-3 py-1.5 rounded-full text-sm font-medium transition-colors snap-center ${
                    activeMobileColumn === idx
                      ? 'bg-blue-500 text-white'
                      : 'bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300'
                  }`}
                >
                  {column.name}
                </button>
              ))}
            </div>
            <button
              onClick={() => setMobileViewMode(mobileViewMode === 'tabs' ? 'scroll' : 'tabs')}
              className="flex-shrink-0 p-2 rounded-lg bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300"
              title={mobileViewMode === 'tabs' ? t('mobile.switchToSlideView') : t('mobile.switchToListView')}
            >
              {mobileViewMode === 'tabs' ? (
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="7" height="7"/>
                  <rect x="14" y="3" width="7" height="7"/>
                  <rect x="14" y="14" width="7" height="7"/>
                  <rect x="3" y="14" width="7" height="7"/>
                </svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                  <line x1="3" y1="9" x2="21" y2="9"/>
                  <line x1="3" y1="15" x2="21" y2="15"/>
                </svg>
              )}
            </button>
          </div>
          {mobileViewMode === 'tabs' ? (
            <div id="mobile-column-container" className="flex-1 overflow-y-auto p-2">
              {getFilteredColumns().filter(Boolean)[activeMobileColumn] && (
                <Column
                  column={getFilteredColumns().filter(Boolean)[activeMobileColumn]}
                  currentBoardId={currentBoard?.id}
                  boards={boards}
                  isMobileView={true}
                  onAddTask={addTask}
                  onTaskClick={setSelectedTask}
                  onTaskCommentsClick={setSelectedTask}
                  onTaskArchive={archiveTask}
                  onTaskDelete={deleteTask}
                  onOpenAddTask={(columnId) => {
                    setDefaultColumnIdForNewTask(columnId);
                    setShowAddTaskModal(true);
                  }}
                  onColumnRename={handleColumnRename}
                  searchQuery={filters.searchQuery}
                  selectedTasks={selectedTasks}
                  onSelectTask={handleTaskSelect}
                  onLoadMore={handleLoadMoreTasks}
                  hasMore={columnPagination[getFilteredColumns().filter(Boolean)[activeMobileColumn]?.id]?.hasMore}
                  isLoadingMore={columnPagination[getFilteredColumns().filter(Boolean)[activeMobileColumn]?.id]?.isLoadingMore}
                />
              )}
            </div>
          ) : (
            <div id="mobile-scroll-container" className="relative flex-1 min-h-0 overflow-x-auto overflow-y-hidden pb-4">
              <div className="flex gap-3 p-2 h-full min-h-0">
                {getFilteredColumns().filter(Boolean).map((column) => (
                  <Column
                    key={column.id}
                    column={column}
                    currentBoardId={currentBoard?.id}
                    boards={boards}
                    isMobileView={true}
                    onAddTask={addTask}
                    onTaskClick={setSelectedTask}
                    onTaskCommentsClick={setSelectedTask}
                    onTaskArchive={archiveTask}
                    onTaskDelete={deleteTask}
                    onOpenAddTask={(columnId) => {
                      setDefaultColumnIdForNewTask(columnId);
                      setShowAddTaskModal(true);
                    }}
                    onColumnRename={handleColumnRename}
                    searchQuery={filters.searchQuery}
                    selectedTasks={selectedTasks}
                    onSelectTask={handleTaskSelect}
                    onLoadMore={handleLoadMoreTasks}
                    hasMore={columnPagination[column.id]?.hasMore}
                    isLoadingMore={columnPagination[column.id]?.isLoadingMore}
                  />
                ))}
              </div>
              <div className="absolute left-0 top-0 bottom-0 w-8 bg-gradient-to-r from-zinc-100/80 to-transparent dark:from-zinc-900/80 pointer-events-none" />
              <div className="absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-zinc-100/80 to-transparent dark:from-zinc-900/80 pointer-events-none" />
              <div className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-zinc-800/70 text-white text-xs px-2 py-1 rounded-full dark:bg-zinc-200/70 dark:text-zinc-800">
                {t('mobile.columnsCount', { count: columns.length })}
              </div>
            </div>
          )}
        </div>
      ) : (
          <div className="relative h-[calc(100vh-120px)] overflow-hidden p-6">
          <div className="flex gap-4 overflow-x-auto pb-4 flex-nowrap h-full" id="columns-scroll-container">
            {getFilteredColumns().filter(Boolean).map((column) => (
              <Column
                key={column.id}
                column={column}
                currentBoardId={currentBoard?.id}
                boards={boards}
                onAddTask={addTask}
                onTaskClick={setSelectedTask}
                onTaskCommentsClick={setSelectedTask}
                onTaskArchive={archiveTask}
                onTaskDelete={deleteTask}
                onOpenAddTask={(columnId) => {
                  setDefaultColumnIdForNewTask(columnId);
                  setShowAddTaskModal(true);
                }}
                onColumnRename={handleColumnRename}
                searchQuery={filters.searchQuery}
                selectedTasks={selectedTasks}
                onSelectTask={handleTaskSelect}
                onLoadMore={handleLoadMoreTasks}
                hasMore={columnPagination[column.id]?.hasMore}
                isLoadingMore={columnPagination[column.id]?.isLoadingMore}
              />
            ))}
          </div>
          <div className="absolute left-0 top-0 bottom-4 w-8 bg-gradient-to-r from-zinc-100 dark:from-zinc-900 to-transparent pointer-events-none z-10" id="scroll-fade-left" />
          <div className="absolute right-4 top-0 bottom-4 w-8 bg-gradient-to-l from-zinc-100 dark:from-zinc-900 to-transparent pointer-events-none z-10" id="scroll-fade-right" />
          <div className="absolute bottom-0 left-1/2 -translate-x-1/2 bg-zinc-800/70 text-white text-xs px-2 py-1 rounded-full dark:bg-zinc-200/70 dark:text-zinc-800 opacity-0 transition-opacity" id="scroll-hint">
            {t('board.scrollHint')}
          </div>
        </div>
      )}



        <AddTaskModal
          isOpen={showAddTaskModal}
          defaultColumnId={defaultColumnIdForNewTask}
          currentBoardId={currentBoard?.id}
          boards={boards}
          onClose={() => {
            setShowAddTaskModal(false);
            setDefaultColumnIdForNewTask(undefined);
          }}
          onSubmit={(title, description, published, columnId, boardId, priority) => {
            addTask(columnId, title, description, published, boardId, priority);
            setShowAddTaskModal(false);
            setDefaultColumnIdForNewTask(undefined);
          }}
        />

        <DragOverlay>
          {activeTask && <TaskCard task={activeTask} onClick={() => {}} />}
        </DragOverlay>
      </DndContext>
    </div>

      {selectedTask && (
        <TaskModal
          task={selectedTask}
          columnName={columns.find((col) => col.tasks.some((t) => t.id === selectedTask.id))?.name}
          columns={columns.map((c) => ({ id: c.id, name: c.name }))}
          boardId={boardIdFromUrl}
          boards={boards}
          canEdit={true}
          startEditing={editTaskId === selectedTask.id}
          onClose={() => { setSelectedTask(null); setEditTaskId(null); }}
          onUpdate={updateTask}
          onDelete={deleteTask}
          onArchive={archiveTask}
          onAddComment={addComment}
          onEditingStarted={() => setEditTaskId(null)}
        />
      )}

      {selectedTasks.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-xl bg-zinc-800 dark:bg-zinc-700 px-4 py-3 shadow-2xl ring-1 ring-zinc-200/20 dark:ring-zinc-600/50">
          <span className="text-sm text-zinc-200 dark:text-zinc-200 font-medium">
            {t('task.selectedCount', { count: selectedTasks.size })}
          </span>
          <div className="h-4 w-px bg-zinc-600" />
          <select
            onChange={(e) => {
              if (e.target.value) batchMove(e.target.value);
              e.target.value = '';
            }}
            className="rounded-md bg-zinc-700 border border-zinc-600 px-2 py-1 text-sm text-zinc-200"
          >
            <option value="">{t('task.moveToColumn')}</option>
            {columns.map(col => (
              <option key={col.id} value={col.id}>{col.name}</option>
            ))}
          </select>
          <select
            onChange={(e) => {
              if (e.target.value) batchUpdatePriority(e.target.value);
              e.target.value = '';
            }}
            className="rounded-md bg-zinc-700 border border-zinc-600 px-2 py-1 text-sm text-zinc-200"
          >
            <option value="">{t('task.setPriority')}</option>
            <option value="high">{t('task.priority.high')}</option>
            <option value="medium">{t('task.priority.medium')}</option>
            <option value="low">{t('task.priority.low')}</option>
          </select>
          <select
            onChange={(e) => {
              batchUpdateAssignee(e.target.value);
              e.target.value = '';
            }}
            className="rounded-md bg-zinc-700 border border-zinc-600 px-2 py-1 text-sm text-zinc-200"
          >
            <option value="">{t('task.setAssignee')}</option>
            <option value="">{t('task.clearAssignee')}</option>
            {uniqueAssignees.map(a => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
          <div className="h-4 w-px bg-zinc-600" />
          <button
            onClick={batchArchive}
            className="rounded-md bg-orange-600 hover:bg-orange-500 px-3 py-1 text-sm text-white font-medium transition-colors"
          >
            {t('task.archive')}
          </button>
          <button
            onClick={batchDelete}
            className="rounded-md bg-red-600 hover:bg-red-500 px-3 py-1 text-sm text-white font-medium transition-colors"
          >
            {t('task.delete')}
          </button>
          <button
            onClick={clearSelection}
            className="rounded-md bg-zinc-600 hover:bg-zinc-500 px-3 py-1 text-sm text-white font-medium transition-colors"
          >
            {t('task.clearSelection')}
          </button>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 rounded-lg bg-zinc-800 px-4 py-2 text-sm text-white">
          {toast}
        </div>
      )}
      {confirmDialog.isOpen && (
        <ConfirmDialog
          isOpen={confirmDialog.isOpen}
          title={confirmDialog.title}
          message={confirmDialog.message}
          variant={confirmDialog.variant}
          onConfirm={confirmDialog.onConfirm}
          onCancel={() => setConfirmDialog(prev => ({ ...prev, isOpen: false }))}
        />
      )}
      <ErrorToastContainer />
    </div>
  );
}
