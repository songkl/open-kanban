import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { authApi, tasksApi, commentsApi, activitiesApi, boardsApi, columnsApi, ApiError } from '../services/api';
import { LoadingScreen } from '../components/LoadingScreen';
import { UserAvatar } from '../components/UserAvatar';
import { TaskModal } from '../components/TaskModal';
import type { User, Task, Board, Column } from '../types/kanban';
import { useSetupGuard } from '../hooks/useSetupGuard';

interface Activity {
  id: string;
  userId: string;
  action: string;
  targetType: string;
  targetId?: string;
  targetTitle?: string;
  details?: string;
  ipAddress?: string;
  source?: string;
  createdAt: string;
}

interface UserMap {
  [userId: string]: string;
}

const actionIcons: Record<string, string> = {
  CREATE_TASK: '📝',
  COMPLETE_TASK: '✅',
  ADD_COMMENT: '💬',
  UPDATE_TASK: '✏️',
  DELETE_TASK: '🗑️',
  BOARD_CREATE: '📋',
  BOARD_UPDATE: '📋',
  BOARD_DELETE: '📋',
  COLUMN_CREATE: '📑',
  COLUMN_UPDATE: '📑',
  COLUMN_DELETE: '📑',
  USER_CREATE: '👤',
  USER_UPDATE: '👤',
  LOGIN: '🔑',
  LOGOUT: '🔒',
};

const clickableActions = ['CREATE_TASK', 'ADD_COMMENT'];

/**
 * s-1208 (PM-s1188 §3.8): scope-filter state for the activity log.
 * Board / column / task narrow the slice to a single resource tree
 * (board ⇒ its columns/tasks/comments, etc.); the action / time
 * filters compose on top. Each non-empty dimension counts as one
 * "applied filter" in the chip row.
 */
interface ScopeFilters {
  action: string;
  startTime: string;
  endTime: string;
  boardId: string;
  columnId: string;
  taskId: string;
}

const emptyScopeFilters: ScopeFilters = {
  action: '',
  startTime: '',
  endTime: '',
  boardId: '',
  columnId: '',
  taskId: '',
};

