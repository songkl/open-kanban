import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { runsApi, tasksApi, authApi } from '@/services/api';
import { useSetupGuard } from '@/hooks/useSetupGuard';
import { CustomDropdown } from '@/components/CustomDropdown';
import { FilterPanelContent } from '@/components/FilterPanelContent';
import type { FilterState } from '@/hooks/useFilters';
import type { TaskRun } from '@/types/kanban';

const RUN_REFRESH_DEBOUNCE_MS = 500;

function getRunHistoryWsUrl(): string {
  if (import.meta.env.VITE_WS_URL) return import.meta.env.VITE_WS_URL;
  if (import.meta.env.DEV) {
    return `ws://localhost:8080/ws`;
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

type RunStatusFilter = '' | 'completed' | 'failed' | 'released';
type DateRangeFilter = '' | 'today' | 'thisWeek' | 'thisMonth';

interface RunFilters {
  status: RunStatusFilter;
  runnerId: string;
  search: string;
  dateRange: DateRangeFilter;
}

const statusBadgeStyles: Record<string, string> = {
  completed: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
  released: 'bg-orange-100 text-orange-700',
};

function formatDuration(start: string, end: string | null | undefined): string {
  const startMs = new Date(start).getTime();
  const endMs = end ? new Date(end).getTime() : Date.now();
  const diff = Math.max(0, endMs - startMs);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const remSec = seconds % 60;
    return remSec > 0 ? `${minutes}m ${remSec}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return remMin > 0 ? `${hours}h ${remMin}m` : `${hours}h`;
}

function isInDateRange(finishedAt: string | null | undefined, range: DateRangeFilter): boolean {
  if (!range) return true;
  if (!finishedAt) return false;
  const finished = new Date(finishedAt);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  switch (range) {
    case 'today':
      return finished >= todayStart;
    case 'thisWeek':
      return finished >= weekStart;
    case 'thisMonth':
      return finished >= monthStart;
    default:
      return true;
  }
}

export function RunHistoryPage() {
  const { t } = useTranslation();
  useSetupGuard();

  const [runs, setRuns] = useState<TaskRun[]>([]);
  const [taskTitles, setTaskTitles] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const filterPanelRef = useRef<HTMLDivElement>(null);

  const [filters, setFilters] = useState<RunFilters>({
    status: '',
    runnerId: '',
    search: '',
    dateRange: '',
  });

  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      try {
        const meData = await authApi.me();
        if (cancelled) return;
        if (!meData.user) {
          setError(t('app.error.unauthorized'));
          return;
        }
        await loadRuns();
      } catch (err) {
        if (!cancelled) {
          console.error('Failed to initialise run history page:', err);
          setError(t('app.error.loadFailed'));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    init();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!showFilters) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (filterPanelRef.current && !filterPanelRef.current.contains(e.target as Node)) {
        setShowFilters(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showFilters]);

  const loadRuns = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await runsApi.list({ limit: 50 });
      const safe = data || [];
      setRuns(safe);
      await loadTaskTitles(safe.map((r) => r.taskId));
    } catch (err) {
      console.error('Failed to fetch run history:', err);
      setError(t('app.error.loadFailed'));
    } finally {
      setLoading(false);
    }
    // loadTaskTitles only reads stable refs (tasksApi) so it doesn't
    // need to be in deps. Including it would trigger infinite loops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t]);

  // Incremental refresh via WebSocket: when the backend broadcasts
  // a task_notification with action="finish" or "release" (from
  // FinishRun / ReleaseRuns), refetch the run history so the page
  // shows the new terminal row without waiting for the user to
  // click the refresh button. The connection retries with backoff
  // on failure so the page degrades to manual refresh instead of
  // hammering the API when the WS server is unreachable.
  const loadRunsRef = useRef(loadRuns);

  useEffect(() => {
    loadRunsRef.current = loadRuns;
  });

  useEffect(() => {
    let cancelled = false;
    let reconnectAttempt = 0;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleRefresh = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        loadRunsRef.current();
      }, RUN_REFRESH_DEBOUNCE_MS);
    };

    const connect = () => {
      if (cancelled) return;
      try {
        ws = new WebSocket(getRunHistoryWsUrl());
      } catch {
        scheduleReconnect();
        return;
      }

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message && message.type === 'task_notification') {
            const action = message.action;
            if (action === 'finish' || action === 'release') {
              scheduleRefresh();
            }
          } else if (message && message.type === 'refresh') {
            scheduleRefresh();
          }
        } catch {
          // ignore malformed frames
        }
      };

      ws.onerror = () => {
        // onclose will fire next; reconnect logic lives there.
      };

      ws.onclose = () => {
        if (cancelled) return;
        scheduleReconnect();
      };
    };

    const scheduleReconnect = () => {
      if (cancelled) return;
      if (reconnectAttempt >= 5) return;
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempt), 30000);
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(() => {
        connect();
      }, delay);
    };

    connect();

    return () => {
      cancelled = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) {
        ws.onclose = null;
        try {
          ws.close();
        } catch {
          // ignore close errors during teardown
        }
      }
    };
    // Connect once on mount; reconnect/backoff is handled inside the effect.
  }, []);

  const loadTaskTitles = useCallback(async (taskIds: string[]) => {
    const unique = Array.from(new Set(taskIds.filter(Boolean)));
    if (unique.length === 0) return;
    const results = await Promise.allSettled(unique.map((id) => tasksApi.getById(id)));
    const next: Record<string, string> = {};
    unique.forEach((id, idx) => {
      const r = results[idx];
      if (r.status === 'fulfilled') {
        next[id] = r.value.title || id;
      }
    });
    setTaskTitles((prev) => ({ ...prev, ...next }));
  }, []);

  const uniqueRunners = useMemo(() => {
    const set = new Set<string>();
    runs.forEach((r) => {
      if (r.runnerId) set.add(r.runnerId);
    });
    return Array.from(set).sort();
  }, [runs]);

  const filteredRuns = useMemo(() => {
    const query = filters.search.trim().toLowerCase();
    return runs.filter((run) => {
      if (filters.status && run.status !== filters.status) return false;
      if (filters.runnerId && run.runnerId !== filters.runnerId) return false;
      if (filters.dateRange && !isInDateRange(run.finishedAt, filters.dateRange)) return false;
      if (query) {
        const title = (taskTitles[run.taskId] || '').toLowerCase();
        const id = run.taskId.toLowerCase();
        const runner = run.runnerId.toLowerCase();
        if (!title.includes(query) && !id.includes(query) && !runner.includes(query)) {
          return false;
        }
      }
      return true;
    });
  }, [runs, filters, taskTitles]);

  const hasActiveFilters = !!(filters.status || filters.runnerId || filters.search || filters.dateRange);

  const clearFilters = () => {
    setFilters({ status: '', runnerId: '', search: '', dateRange: '' });
  };

  const noopFiltersState: FilterState = useMemo(
    () => ({
      priority: '',
      assignee: '',
      searchQuery: '',
      dateRange: filters.dateRange as FilterState['dateRange'],
      tag: '',
      customField: { fieldId: '', value: '' },
      runStatus: '',
      hasComments: '',
      hasSubtasks: '',
    }),
    [filters.dateRange]
  );

  if (loading && runs.length === 0) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-zinc-500 dark:text-zinc-500">{t('app.loading')}</div>
      </div>
    );
  }

  if (error && runs.length === 0) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4">
        <div className="text-red-500">{error}</div>
        <button
          onClick={loadRuns}
          className="rounded-md bg-blue-500 px-4 py-2 text-sm text-white hover:bg-blue-600"
        >
          {t('app.error.retry')}
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-100 dark:bg-zinc-900 p-6">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <Link
            to="/"
            className="rounded-md bg-zinc-200 dark:bg-zinc-700 px-4 py-2 text-sm text-zinc-700 dark:text-zinc-400 hover:bg-zinc-300 dark:hover:bg-zinc-600"
          >
            {t('common.back')}
          </Link>
          <h1 className="text-2xl font-bold text-zinc-800 dark:text-zinc-100">{t('runs.title')}</h1>
        </div>
        <div className="flex items-center gap-3">
          <input
            type="search"
            value={filters.search}
            onChange={(e) => setFilters((prev) => ({ ...prev, search: e.target.value }))}
            placeholder={t('runs.searchPlaceholder')}
            className="rounded-md border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-700 px-3 py-1.5 text-sm"
          />
          <div className="relative">
            <button
              onClick={() => setShowFilters((v) => !v)}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm ${
                hasActiveFilters
                  ? 'bg-blue-100 text-blue-700 border border-blue-300'
                  : 'bg-zinc-200 text-zinc-700 dark:text-zinc-400 border border-transparent'
              } hover:bg-zinc-300 dark:hover:bg-zinc-600`}
            >
              {t('filter.filter')}
              {hasActiveFilters && (
                <span className="ml-1 rounded-full bg-blue-500 text-white text-xs w-4 h-4 flex items-center justify-center">
                  {[filters.status, filters.runnerId, filters.search, filters.dateRange].filter(Boolean).length}
                </span>
              )}
            </button>
            {showFilters && (
              <div
                ref={filterPanelRef}
                className="absolute right-0 top-full mt-2 w-64 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 p-3 shadow-lg z-50"
              >
                <FilterPanelContent
                  filters={noopFiltersState}
                  uniqueAssignees={[]}
                  uniqueTags={[]}
                  uniqueCustomFieldValues={{}}
                  customFields={[]}
                  filterPresets={[]}
                  showPresetDropdown={false}
                  onSetFilters={() => undefined}
                  onClearFilters={clearFilters}
                  hideBoardDefaults
                >
                  <div className="mb-3">
                    <label htmlFor="runs-filter-status" className="block text-xs font-medium text-zinc-500 dark:text-zinc-500 mb-1">
                      {t('runs.status')}
                    </label>
                    <CustomDropdown
                      id="runs-filter-status"
                      options={[
                        { value: '', label: t('filter.all') },
                        { value: 'completed', label: t('runs.statusCompleted') },
                        { value: 'failed', label: t('runs.statusFailed') },
                        { value: 'released', label: t('runs.statusReleased') },
                      ]}
                      value={filters.status}
                      onChange={(val) => setFilters((prev) => ({ ...prev, status: val as RunStatusFilter }))}
                      className="w-full"
                    />
                  </div>
                  <div className="mb-3">
                    <label htmlFor="runs-filter-runner" className="block text-xs font-medium text-zinc-500 dark:text-zinc-500 mb-1">
                      {t('runs.runner')}
                    </label>
                    <CustomDropdown
                      id="runs-filter-runner"
                      options={[
                        { value: '', label: t('filter.all') },
                        ...uniqueRunners.map((runner) => ({ value: runner, label: runner })),
                      ]}
                      value={filters.runnerId}
                      onChange={(val) => setFilters((prev) => ({ ...prev, runnerId: val }))}
                      className="w-full"
                    />
                  </div>
                  <div className="mb-3">
                    <label htmlFor="runs-filter-dateRange" className="block text-xs font-medium text-zinc-500 dark:text-zinc-500 mb-1">
                      {t('filter.dateRange')}
                    </label>
                    <CustomDropdown
                      id="runs-filter-dateRange"
                      options={[
                        { value: '', label: t('filter.all') },
                        { value: 'today', label: t('filter.today') },
                        { value: 'thisWeek', label: t('filter.thisWeek') },
                        { value: 'thisMonth', label: t('filter.thisMonth') },
                      ]}
                      value={filters.dateRange}
                      onChange={(val) => setFilters((prev) => ({ ...prev, dateRange: val as DateRangeFilter }))}
                      className="w-full"
                    />
                  </div>
                </FilterPanelContent>
              </div>
            )}
          </div>
          <button
            onClick={loadRuns}
            className="rounded-md bg-zinc-200 dark:bg-zinc-700 px-3 py-1.5 text-sm text-zinc-700 dark:text-zinc-400 hover:bg-zinc-300 dark:hover:bg-zinc-600"
          >
            {t('runs.refresh')}
          </button>
          <span className="text-sm text-zinc-500 dark:text-zinc-500">
            {t('runs.count', { shown: filteredRuns.length, total: runs.length })}
          </span>
        </div>
      </header>

      {loading ? (
        <div className="flex h-64 items-center justify-center">
          <div className="text-zinc-500 dark:text-zinc-500">{t('app.loading')}</div>
        </div>
      ) : filteredRuns.length === 0 ? (
        <div className="rounded-lg bg-white dark:bg-zinc-700 p-8 text-center text-zinc-500 dark:text-zinc-500 shadow">
          {hasActiveFilters ? t('runs.emptyFiltered') : t('runs.empty')}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg bg-white dark:bg-zinc-700 shadow">
          <table className="min-w-full divide-y divide-zinc-200 dark:divide-zinc-600">
            <thead className="bg-zinc-50 dark:bg-zinc-800">
              <tr>
                <th scope="col" className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-500">
                  {t('runs.column.time')}
                </th>
                <th scope="col" className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-500">
                  {t('runs.column.taskTitle')}
                </th>
                <th scope="col" className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-500">
                  {t('runs.column.runner')}
                </th>
                <th scope="col" className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-500">
                  {t('runs.column.status')}
                </th>
                <th scope="col" className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-500">
                  {t('runs.column.duration')}
                </th>
                <th scope="col" className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-500">
                  {t('runs.column.error')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-600 bg-white dark:bg-zinc-700">
              {filteredRuns.map((run) => {
                const badge = statusBadgeStyles[run.status] || 'bg-zinc-100 text-zinc-700';
                const title = taskTitles[run.taskId];
                const finishedAt = run.finishedAt ? new Date(run.finishedAt) : null;
                return (
                  <tr key={`${run.taskId}-${run.finishedAt ?? run.claimedAt}`} className="hover:bg-zinc-50 dark:hover:bg-zinc-600">
                    <td className="px-4 py-3 text-sm text-zinc-700 dark:text-zinc-300 whitespace-nowrap">
                      {finishedAt ? finishedAt.toLocaleString() : '—'}
                    </td>
                    <td className="px-4 py-3 text-sm text-zinc-700 dark:text-zinc-300">
                      {title ? (
                        <Link to={`/board/${run.boardId}`} className="text-blue-600 hover:underline">
                          {title}
                        </Link>
                      ) : (
                        <span className="font-mono text-xs text-zinc-400 dark:text-zinc-500">{run.taskId}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-zinc-700 dark:text-zinc-300 font-mono break-all">
                      {run.runnerId}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${badge}`}>
                        {t(`runs.status${run.status.charAt(0).toUpperCase()}${run.status.slice(1)}`)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-zinc-700 dark:text-zinc-300 whitespace-nowrap">
                      {formatDuration(run.claimedAt, run.finishedAt)}
                    </td>
                    <td className="px-4 py-3 text-sm text-zinc-700 dark:text-zinc-300 max-w-xs">
                      {run.error ? (
                        <span className="line-clamp-2 break-words text-red-600" title={run.error}>
                          {run.error}
                        </span>
                      ) : (
                        <span className="text-zinc-400 dark:text-zinc-500">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}