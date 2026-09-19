import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Link, useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { arrayMove } from '@dnd-kit/sortable';
import { ColumnBoard } from '../components/ColumnBoard';
import { HeaderRightMenu } from '../components/HeaderRightMenu';
import { BatchOperationBar } from '../components/BatchOperationBar';
import { ShareBoardModal } from '../components/ShareBoardModal';
import { WsWarning } from '../components/WsWarning';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ColumnMenuConfirmDialog, type ColumnBulkAction } from '../components/ColumnMenuConfirmDialog';
import { BoardSelector } from '../components/BoardSelector';
import { ErrorToastContainer, showErrorToast } from '../components/ErrorToast';
import { boardsApi, tasksApi } from '../services/api';
import { BoardSkeleton } from '../components/Skeleton';
import { useBoardState } from '../hooks/useBoardState';
import { useBoardTaskRuns } from '../hooks/useBoardTaskRuns';
import { useCustomFields } from '../hooks/useCustomFields';
import { useCardDensity } from '../hooks/useCardDensity';
import { useSetupGuard } from '../hooks/useSetupGuard';
import { KeyboardNavigation } from '../components/KeyboardNavigation';
import { BoardToolbar } from '../components/BoardToolbar';
import { BoardActionsMenu } from '../components/BoardActionsMenu';
import { useRunStore } from '../store/runStore';
import { encodeFiltersToParams } from '../hooks/useFilters';
import type { Task, Column as ColumnType } from '../types/kanban';

const LAST_BOARD_KEY = 'lastSelectedBoardId';
const DARK_MODE_KEY = 'darkMode';

interface ConfirmDialogState {
  isOpen: boolean;
  title: string;
  message: string;
  onConfirm: () => void;
  variant?: 'danger' | 'warning' | 'default';
}

// s-1212 — confirmation dialog state for the column-header ⋯
// menu. `column` carries the tasks the user is about to touch so
// the dialog can list them, and `action` drives both the dialog
// title and the eventual API call.
interface ColumnBulkConfirmState {
  column: ColumnType | null;
  action: ColumnBulkAction | null;
}