export function ActivityLogPage() {
  const { t } = useTranslation();
  useSetupGuard();
  const [loading, setLoading] = useState(true);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [users, setUsers] = useState<UserMap>({});
  const [filters, setFilters] = useState<ScopeFilters>(emptyScopeFilters);
  const [error, setError] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [showTaskModal, setShowTaskModal] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  // Scope-filter source data. We pull all boards once and lazily load
  // columns / tasks as the user narrows the scope, so a single
  // board + column + task cascade stays responsive on large accounts.
  const [boards, setBoards] = useState<Board[]>([]);
  const [scopeColumns, setScopeColumns] = useState<Column[]>([]);
  const [scopeTasks, setScopeTasks] = useState<{ id: string; title: string }[]>([]);
  const [scopeLoading, setScopeLoading] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const meData = await authApi.me();
      if (!meData.user) {
        setError('Not logged in');
        return;
      }
      setCurrentUser(meData.user);

      if (meData.user.role === 'ADMIN') {
        const usersData = await authApi.getUsers();
        const userMap: UserMap = {};
        (usersData || []).forEach((u: User) => {
          userMap[u.id] = u.nickname;
        });
        setUsers(userMap);
      }

      // Preload board list for the scope filter select. The list is
      // shared across users; admin/owner-only data is fetched
      // lazily when the filter actually narrows the slice.
      try {
        const allBoards = await boardsApi.getAll();
        setBoards(allBoards || []);
      } catch {
        setBoards([]);
      }
    } catch (err) {
      console.error('Failed to load data:', err);
      setError(t('app.error.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Refresh the column list whenever the board scope changes. If
  // the previously-picked column no longer belongs to the new
  // board, we drop it so the user isn't left with a stale selection.
  useEffect(() => {
    let cancelled = false;
    async function loadColumnsForBoard() {
      if (!filters.boardId) {
        setScopeColumns([]);
        return;
      }
      try {
        const cols = await columnsApi.getByBoard(filters.boardId);
        if (!cancelled) {
          setScopeColumns(cols || []);
          setFilters((prev) => {
            if (prev.columnId && !(cols || []).some((c) => c.id === prev.columnId)) {
              return { ...prev, columnId: '', taskId: '' };
            }
            if (prev.columnId === prev.columnId) {
              return { ...prev, taskId: '' };
            }
            return prev;
          });
        }
      } catch {
        if (!cancelled) setScopeColumns([]);
      }
    }
    loadColumnsForBoard();
    return () => {
      cancelled = true;
    };
  }, [filters.boardId]);

  // Refresh the task list when the column (or board) scope narrows.
  // Tasks are loaded from the tasks endpoint, which returns the
  // column's published cards with enough metadata to label the
  // dropdown.
  useEffect(() => {
    let cancelled = false;
    async function loadTasksForScope() {
      if (!filters.columnId && !filters.boardId) {
        setScopeTasks([]);
        return;
      }
      setScopeLoading(true);
      try {
        let collected: { id: string; title: string }[] = [];
        const targetColumnIds = filters.columnId
          ? [filters.columnId]
          : (scopeColumns || []).map((c) => c.id);
        for (const columnId of targetColumnIds) {
          const res = await tasksApi.getByColumn(columnId, 1, 200);
          const items = res?.data || [];
          collected = collected.concat(
            items.map((task) => ({ id: task.id, title: task.title || task.id })),
          );
        }
        if (!cancelled) {
          setScopeTasks(collected);
          setFilters((prev) => {
            if (prev.taskId && !collected.some((task) => task.id === prev.taskId)) {
              return { ...prev, taskId: '' };
            }
            return prev;
          });
        }
      } catch {
        if (!cancelled) setScopeTasks([]);
      } finally {
        if (!cancelled) setScopeLoading(false);
      }
    }
    loadTasksForScope();
    return () => {
      cancelled = true;
    };
  }, [filters.boardId, filters.columnId, scopeColumns]);

  const loadActivities = useCallback(
    async (applied: ScopeFilters) => {
      try {
        setLoading(true);
        const data = await activitiesApi.getAll({
          action: applied.action || undefined,
          startTime: applied.startTime || undefined,
          endTime: applied.endTime || undefined,
          boardId: applied.boardId || undefined,
          columnId: applied.columnId || undefined,
          taskId: applied.taskId || undefined,
        });
        setActivities(data.activities || []);
      } catch (err) {
        console.error('Failed to load activities:', err);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // Initial load + reload whenever the filter state changes. We
  // debounce via the natural React render cycle — typing into the
  // board / column select commits immediately, but the API request
  // is cheap enough (≤100 rows) that we don't need an artificial
  // delay.
  useEffect(() => {
    loadActivities(filters);
  }, [loadActivities, filters]);

  const handleFilterChange = <K extends keyof ScopeFilters>(key: K, value: ScopeFilters[K]) => {
    setFilters((prev) => {
      const next = { ...prev, [key]: value };
      // Drop downstream picks when an upstream dimension changes
      // so the chip count never overstates what's actually applied.
      if (key === 'boardId') {
        next.columnId = '';
        next.taskId = '';
      } else if (key === 'columnId') {
        next.taskId = '';
      }
      return next;
    });
  };

  const handleClearAll = () => {
    setFilters(emptyScopeFilters);
  };

  const handleClearSingle = (key: keyof ScopeFilters) => {
    setFilters((prev) => {
      const next = { ...prev, [key]: '' };
      if (key === 'boardId') {
        next.columnId = '';
        next.taskId = '';
      } else if (key === 'columnId') {
        next.taskId = '';
      }
      return next;
    });
  };

  const handleExportCsv = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const response = await activitiesApi.exportCsv({
        action: filters.action || undefined,
        startTime: filters.startTime || undefined,
        endTime: filters.endTime || undefined,
        boardId: filters.boardId || undefined,
        columnId: filters.columnId || undefined,
        taskId: filters.taskId || undefined,
      });
      const disposition = response.headers.get('Content-Disposition') || '';
      const filenameMatch = disposition.match(/filename=([^;]+)/);
      const filename = filenameMatch
        ? filenameMatch[1].trim().replace(/^"|"$/g, '')
        : `activity_log_${Date.now()}.csv`;
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : t('app.error.requestFailed', { status: '' });
      setExportError(message);
    } finally {
      setExporting(false);
    }
  };

  const formatTime = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return t('taskModal.justNow');
    if (diffMins < 60) return t('taskModal.minutesAgo', { count: diffMins });
    if (diffHours < 24) return t('taskModal.hoursAgo', { count: diffHours });
    if (diffDays < 7) return t('taskModal.daysAgo', { count: diffDays });
    return date.toLocaleString();
  };

  const handleActivityClick = async (activity: Activity) => {
    if (!clickableActions.includes(activity.action) || !activity.targetId) return;

    try {
      let taskId: string | null = null;

      if (activity.action === 'CREATE_TASK') {
        taskId = activity.targetId;
      } else if (activity.action === 'ADD_COMMENT') {
        const comment = await commentsApi.getById(activity.targetId);
        taskId = comment.taskId;
      }

      if (taskId) {
        const task = await tasksApi.getById(taskId);
        setSelectedTask(task);
        setShowTaskModal(true);
      }
    } catch (err) {
      console.error('Failed to load task:', err);
    }
  };

  const handleCloseTaskModal = () => {
    setShowTaskModal(false);
    setSelectedTask(null);
  };

  // s-1208: applied-filter chip descriptors. Mirrors the task-page
  // chip row — first chip is the aggregate "N filters applied"
  // counter (also the clear-all affordance), followed by one chip
  // per active dimension with a per-chip × handler.
  const appliedChips = useMemo(() => {
    const chips: Array<{ key: keyof ScopeFilters; label: string; onRemove: () => void }> = [];
    if (filters.action) {
      chips.push({
        key: 'action',
        label: `${t('settings.operationType')}: ${t(`settings.activities.${filters.action}`, filters.action)}`,
        onRemove: () => handleClearSingle('action'),
      });
    }
    if (filters.startTime) {
      chips.push({
        key: 'startTime',
        label: `${t('settings.startTime')}: ${filters.startTime}`,
        onRemove: () => handleClearSingle('startTime'),
      });
    }
    if (filters.endTime) {
      chips.push({
        key: 'endTime',
        label: `${t('settings.endTime')}: ${filters.endTime}`,
        onRemove: () => handleClearSingle('endTime'),
      });
    }
    if (filters.boardId) {
      const board = boards.find((b) => b.id === filters.boardId);
      chips.push({
        key: 'boardId',
        label: `${t('activityLog.scope.board')}: ${board?.name || filters.boardId}`,
        onRemove: () => handleClearSingle('boardId'),
      });
    }
    if (filters.columnId) {
      const col = scopeColumns.find((c) => c.id === filters.columnId);
      chips.push({
        key: 'columnId',
        label: `${t('activityLog.scope.column')}: ${col?.name || filters.columnId}`,
        onRemove: () => handleClearSingle('columnId'),
      });
    }
    if (filters.taskId) {
      const task = scopeTasks.find((tk) => tk.id === filters.taskId);
      chips.push({
        key: 'taskId',
        label: `${t('activityLog.scope.task')}: ${task?.title || filters.taskId}`,
        onRemove: () => handleClearSingle('taskId'),
      });
    }
    return chips;
    // t is stable; boards/scopeColumns/scopeTasks are the only
    // inputs that change the visible labels.
  }, [filters, boards, scopeColumns, scopeTasks, t]);

  if (loading && !currentUser) {
    return <LoadingScreen />;
  }

  if (error) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4">
        <div className="text-red-500">{t('app.error.loadFailed')}</div>
        <Link to="/" className="rounded-md bg-blue-500 px-4 py-2 text-sm text-white hover:bg-blue-600">
          {t('nav.back')}
        </Link>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-100 dark:bg-zinc-900 p-6">
      <div className="mx-auto max-w-4xl">
        <header className="mb-6">
          <Link
            to="/"
            className="mb-4 inline-block rounded-md bg-zinc-200 dark:bg-zinc-700 px-4 py-2 text-sm text-zinc-700 dark:text-zinc-400 hover:bg-zinc-300 dark:hover:bg-zinc-600"
          >
            ← {t('nav.back')}
          </Link>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <h1 className="text-2xl font-bold text-zinc-800 dark:text-zinc-100">{t('nav.activityLog')}</h1>
              {currentUser && (
                <div className="flex items-center gap-2">
                  <UserAvatar username={currentUser.nickname} avatar={currentUser.avatar} size="sm" />
                  <span className="text-sm text-zinc-600 dark:text-zinc-300">{currentUser.nickname}</span>
                </div>
              )}
            </div>
            <div className="flex items-center gap-3">
              <span className="text-sm text-zinc-500 dark:text-zinc-500">{activities.length} {t('nav.records')}</span>
              <button
                type="button"
                onClick={handleExportCsv}
                disabled={exporting}
                data-testid="activity-log-export-csv"
                className="inline-flex items-center gap-1 rounded-md border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-700 px-3 py-1.5 text-sm text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-600 disabled:opacity-50"
              >
                {exporting ? t('activityLog.exporting') : t('activityLog.exportCsv')}
              </button>
            </div>
          </div>
          {exportError && (
            <div className="mt-3 rounded-md bg-red-50 dark:bg-red-900/30 px-3 py-2 text-sm text-red-600 dark:text-red-300">
              {exportError}
            </div>
          )}
        </header>

        <div className="mb-4 rounded-lg bg-white dark:bg-zinc-800 p-4 shadow">
          <h3 className="mb-3 text-sm font-medium text-zinc-700 dark:text-zinc-400">{t('settings.filterConditions')}</h3>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div>
              <label htmlFor="filterAction" className="mb-1 block text-xs text-zinc-500 dark:text-zinc-500">{t('settings.operationType')}</label>
              <select
                id="filterAction"
                name="filterAction"
                value={filters.action}
                onChange={(e) => handleFilterChange('action', e.target.value)}
                className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
              >
                <option value="">{t('filter.all')}</option>
                <option value="CREATE_TASK">{t('settings.activities.CREATE_TASK')}</option>
                <option value="UPDATE_TASK">{t('settings.activities.UPDATE_TASK')}</option>
                <option value="DELETE_TASK">{t('settings.activities.DELETE_TASK')}</option>
                <option value="COMPLETE_TASK">{t('settings.activities.COMPLETE_TASK')}</option>
                <option value="ADD_COMMENT">{t('settings.activities.ADD_COMMENT')}</option>
                <option value="BOARD_CREATE">{t('settings.activities.BOARD_CREATE')}</option>
                <option value="BOARD_UPDATE">{t('settings.activities.BOARD_UPDATE')}</option>
                <option value="BOARD_DELETE">{t('settings.activities.BOARD_DELETE')}</option>
                <option value="COLUMN_CREATE">{t('settings.activities.COLUMN_CREATE')}</option>
                <option value="COLUMN_UPDATE">{t('settings.activities.COLUMN_UPDATE')}</option>
                <option value="COLUMN_DELETE">{t('settings.activities.COLUMN_DELETE')}</option>
                <option value="USER_CREATE">{t('settings.activities.USER_CREATE')}</option>
                <option value="USER_UPDATE">{t('settings.activities.USER_UPDATE')}</option>
                <option value="LOGIN">{t('settings.activities.LOGIN')}</option>
                <option value="LOGOUT">{t('settings.activities.LOGOUT')}</option>
              </select>
            </div>
            <div>
              <label htmlFor="filterStartTime" className="mb-1 block text-xs text-zinc-500 dark:text-zinc-500">{t('settings.startTime')}</label>
              <input
                type="datetime-local"
                id="filterStartTime"
                name="filterStartTime"
                value={filters.startTime}
                onChange={(e) => handleFilterChange('startTime', e.target.value)}
                className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="filterEndTime" className="mb-1 block text-xs text-zinc-500 dark:text-zinc-500">{t('settings.endTime')}</label>
              <input
                type="datetime-local"
                id="filterEndTime"
                name="filterEndTime"
                value={filters.endTime}
                onChange={(e) => handleFilterChange('endTime', e.target.value)}
                className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="filterBoard" className="mb-1 block text-xs text-zinc-500 dark:text-zinc-500">{t('activityLog.scope.board')}</label>
              <select
                id="filterBoard"
                name="filterBoard"
                value={filters.boardId}
                onChange={(e) => handleFilterChange('boardId', e.target.value)}
                data-testid="activity-log-filter-board"
                className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
              >
                <option value="">{t('activityLog.allBoards')}</option>
                {boards.map((board) => (
                  <option key={board.id} value={board.id}>{board.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="filterColumn" className="mb-1 block text-xs text-zinc-500 dark:text-zinc-500">{t('activityLog.scope.column')}</label>
              <select
                id="filterColumn"
                name="filterColumn"
                value={filters.columnId}
                onChange={(e) => handleFilterChange('columnId', e.target.value)}
                disabled={!filters.boardId}
                data-testid="activity-log-filter-column"
                className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none disabled:opacity-50"
              >
                <option value="">{t('activityLog.allColumns')}</option>
                {scopeColumns.map((col) => (
                  <option key={col.id} value={col.id}>{col.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="filterTask" className="mb-1 block text-xs text-zinc-500 dark:text-zinc-500">{t('activityLog.scope.task')}</label>
              <select
                id="filterTask"
                name="filterTask"
                value={filters.taskId}
                onChange={(e) => handleFilterChange('taskId', e.target.value)}
                disabled={!filters.boardId || scopeLoading}
                data-testid="activity-log-filter-task"
                className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none disabled:opacity-50"
              >
                <option value="">{t('activityLog.allTasks')}</option>
                {scopeTasks.map((task) => (
                  <option key={task.id} value={task.id}>{task.title}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {appliedChips.length > 0 && (
          <div
            className="mb-4 flex flex-wrap items-center gap-2"
            data-testid="activity-log-applied-filters"
            role="list"
            aria-label={t('filter.appliedCount_other', { count: appliedChips.length })}
          >
            <button
              type="button"
              onClick={handleClearAll}
              className="inline-flex items-center gap-1 rounded-full bg-blue-100 dark:bg-blue-900/40 px-2.5 py-1 text-xs font-medium text-blue-700 dark:text-blue-300 hover:bg-blue-200 dark:hover:bg-blue-900/60"
              title={t('filter.clearAll')}
              role="listitem"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
              </svg>
              <span>{t('filter.appliedCount_other', { count: appliedChips.length })}</span>
            </button>
            {appliedChips.map((chip) => (
              <span
                key={chip.key}
                role="listitem"
                className="inline-flex items-center gap-1 rounded-full bg-zinc-200 dark:bg-zinc-700 px-2.5 py-1 text-xs text-zinc-700 dark:text-zinc-200"
              >
                <span className="max-w-[16rem] truncate">{chip.label}</span>
                <button
                  type="button"
                  onClick={chip.onRemove}
                  aria-label={t('filter.removeFilter', { label: chip.label })}
                  className="text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-100"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </span>
            ))}
          </div>
        )}

        {loading ? (
          <div className="flex h-64 items-center justify-center">
            <div className="text-zinc-500 dark:text-zinc-500">{t('settings.loading')}</div>
          </div>
        ) : activities.length === 0 ? (
          <div className="rounded-lg bg-white dark:bg-zinc-700 p-8 text-center text-zinc-500 dark:text-zinc-500 shadow">
            {t('settings.noActivities')}
          </div>
        ) : (
          <div className="space-y-3">
            {activities.map((activity) => {
              const isClickable = clickableActions.includes(activity.action) && activity.targetId;
              return (
                <div
                  key={activity.id}
                  className={`flex items-start gap-4 rounded-lg bg-white dark:bg-zinc-800 p-4 shadow ${isClickable ? 'cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-700' : ''}`}
                  onClick={() => handleActivityClick(activity)}
                >
                  <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-blue-100">
                    <span className="text-lg">{actionIcons[activity.action] || '📌'}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`font-medium ${isClickable ? 'text-blue-600' : 'text-zinc-800 dark:text-zinc-100'}`}>
                        {typeof t(`settings.activities.${activity.action}`) === 'string' ? t(`settings.activities.${activity.action}`) : activity.action}
                      </span>
                      {activity.targetTitle && (
                        <span className="text-sm text-zinc-600 dark:text-zinc-300 truncate">- {activity.targetTitle}</span>
                      )}
                      {activity.details && (
                        <span className="text-sm text-blue-600">{activity.details}</span>
                      )}
                      {isClickable && (
                        <span className="text-xs text-blue-500">{t('settings.clickToView')}</span>
                      )}
                    </div>
                    <div className="mt-1 flex items-center gap-3 text-xs text-zinc-400 dark:text-zinc-500">
                      <span>{formatTime(activity.createdAt)}</span>
                      <span>|</span>
                      <span>{t('settings.operator')}: {users[activity.userId] || activity.userId}</span>
                      {currentUser?.role === 'ADMIN' && (
                        <>
                          {activity.ipAddress && (
                            <>
                              <span>|</span>
                              <span>IP: {activity.ipAddress}</span>
                            </>
                          )}
                          {activity.source && (
                            <>
                              <span>|</span>
                              <span>{t('settings.source')}: {activity.source === 'mcp' ? t('settings.agentActivity.sourceMcp') : t('settings.agentActivity.sourceWeb')}</span>
                            </>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {showTaskModal && selectedTask && (
          <TaskModal
            task={selectedTask}
            canEdit={false}
            onClose={handleCloseTaskModal}
            onUpdate={() => {}}
            onDelete={() => {}}
            onArchive={() => {}}
            onAddComment={() => {}}
          />
        )}
      </div>
    </div>
  );
}
