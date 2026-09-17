import { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { runsApi } from '../services/api';
import { useRunStore } from '../store/runStore';
import type { TaskRun } from '../types/kanban';

interface RunListItem extends TaskRun {
  taskTitle?: string;
}

/**
 * RunsPage — "live screen" for in-flight Agent runs (s-1193,
 * PM_REVIEW_2026-09-17 §5.1 finding #3).
 *
 * - Polls the per-task `runsApi.getByTask` for every task on the
 *   current board via `useRunStore`, which the parent BoardPage
 *   already populates.
 * - Subscribes to the WebSocket channel the board already uses and
 *   triggers a re-pull on `refresh` / `task_notification` messages so
 *   rows update without a hard 5-second poll cycle.
 * - Fullscreen mode (header toggle) hides the chrome so the page can
 *   sit on a wall display during a long Agent batch.
 *
 * Falls back gracefully when the WS connection is unavailable — the
 * row list keeps ticking on the polling interval.
 */
export function RunsPage() {
  const { t } = useTranslation();
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [recentlyCompleted, setRecentlyCompleted] = useState<RunListItem[]>([]);
  const [wsConnected, setWsConnected] = useState(false);
  const previousStatusRef = useRef<Record<string, TaskRun['status']>>({});

  const runs = useRunStore((s) => s.runs);
  const clearRun = useRunStore((s) => s.clearRun);

  // WS reconnect bookkeeping — the board WebSocket is owned by the
  // board page, so we mirror its reconnection lifecycle to avoid
  // piling up parallel sockets.
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptRef = useRef(0);

  const fetchAllRuns = useCallback(async () => {
    // Snapshot the currently-tracked task IDs and refresh each so the
    // page picks up new in-flight runs as soon as they're claimed.
    const ids = Object.keys(useRunStore.getState().runs);
    if (ids.length === 0) return;
    await Promise.all(
      ids.map(async (taskId) => {
        try {
          const row = await runsApi.getByTask(taskId);
          if (!row) {
            clearRun(taskId);
            return;
          }
          useRunStore.getState().setRun(taskId, row);
        } catch {
          // Best-effort: swallow per-row errors so one bad task does
          // not blank the screen.
        }
      })
    );
  }, [clearRun]);

  useEffect(() => {
    // Auto-poll every 5s as a safety net when the WS is down.
    const handle = setInterval(fetchAllRuns, 5000);
    return () => clearInterval(handle);
  }, [fetchAllRuns]);

  useEffect(() => {
    const getWsUrl = () => {
      if (import.meta.env.VITE_WS_URL) return import.meta.env.VITE_WS_URL;
      if (import.meta.env.DEV) return `ws://localhost:8081/ws`;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${protocol}//${window.location.host}/ws`;
    };
    const connect = () => {
      const ws = new WebSocket(getWsUrl());
      wsRef.current = ws;
      ws.onopen = () => {
        reconnectAttemptRef.current = 0;
        setWsConnected(true);
      };
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'refresh' || msg.type === 'task_notification') {
            void fetchAllRuns();
          }
        } catch {
          /* ignore malformed frames */
        }
      };
      ws.onclose = () => {
        setWsConnected(false);
        const attempt = reconnectAttemptRef.current;
        if (attempt < 10) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
          reconnectAttemptRef.current = attempt + 1;
          setTimeout(connect, delay);
        }
      };
    };
    connect();
    return () => {
      wsRef.current?.close();
    };
  }, [fetchAllRuns]);

  // Detect terminal-status transitions and feed the "recently
  // completed" panel so operators can see what just finished without
  // scrolling the live list.
  useEffect(() => {
    const TERMINAL: ReadonlySet<TaskRun['status']> = new Set(['completed', 'failed', 'released']);
    const newly: RunListItem[] = [];
    for (const [taskId, run] of Object.entries(runs)) {
      const prev = previousStatusRef.current[taskId];
      if (prev !== run.status && TERMINAL.has(run.status)) {
        newly.push(run);
      }
      previousStatusRef.current[taskId] = run.status;
    }
    if (newly.length > 0) {
      setRecentlyCompleted((prev) => [...newly.reverse(), ...prev].slice(0, 10));
    }
  }, [runs]);

  // Only show live (non-terminal) runs on the main grid; terminal
  // rows live in the "recently completed" panel so the wall display
  // always shows what's *running right now*.
  const liveEntries = Object.values(runs).filter(
    (r) => r.status === 'claimed' || r.status === 'running'
  );

  return (
    <div
      className={`min-h-screen bg-zinc-100 dark:bg-zinc-900 ${
        isFullscreen ? 'p-0' : 'p-6'
      }`}
    >
      <div className="mx-auto max-w-6xl">
        <div className="mb-6 flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold text-zinc-800 dark:text-zinc-100">
              {t('runs.pageTitle')}
            </h1>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              {t('runs.subtitle')}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${
                wsConnected
                  ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
                  : 'bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300'
              }`}
              data-testid="runs-ws-status"
            >
              <span className={`h-1.5 w-1.5 rounded-full ${wsConnected ? 'bg-green-500' : 'bg-zinc-400'}`} />
              {wsConnected ? t('runs.wsConnected') : t('runs.wsPolling')}
            </span>
            <button
              type="button"
              onClick={() => setIsFullscreen((f) => !f)}
              className="rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-1.5 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700"
              data-testid="runs-fullscreen-toggle"
              aria-pressed={isFullscreen}
            >
              {isFullscreen ? t('runs.exitFullscreen') : t('runs.enterFullscreen')}
            </button>
            <Link
              to="/boards"
              className="rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-1.5 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700"
            >
              ← {t('nav.back')}
            </Link>
          </div>
        </div>

        <section
          className="mb-6 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 p-4 shadow-sm"
          data-testid="runs-live-section"
        >
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
            {t('runs.liveTitle', { count: liveEntries.length })}
          </h2>
          {liveEntries.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
              <div className="text-4xl">🤖</div>
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                {t('runs.emptyLive')}
              </p>
            </div>
          ) : (
            <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {liveEntries.map((run) => (
                <RunLiveCard key={run.id} run={run} />
              ))}
            </ul>
          )}
        </section>

        <section
          className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 p-4 shadow-sm"
          data-testid="runs-recent-section"
        >
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
            {t('runs.recentTitle')}
          </h2>
          {recentlyCompleted.length === 0 ? (
            <p className="py-6 text-center text-sm text-zinc-500 dark:text-zinc-400">
              {t('runs.emptyRecent')}
            </p>
          ) : (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-700">
              {recentlyCompleted.map((run) => (
                <li
                  key={run.id}
                  className="flex items-center justify-between gap-3 py-2 text-sm"
                  data-status={run.status}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span
                      className={`inline-flex h-2 w-2 rounded-full ${
                        run.status === 'completed'
                          ? 'bg-green-500'
                          : run.status === 'failed'
                          ? 'bg-red-500'
                          : 'bg-zinc-400'
                      }`}
                    />
                    <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">
                      {run.runnerId}
                    </span>
                    <span className="truncate text-zinc-700 dark:text-zinc-200">
                      {run.taskTitle || run.taskId}
                    </span>
                  </div>
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">
                    {t(`taskModal.runStatus.${run.status}`)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function RunLiveCard({ run }: { run: TaskRun }) {
  const { t } = useTranslation();
  const claimedAtMs = new Date(run.claimedAt).getTime();
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const handle = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(handle);
  }, []);

  const elapsedSec = Number.isNaN(claimedAtMs) ? 0 : Math.max(0, Math.floor((now - claimedAtMs) / 1000));
  const elapsedLabel =
    elapsedSec < 60
      ? `${elapsedSec}s`
      : elapsedSec < 3600
      ? `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`
      : `${Math.floor(elapsedSec / 3600)}h ${Math.floor((elapsedSec % 3600) / 60)}m`;

  return (
    <li
      className="rounded-lg border border-violet-200 dark:border-violet-700/50 bg-violet-50/60 dark:bg-violet-900/20 p-3"
      data-testid="runs-live-card"
      data-status={run.status}
    >
      <div className="flex items-center gap-2">
        <span
          className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-violet-500 border-t-transparent"
          aria-hidden
        />
        <span className="text-xs font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-300">
          {t(`taskModal.runStatus.${run.status}`)}
        </span>
        <span className="ml-auto text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
          {elapsedLabel}
        </span>
      </div>
      <div className="mt-2 font-mono text-xs text-zinc-700 dark:text-zinc-200 truncate" title={run.runnerId}>
        {run.runnerId}
      </div>
      <div className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
        {run.agentId || '—'}
      </div>
      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-white/60 dark:bg-zinc-900/40">
        <div className="h-full w-full animate-pulse rounded-full bg-violet-500/70" />
      </div>
    </li>
  );
}