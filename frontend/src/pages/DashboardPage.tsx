import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { dashboardApi } from '../services/api';
import { useSetupGuard } from '../hooks/useSetupGuard';
import type { DashboardStats } from '../types/kanban';

const EMPTY_STATS: DashboardStats = {
  totalTasks: 0,
  tasksByStatus: {},
  tasksByPriority: {},
  publishedTasks: 0,
  draftTasks: 0,
  archivedTasks: 0,
  totalBoards: 0,
  activeBoardCount: 0,
  totalColumns: 0,
  totalUsers: 0,
  tasksCompletedLast7Days: 0,
  topAgentsByActivity: [],
  longestBlockedCards: [],
};

/**
 * Dashboard landing page (s-1195, PM_REVIEW_2026-09-17 §5.3 ROI #3).
 *
 * Surfaces the four headline tiles that the PM review committed to
 * the /dashboard route:
 *   1. Active board count
 *   2. Tasks completed in the last 7 days
 *   3. Top 3 agents by activity (last 7 days)
 *   4. 3 longest-blocked cards (oldest non-done, non-archived,
 *      published tasks)
 *
 * Each tile links into the surface it summarizes so the page acts
 * as a navigation hub as well as an at-a-glance status screen.
 */
export function DashboardPage() {
  const { t } = useTranslation();
  useSetupGuard();
  const [stats, setStats] = useState<DashboardStats>(EMPTY_STATS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    dashboardApi
      .getStats()
      .then((data) => {
        if (cancelled) return;
        setStats(data);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'loadFailed');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-br from-zinc-100 to-zinc-50 dark:from-zinc-800 dark:to-zinc-900 p-6">
      <div className="mx-auto max-w-6xl">
        <div className="mb-8 flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-blue-600 text-white shadow-lg shadow-blue-500/30">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="9" />
              <rect x="14" y="3" width="7" height="5" />
              <rect x="14" y="12" width="7" height="9" />
              <rect x="3" y="16" width="7" height="5" />
            </svg>
          </div>
          <div>
            <h1 className="text-2xl font-bold text-zinc-800 dark:text-zinc-100">
              {t('dashboard.title')}
            </h1>
            <p className="text-sm text-zinc-500 dark:text-zinc-500">
              {t('dashboard.subtitle')}
            </p>
          </div>
        </div>

        {error && (
          <div
            data-testid="dashboard-error"
            role="alert"
            className="mb-6 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300"
          >
            {t('app.error.loadFailed')}
          </div>
        )}

        <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Link
            to="/boards"
            data-testid="dashboard-tile-active-boards"
            className="group rounded-2xl border border-zinc-100 bg-white p-6 shadow-sm transition hover:border-blue-200 hover:shadow-md dark:border-zinc-700 dark:bg-zinc-800 dark:hover:border-blue-700"
          >
            <div className="mb-3 flex items-center justify-between">
              <span className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
                {t('dashboard.activeBoards')}
              </span>
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-400 group-hover:text-blue-500">
                <rect x="3" y="3" width="7" height="7" />
                <rect x="14" y="3" width="7" height="7" />
                <rect x="14" y="14" width="7" height="7" />
                <rect x="3" y="14" width="7" height="7" />
              </svg>
            </div>
            <div className="text-3xl font-bold text-zinc-800 dark:text-zinc-100">
              {loading ? '—' : stats.activeBoardCount}
            </div>
          </Link>

          <Link
            to="/completed"
            data-testid="dashboard-tile-completed-7d"
            className="group rounded-2xl border border-zinc-100 bg-white p-6 shadow-sm transition hover:border-green-200 hover:shadow-md dark:border-zinc-700 dark:bg-zinc-800 dark:hover:border-green-700"
          >
            <div className="mb-3 flex items-center justify-between">
              <span className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
                {t('dashboard.completedLast7Days')}
              </span>
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-400 group-hover:text-green-500">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <div className="text-3xl font-bold text-zinc-800 dark:text-zinc-100">
              {loading ? '—' : stats.tasksCompletedLast7Days}
            </div>
          </Link>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <section
            data-testid="dashboard-top-agents"
            className="rounded-2xl border border-zinc-100 bg-white p-6 shadow-sm dark:border-zinc-700 dark:bg-zinc-800"
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold text-zinc-800 dark:text-zinc-100">
                {t('dashboard.topAgents')}
              </h2>
              <Link
                to="/agent-activity"
                className="text-xs font-medium text-blue-500 hover:text-blue-600 dark:text-blue-400"
              >
                {t('dashboard.viewAll')}
              </Link>
            </div>
            {loading ? (
              <div className="text-sm text-zinc-400">{t('app.loading')}</div>
            ) : (stats.topAgentsByActivity ?? []).length === 0 ? (
              <div className="text-sm text-zinc-400">{t('dashboard.noAgentActivity')}</div>
            ) : (
              <ol className="space-y-3">
                {(stats.topAgentsByActivity ?? []).map((agent, idx) => (
                  <li
                    key={agent.userId}
                    data-testid={`dashboard-agent-${agent.userId}`}
                    className="flex items-center justify-between gap-3 rounded-xl bg-zinc-50 px-4 py-3 dark:bg-zinc-900/40"
                  >
                    <div className="flex items-center gap-3">
                      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-blue-100 text-sm font-semibold text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
                        {idx + 1}
                      </span>
                      <div className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-200 text-base dark:bg-zinc-700">
                        {agent.avatar || agent.nickname.slice(0, 1)}
                      </div>
                      <div>
                        <div className="text-sm font-medium text-zinc-800 dark:text-zinc-100">
                          {agent.nickname}
                        </div>
                      </div>
                    </div>
                    <span className="text-sm font-semibold text-zinc-600 dark:text-zinc-300">
                      {t('dashboard.activityCount', { count: agent.activityCount })}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section
            data-testid="dashboard-blocked-cards"
            className="rounded-2xl border border-zinc-100 bg-white p-6 shadow-sm dark:border-zinc-700 dark:bg-zinc-800"
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold text-zinc-800 dark:text-zinc-100">
                {t('dashboard.longestBlocked')}
              </h2>
              <Link
                to="/boards"
                className="text-xs font-medium text-blue-500 hover:text-blue-600 dark:text-blue-400"
              >
                {t('dashboard.viewAll')}
              </Link>
            </div>
            {loading ? (
              <div className="text-sm text-zinc-400">{t('app.loading')}</div>
            ) : (stats.longestBlockedCards ?? []).length === 0 ? (
              <div className="text-sm text-zinc-400">{t('dashboard.noBlockedCards')}</div>
            ) : (
              <ul className="space-y-3">
                {stats.longestBlockedCards?.map((card) => (
                  <li key={card.taskId}>
                    <Link
                      to={`/board/${card.boardId}/column/${card.columnId}`}
                      data-testid={`dashboard-blocked-${card.taskId}`}
                      className="block rounded-xl bg-zinc-50 px-4 py-3 transition hover:bg-zinc-100 dark:bg-zinc-900/40 dark:hover:bg-zinc-900/60"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium text-zinc-800 dark:text-zinc-100">
                          {card.title}
                        </span>
                        <span
                          className={[
                            'shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold',
                            card.priority === 'high'
                              ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
                              : card.priority === 'medium'
                                ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                                : 'bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300',
                          ].join(' ')}
                        >
                          {card.priority || 'low'}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
                        <span className="truncate">
                          {card.boardName} · {card.columnName}
                        </span>
                        <span className="shrink-0">
                          {t('dashboard.daysBlocked', { count: card.daysBlocked })}
                        </span>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