export function BoardPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const params = useParams();
  useSetupGuard();
  const [searchParams, setSearchParams] = useSearchParams();
  const boardIdFromUrl = params.boardId as string;
  const taskIdFromUrl = searchParams.get('taskId');

  const [darkMode, setDarkMode] = useState(() => {
    const saved = localStorage.getItem(DARK_MODE_KEY);
    return saved === 'true' || window.matchMedia('(prefers-color-scheme: dark)').matches;
  });
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);
  const [showFilterPanel, setShowFilterPanel] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [showBoardDropdown, setShowBoardDropdown] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showPresetDropdown, setShowPresetDropdown] = useState(false);
  const [focusedColumnIndex, setFocusedColumnIndex] = useState(0);
  const [focusedTaskIndex, setFocusedTaskIndex] = useState(0);
  const [editTaskId, setEditTaskId] = useState<string | null>(null);
  const [showAddTaskModal, setShowAddTaskModal] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  const [defaultColumnIdForNewTask, setDefaultColumnIdForNewTask] = useState<string | undefined>();
  const [toast, setToast] = useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState>({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: () => {},
  });
  const [columnBulkConfirm, setColumnBulkConfirm] = useState<ColumnBulkConfirmState>({
    column: null,
    action: null,
  });

  const userMenuRef = useRef<HTMLDivElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const boardDropdownRef = useRef<HTMLDivElement>(null);
  const reconnectAttemptRef = useRef(0);

  // s-1244 (PM review s-1243 P0-4): the legacy `/board/public` slug was
  // never a real board id — it was the historical landing-page route
  // before public-share tokens moved to `/public/b/:token`. Treating it
  // as a board id causes the page to silently fall back to the user's
  // first board. Redirect to the real public-share entry instead.
  useEffect(() => {
    if (boardIdFromUrl === 'public') {
      navigate('/public/b/public', { replace: true });
    }
  }, [boardIdFromUrl, navigate]);

  const {
    boards,
    currentBoard,
    hasAccess,
    columns,
    activeTask,
    selectedTask,
    selectedTasks,
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
    getFilteredColumns,
    fetchBoards,
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
    setSelectedTask,
    setActiveTask,
    setFilters,
    setSearchQuery,
    saveCurrentAsPreset,
    applyPreset,
    deletePreset,
    clearFilters,
    clearSingleFilter,
    hasActiveFilters,
    activeFilterCount,
    lastLocalUpdateRef,
    setColumns,
    canCreateTaskInColumn,
    canCreateTaskAnywhere,
  } = useBoardState({ boardIdFromUrl, taskIdFromUrl });

  const showToastMessage = useCallback((message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 2000);
  }, []);

  // s-1193: subscribe to the shared run store so each TaskCard can
  // re-render in isolation when *its* run row flips status, and pass
  // the map down to ColumnBoard → Column → TaskCard.
  const runs = useRunStore((s) => s.runs);

  // s-1197: per-board custom field definitions — stored in localStorage
  // by the same hook the ColumnsPage settings modal writes to. The hook
  // returns an empty array when no board is loaded so the chip renderer
  // stays a no-op during transitions.
  const { customFields } = useCustomFields(currentBoard?.id);

  // s-1213: per-user card density preference (PM-s1188 §3.3). Stored in
  // localStorage so it survives reloads. We deliberately do NOT route
  // this through any server endpoint — switching density must not
  // refetch tasks (DoD for the toggle).
  const { density, setDensity } = useCardDensity();

  // Compute the list of currently-visible task IDs once per columns
  // change. Hooked into a memo so the polling effect only re-binds
  // when the task set really changes (u-p-1193: avoid restarting the
  // timer on unrelated state changes).
  const visibleTaskIds = useMemo(() => {
    const ids: string[] = [];
    for (const col of columns) {
      for (const task of col.tasks ?? []) {
        if (task.id) ids.push(task.id);
      }
    }
    return ids;
  }, [columns]);

  const handleRunComplete = useCallback(
    (event: { taskId: string; run: { status: string; runnerId: string } }) => {
      // s-1193: surface an in-app toast when an Agent run completes
      // (PM_REVIEW_2026-09-17 §5.1 finding #4). The toast is "info"
      // for success / "warning" for failures so the colour matches
      // the severity without becoming noise during long happy-path
      // operations.
      const title = t('runComplete.toastTitle');
      const body = t('runComplete.toastBody', {
        runner: event.run.runnerId,
        status: event.run.status,
      });
      const tone =
        event.run.status === 'failed'
          ? 'warning'
          : event.run.status === 'completed'
          ? 'info'
          : 'info';
      showErrorToast(`${title} — ${body}`, tone);
    },
    [t]
  );

  useBoardTaskRuns(visibleTaskIds, { intervalMs: 5000, onRunComplete: handleRunComplete });

  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    localStorage.setItem(DARK_MODE_KEY, String(darkMode));
  }, [darkMode]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (showUserMenu && userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setShowUserMenu(false);
      }
      if (showBoardDropdown && boardDropdownRef.current && !boardDropdownRef.current.contains(e.target as Node)) {
        setShowBoardDropdown(false);
      }
      if (showMoreMenu && moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setShowMoreMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showUserMenu, showBoardDropdown, showMoreMenu, moreMenuRef]);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // s-1201: mirror the filter state into the URL so a shared or
  // bookmarked board link preserves the user's view. We preserve the
  // existing `taskId` param (used by the deep-link task modal) and
  // use `replace: true` so the back button still navigates between
  // pages rather than walking through every chip toggle.
  useEffect(() => {
    const filterParams = encodeFiltersToParams(filters);
    const next = new URLSearchParams(searchParams);
    // Wipe any previously-written filter keys so clearing a
    // dimension actually disappears from the URL instead of leaving
    // stale values behind.
    for (const key of [
      'f_pri', 'f_asg', 'f_q', 'f_dr', 'f_tag', 'f_cf', 'f_cfv',
      'f_rs', 'f_hc', 'f_hs',
    ]) {
      next.delete(key);
    }
    filterParams.forEach((value, key) => next.set(key, value));
    // Skip the write if nothing changed to avoid a no-op history
    // entry when the page first hydrates from the URL itself.
    if (next.toString() === searchParams.toString()) return;
    setSearchParams(next, { replace: true });
    // We intentionally only re-run when the filter shape changes;
    // re-running on every searchParams mutation would cause an
    // infinite write/read loop with the hydration path above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  const updateTaskPosition = useCallback(async (
    activeId: string,
    overId: string,
    activeColumn: ColumnType,
    overColumn: ColumnType,
    activeTaskLocal: Task | null
  ) => {
    const previousColumns = columns;

    let nextActiveTasks: Task[] | null = null;
    let nextOverTasks: Task[] | null = null;
    let activeChanged = false;

    if (activeColumn.id === overColumn.id) {
      const tasks = activeColumn.tasks ?? [];
      const oldIndex = tasks.findIndex((t) => t.id === activeId);
      const newIndex = tasks.findIndex((t) => t.id === overId);

      if (oldIndex !== newIndex && oldIndex >= 0 && newIndex >= 0) {
        nextActiveTasks = arrayMove(tasks, oldIndex, newIndex).map((t, i) => ({
          ...t,
          position: i,
        }));
        activeChanged = true;
      }
    } else {
      const overTasks = [...(overColumn.tasks ?? [])];
      const newIndex = overTasks.findIndex((t) => t.id === overId);

      if (!activeTaskLocal) {
        return;
      }

      if (newIndex >= 0) {
        overTasks.splice(newIndex, 0, { ...activeTaskLocal, columnId: overColumn.id });
      } else {
        overTasks.push({ ...activeTaskLocal, columnId: overColumn.id });
      }

      nextOverTasks = overTasks.map((t, i) => ({ ...t, position: i }));
      nextActiveTasks = (activeColumn.tasks ?? [])
        .filter(t => t.id !== activeId)
        .map((t, i) => ({ ...t, position: i }));
      activeChanged = true;
    }

    if (!activeChanged) {
      return;
    }

    lastLocalUpdateRef.current = Date.now();
    setColumns(prev => prev.map(col => {
      if (col.id === activeColumn.id && nextActiveTasks) {
        return { ...col, tasks: nextActiveTasks };
      }
      if (col.id === overColumn.id && nextOverTasks) {
        return { ...col, tasks: nextOverTasks };
      }
      return col;
    }));

    const reorderItems: { id: string; columnId: string; position: number }[] = [];
    if (nextActiveTasks) {
      nextActiveTasks.forEach((task, idx) => {
        reorderItems.push({ id: task.id, columnId: activeColumn.id, position: idx });
      });
    }
    if (nextOverTasks && overColumn.id !== activeColumn.id) {
      // s-1218: include every task in the destination column. The
      // earlier `task.id !== activeId` filter dropped the dragged
      // task itself, which meant the backend never received the new
      // column_id for it. The optimistic local UI update placed the
      // card in the destination column, but the next WebSocket
      // refresh (or a manual reload) would re-read the DB row in its
      // original column, snapping the card back. Sending every
      // `nextOverTasks` row — including the active one with its
      // already-updated columnId — closes that round-trip gap so the
      // move persists.
      nextOverTasks.forEach((task, idx) => {
        reorderItems.push({ id: task.id, columnId: overColumn.id, position: idx });
      });
    }

    try {
      await tasksApi.reorder(reorderItems);
    } catch {
      setColumns(previousColumns);
      showToastMessage(t('task.moveFailed') || 'Failed to move task');
    }
  }, [columns, lastLocalUpdateRef, setColumns, showToastMessage, t]);

  const connectWebSocket = useCallback(() => {
    reconnectAttemptRef.current = 0;
  }, []);

  const handleMoveToColumn = useCallback(async (taskId: string, toColumnId: string) => {
    const previousColumns = columns;

    const sourceColumn = columns.find(col => col.tasks?.some(t => t.id === taskId));
    const destColumn = columns.find(col => col.id === toColumnId);

    if (!sourceColumn || !destColumn || sourceColumn.id === destColumn.id) {
      return;
    }

    const taskToMove = sourceColumn.tasks?.find(t => t.id === taskId);
    if (!taskToMove) return;

    const destTasks = [...(destColumn.tasks ?? [])];
    destTasks.push({ ...taskToMove, columnId: destColumn.id });

    const sourceTasks = (sourceColumn.tasks ?? []).filter(t => t.id !== taskId).map((t, i) => ({ ...t, position: i }));
    const updatedDestTasks = destTasks.map((t, i) => ({ ...t, position: i }));

    lastLocalUpdateRef.current = Date.now();
    setColumns(prev => prev.map(col => {
      if (col.id === sourceColumn.id) {
        return { ...col, tasks: sourceTasks };
      }
      if (col.id === destColumn.id) {
        return { ...col, tasks: updatedDestTasks };
      }
      return col;
    }));

    const reorderItems: { id: string; columnId: string; position: number }[] = [];
    sourceTasks.forEach((task, idx) => {
      reorderItems.push({ id: task.id, columnId: sourceColumn.id, position: idx });
    });
    updatedDestTasks.forEach((task, idx) => {
      reorderItems.push({ id: task.id, columnId: destColumn.id, position: idx });
    });

    try {
      await tasksApi.reorder(reorderItems);
    } catch {
      setColumns(previousColumns);
      showToastMessage(t('task.moveFailed') || 'Failed to move task');
    }
  }, [columns, lastLocalUpdateRef, setColumns, showToastMessage, t]);

  const handleExport = useCallback(async (format: 'json' | 'csv') => {
    if (!currentBoard) return;
    try {
      const response = await boardsApi.export(currentBoard.id, format);
      if (!response.ok) throw new Error('Export failed');
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
  }, [currentBoard, t, showToastMessage]);

  const handleReset = useCallback(() => {
    if (!currentBoard) return;
    setConfirmDialog({
      isOpen: true,
      title: t('confirm.resetBoardTitle'),
      message: t('confirm.resetBoard', { name: currentBoard.name }),
      variant: 'danger',
      onConfirm: async () => {
        try {
          await boardsApi.reset(currentBoard.id);
          showToastMessage(t('toast.boardReset'));
          window.location.reload();
        } catch (error) {
          console.error('Reset failed:', error);
          showToastMessage(t('toast.resetFailed'));
        }
        setConfirmDialog((prev) => ({ ...prev, isOpen: false }));
      },
    });
  }, [currentBoard, t, showToastMessage]);

  const handleDeleteTask = useCallback((taskId: string) => {
    setConfirmDialog({
      isOpen: true,
      title: t('taskModal.confirmDeleteTitle'),
      message: t('task.confirmDelete'),
      variant: 'danger',
      onConfirm: () => {
        deleteTask(taskId);
        setConfirmDialog((prev) => ({ ...prev, isOpen: false }));
      },
    });
  }, [t, deleteTask]);

  // s-1212 — column-header ⋯ menu handlers. Each handler opens the
  // shared confirmation dialog with the column snapshot the user
  // clicked on; the actual API call lives in `confirmColumnBulkAction`
  // so the same dialog state can drive archive / complete / export.
  const requestColumnArchiveAll = useCallback((column: ColumnType) => {
    if (column.tasks.length === 0) return;
    setColumnBulkConfirm({ column, action: 'archive' });
  }, []);

  const requestColumnMarkAllCompleted = useCallback((column: ColumnType) => {
    if (column.tasks.length === 0) return;
    setColumnBulkConfirm({ column, action: 'complete' });
  }, []);

  const requestColumnExportCsv = useCallback((column: ColumnType) => {
    if (column.tasks.length === 0) return;
    setColumnBulkConfirm({ column, action: 'exportCsv' });
  }, []);

  const cancelColumnBulkAction = useCallback(() => {
    setColumnBulkConfirm({ column: null, action: null });
  }, []);

  const confirmColumnBulkAction = useCallback(async () => {
    const state = columnBulkConfirm;
    const column = state.column;
    const action = state.action;
    setColumnBulkConfirm({ column: null, action: null });
    if (!column || !action) return;

    if (action === 'exportCsv') {
      // Export reuses the board-export endpoint by reconstructing
      // a CSV locally from the tasks we already have on the
      // client — round-tripping the whole board through the
      // server would be wasteful for a single column and would
      // require a brand-new server endpoint just for this case.
      try {
        const csv = buildColumnCsv(column);
        const blob = new Blob(["\xEF\xBB\xBF" + csv], { type: 'text/csv;charset=utf-8' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        a.download = `${column.name}_${timestamp}.csv`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        showToastMessage(t('column.bulkResult.exported', { count: column.tasks.length }));
      } catch (error) {
        console.error('Column CSV export failed:', error);
        showToastMessage(t('column.bulkResult.exportFailed'));
      }
      return;
    }

    try {
      const result = await tasksApi.bulkColumnAction(
        column.id,
        action,
        column.tasks.map((task) => task.id),
      );

      // Optimistic local update: drop the affected tasks from
      // the source column. For "complete" the WebSocket fan-out
      // will re-add them to the destination column; the local
      // preview matches what the user saw in the dialog.
      setColumns((cols) =>
        cols.map((col) => {
          if (col.id !== column.id) return col;
          if (action === 'archive') {
            return { ...col, tasks: col.tasks.filter((task) => !result.affected.includes(task.id)) };
          }
          if (action === 'complete') {
            return { ...col, tasks: col.tasks.filter((task) => !result.affected.includes(task.id)) };
          }
          return col;
        }),
      );

      const toastKey =
        action === 'archive'
          ? result.count === 1
            ? 'column.bulkResult.archivedOne'
            : 'column.bulkResult.archivedMany'
          : result.count === 1
            ? 'column.bulkResult.completedOne'
            : 'column.bulkResult.completedMany';
      showToastMessage(t(toastKey, { count: result.count }));
      if (result.skipped > 0) {
        showToastMessage(t('column.bulkResult.skipped', { count: result.skipped }));
      }
    } catch (error) {
      console.error('Bulk column action failed:', error);
      showErrorToast(t('export.failed'), 'error');
    }
  }, [columnBulkConfirm, setColumns, showToastMessage, t]);

  if (loading || boardSwitching) return <BoardSkeleton />;

  if (loadError) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4">
        <div className="text-red-500">{t('app.error.loadFailed')}</div>
        <div className="text-sm text-zinc-400 dark:text-zinc-500">{loadError}</div>
        <button
          onClick={fetchBoards}
          className="rounded-md bg-blue-500 px-4 py-2 text-sm text-white hover:bg-blue-600"
        >
          {t('app.error.retry')}
        </button>
        <button
          onClick={() => {
            localStorage.removeItem('token');
            navigate('/login');
          }}
          className="rounded-md bg-red-500 px-4 py-2 text-sm text-white hover:bg-red-600"
        >
          {t('auth.logout')}
        </button>
      </div>
    );
  }

  if (currentBoard && hasAccess === false) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-zinc-100 px-4 dark:bg-zinc-900">
        <div className="flex max-w-md flex-col items-center gap-3 rounded-lg border border-zinc-200 bg-white p-8 text-center shadow-sm dark:border-zinc-700 dark:bg-zinc-800">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="40"
            height="40"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-zinc-400 dark:text-zinc-500"
            aria-hidden="true"
          >
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          <h2 className="text-lg font-semibold text-zinc-800 dark:text-zinc-100">
            {t('board.noAccess')}
          </h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {t('board.noAccessHint')}
          </p>
          <button
            type="button"
            onClick={() => navigate('/boards')}
            className="mt-2 rounded-md bg-blue-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-400 dark:bg-blue-600 dark:hover:bg-blue-500"
          >
            {t('board.goBackToList')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-zinc-100 dark:bg-zinc-900">
      <a
        href="#board-main"
        className="skip-link"
      >
        {t('a11y.skipToContent')}
      </a>
      <KeyboardNavigation
        selectedTask={selectedTask}
        selectedTasks={selectedTasks}
        showAddTaskModal={showAddTaskModal}
        columns={columns}
        focusedColumnIndex={focusedColumnIndex}
        focusedTaskIndex={focusedTaskIndex}
        onSetFocusedColumnIndex={setFocusedColumnIndex}
        onSetFocusedTaskIndex={setFocusedTaskIndex}
        onSetShowAddTaskModal={setShowAddTaskModal}
        onSetDefaultColumnIdForNewTask={setDefaultColumnIdForNewTask}
        onSetEditTaskId={setEditTaskId}
        onSetSelectedTask={setSelectedTask}
        onHandleTaskSelect={handleTaskSelect}
        onClearSelection={clearSelection}
        onArchiveTask={archiveTask}
        onDeleteTask={handleDeleteTask}
      />
      <WsWarning
        wsStatus={wsStatus}
        reconnectCount={reconnectCount}
        onConnectWebSocket={connectWebSocket}
      />

      <header
        className="p-3 pr-24 sm:p-6 sm:pr-32 sm:pb-0 mb-3 sm:mb-6 flex items-center justify-between gap-2 sm:gap-4 flex-wrap"
        role="banner"
      >
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          <BoardSelector
            ref={boardDropdownRef}
            boards={boards}
            currentBoard={currentBoard}
            boardIdFromUrl={boardIdFromUrl}
            showDropdown={showBoardDropdown}
            onToggleDropdown={() => setShowBoardDropdown(!showBoardDropdown)}
            onSelectBoard={(id) => {
              localStorage.setItem(LAST_BOARD_KEY, id);
              setShowBoardDropdown(false);
              if (id !== boardIdFromUrl) navigate(`/board/${id}`);
            }}
          />

          <Link
            to={`/columns?boardId=${boardIdFromUrl}`}
            className="hidden sm:flex items-center justify-center min-h-[32px] min-w-[32px] rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 p-1.5 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700"
            title={t('nav.columnManagement')}
            aria-label={t('nav.columnManagement')}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="3" width="5" height="18" rx="1" />
              <rect x="10" y="3" width="5" height="18" rx="1" />
              <rect x="17" y="3" width="5" height="18" rx="1" />
            </svg>
          </Link>
        </div>

        <BoardToolbar
          searchQuery={searchQuery}
          filters={filters}
          filterPresets={filterPresets}
          uniqueAssignees={uniqueAssignees}
          uniqueTags={uniqueTags}
          uniqueCustomFieldValues={uniqueCustomFieldValues}
          customFields={customFields}
          hasActiveFilters={hasActiveFilters}
          activeFilterCount={activeFilterCount}
          showFilterPanel={showFilterPanel}
          showPresetDropdown={showPresetDropdown}
          onSetSearchQuery={setSearchQuery}
          onSetFilters={setFilters}
          onClearFilters={() => {
            clearFilters();
            setShowFilterPanel(false);
          }}
          onClearSingleFilter={clearSingleFilter}
          onSaveCurrentAsPreset={saveCurrentAsPreset}
          onApplyPreset={applyPreset}
          onDeletePreset={deletePreset}
          onSetShowPresetDropdown={setShowPresetDropdown}
          onToggleFilterPanel={() => setShowFilterPanel(!showFilterPanel)}
          onCloseFilterPanel={() => setShowFilterPanel(false)}
          onAddTask={() => {
            setDefaultColumnIdForNewTask(undefined);
            setShowAddTaskModal(true);
          }}
          canCreateTask={canCreateTaskAnywhere}
          isMobile={isMobile}
          density={density}
          onSetDensity={setDensity}
        />

<div className="flex items-center gap-2 sm:gap-3">
          <Link
            to="/runs"
            className="hidden sm:flex items-center justify-center min-h-[32px] min-w-[32px] rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 p-1.5 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700"
            title={t('nav.runs')}
            aria-label={t('nav.runs')}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
          </Link>
          <Link
            to="/agent-activity"
            className="hidden sm:flex items-center justify-center min-h-[32px] min-w-[32px] rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 p-1.5 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700"
            title={t('nav.agentActivity')}
            aria-label={t('nav.agentActivity')}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
            </svg>
          </Link>
          {(currentUser?.role === 'ADMIN' || currentBoard?.isOwner) && (
            <button
              type="button"
              onClick={() => setShowShareModal(true)}
              className="hidden sm:flex items-center gap-1 rounded-md bg-blue-600 hover:bg-blue-700 px-2.5 py-1.5 text-sm text-white"
              title={t('share.menu')}
              aria-label={t('share.menu')}
              data-testid="board-share-button"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="18" cy="5" r="3" />
                <circle cx="6" cy="12" r="3" />
                <circle cx="18" cy="19" r="3" />
                <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
                <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
              </svg>
            </button>
          )}
          <BoardActionsMenu
            showMoreMenu={showMoreMenu}
            showExportMenu={showExportMenu}
            currentUser={currentUser}
            onSetShowMoreMenu={setShowMoreMenu}
            onSetShowExportMenu={setShowExportMenu}
            moreMenuRef={moreMenuRef}
            exportMenuRef={exportMenuRef}
            onExport={handleExport}
            onReset={handleReset}
          />
          <HeaderRightMenu
            showUserMenu={showUserMenu}
            currentUser={currentUser}
            wsStatus={wsStatus}
            reconnectAttemptRef={reconnectAttemptRef}
            onSetShowUserMenu={setShowUserMenu}
            onConnectWebSocket={connectWebSocket}
            userMenuRef={userMenuRef}
            navigate={navigate}
            darkMode={darkMode}
            onSetDarkMode={setDarkMode}
            i18n={i18n}
          />
        </div>
      </header>

      <main
        id="board-main"
        className="h-[calc(100vh-120px)] sm:h-[calc(100vh-160px)]"
        aria-label={currentBoard?.name ?? t('board.title')}
      >
      <ColumnBoard
        columns={columns}
        currentBoard={currentBoard}
        boards={boards}
        boardIdFromUrl={boardIdFromUrl}
        activeTask={activeTask}
        selectedTask={selectedTask}
        selectedTasks={selectedTasks}
        columnPagination={columnPagination}
        filters={filters}
        isMobile={isMobile}
        showAddTaskModal={showAddTaskModal}
        defaultColumnIdForNewTask={defaultColumnIdForNewTask}
        editTaskId={editTaskId}
        onAddTask={addTask}
        onUpdateTask={updateTask}
        onDeleteTask={deleteTask}
        onArchiveTask={archiveTask}
        onAddComment={addComment}
        onTaskSelect={handleTaskSelect}
        onSelectAllTasks={selectAllInColumn}
        onLoadMoreTasks={() => {}}
        onColumnRename={handleColumnRename}
        onColumnMarkAllCompleted={requestColumnMarkAllCompleted}
        onColumnArchiveAll={requestColumnArchiveAll}
        onColumnExportCsv={requestColumnExportCsv}
        onSetSelectedTask={setSelectedTask}
        onSetActiveTask={setActiveTask}
        onSetShowAddTaskModal={setShowAddTaskModal}
        onSetDefaultColumnIdForNewTask={setDefaultColumnIdForNewTask}
        onSetEditTaskId={setEditTaskId}
        onMoveToColumn={handleMoveToColumn}
        getFilteredColumns={getFilteredColumns}
        updateTaskPosition={updateTaskPosition}
        canCreateTaskInColumn={canCreateTaskInColumn}
        runs={runs}
        customFields={customFields}
        density={density}
      />
      </main>

      {currentBoard && (
        <ShareBoardModal
          open={showShareModal}
          onClose={() => setShowShareModal(false)}
          boardId={currentBoard.id}
        />
      )}

      {selectedTasks.size > 0 && (
        <BatchOperationBar
          selectedTasks={selectedTasks}
          columns={columns}
          uniqueAssignees={uniqueAssignees}
          onBatchMove={batchMove}
          onBatchUpdatePriority={batchUpdatePriority}
          onBatchUpdateAssignee={batchUpdateAssignee}
          onBatchArchive={batchArchive}
          onBatchDelete={batchDelete}
          onClearSelection={clearSelection}
        />
      )}

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] rounded-lg bg-zinc-800 px-4 py-2 text-sm text-white shadow-lg">
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
          onCancel={() => setConfirmDialog((prev) => ({ ...prev, isOpen: false }))}
        />
      )}

      <ColumnMenuConfirmDialog
        isOpen={columnBulkConfirm.column !== null && columnBulkConfirm.action !== null}
        action={columnBulkConfirm.action}
        columnName={columnBulkConfirm.column?.name ?? ''}
        affectedTasks={(columnBulkConfirm.column?.tasks ?? []).map((task) => ({ id: task.id, title: task.title }))}
        onConfirm={confirmColumnBulkAction}
        onCancel={cancelColumnBulkAction}
      />

      <ErrorToastContainer />
    </div>
  );
}

// buildColumnCsv renders a single column's tasks as CSV bytes
// suitable for a file download. Mirrors the column shape produced
// by generateCSV on the server side (tasks_export.go) so an
// export downloaded from the column menu is interchangeable with
// a per-column slice of the board-level export.
//
// Kept local to BoardPage because only the bulk-menu confirm path
// needs it; a future column export endpoint can replace it
// without touching any other consumer.
function buildColumnCsv(column: ColumnType): string {
  const escape = (s: string) =>
    `"${s.replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
  const header = 'Title,Description,Priority,Assignee,Created At,Updated At';
  const rows = column.tasks.map((task) => {
    const createdAt = task.createdAt ? new Date(task.createdAt).toISOString() : '';
    const updatedAt = task.updatedAt ? new Date(task.updatedAt).toISOString() : '';
    return [
      escape(task.title ?? ''),
      escape(task.description ?? ''),
      escape(task.priority ?? ''),
      escape(task.assignee ?? ''),
      escape(createdAt),
      escape(updatedAt),
    ].join(',');
  });
  return [header, ...rows].join('\n');
}