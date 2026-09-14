// useTaskRun — poll the server for an in-flight CLI runner on a task
// (see `devDoc/CLI_RUNNER_PLAN_2026-09-12.md` §5 and
// `devDoc/CLI_RUNNER_OPENAPI_2026-09-12.yaml` §GET /runs/{taskId}).
//
// Returns the live `task_runs` row, or `null` when no runner currently
// holds the task (404 from the API is the "no row" signal — see
// `FinishRun`'s cleanup in the backend). The hook polls every
// `intervalMs` while the component is mounted, clears the interval on
// unmount, and uses an AbortController so an in-flight fetch can be
// cancelled when the interval fires again or the component goes away.
//
// Once the server returns a terminal row (`completed` / `failed` /
// `released`) the hook stops polling: the backend now retains terminal
// rows (s-1106) so the UI must opt out of the recurring GET itself to
// avoid hammering the endpoint for a task whose runner has already
// settled. The final row is still surfaced so callers can render the
// end-state badge / banner.
//
// We deliberately do NOT poll every task card in a board — the board
// page calls this hook per TaskCard so each one starts its own
// polling cycle. With ~30 tasks per board and a 5s interval the load
// is one HTTP GET per 150ms on average, which the API handles without
// breaking a sweat. A future task can introduce a per-board
// subscription if the volume grows (see follow-up ticket stub in
// `devDoc/CLI_RUNNER_PLAN_2026-09-12.md` §9).

import { useEffect, useState, useRef } from 'react';
import { runsApi } from '../services/api';
import type { TaskRun } from '../types/kanban';

export interface UseTaskRunOptions {
  /**
   * Polling interval in milliseconds. Defaults to 5000 — matches
   * the runner heartbeat cadence so a freshly-claimed row surfaces
   * within one cycle and a stale row that was reaped or finished
   * disappears within one cycle.
   */
  intervalMs?: number;
  /**
   * When `false`, the hook short-circuits to `null` and never
   * fetches. The TaskCard uses this to skip polling when the user
   * isn't on a board view (avoids leaking fetches during navigation).
   */
  enabled?: boolean;
}

export interface UseTaskRunResult {
  /** The live run row, or `null` when no runner holds this task. */
  run: TaskRun | null;
  /**
   * `true` while the initial fetch is in flight. After that the
   * component renders `run` regardless of subsequent polls.
   */
  loading: boolean;
  /**
   * The last fetch error, if any. Surface as a small text indicator
   * rather than blocking the card; the next poll will retry.
   */
  error: Error | null;
}

/**
 * Terminal run statuses — once the server reports any of these the
 * runner has settled and there is no reason to keep hitting
 * `GET /api/v1/runs/:taskId`. `claimed` / `running` are the only
 * live states (see backend `models.IsLive`).
 */
const TERMINAL_STATUSES: ReadonlySet<TaskRun['status']> = new Set([
  'completed',
  'failed',
  'released',
]);

function isTerminal(run: TaskRun | null): run is TaskRun {
  return run !== null && TERMINAL_STATUSES.has(run.status);
}

export function useTaskRun(
  taskId: string | null | undefined,
  options: UseTaskRunOptions = {}
): UseTaskRunResult {
  const { intervalMs = 5000, enabled = true } = options;
  const [run, setRun] = useState<TaskRun | null>(null);
  const [loading, setLoading] = useState<boolean>(enabled && !!taskId);
  const [error, setError] = useState<Error | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!enabled || !taskId) {
      setRun(null);
      setLoading(false);
      return undefined;
    }

    let cancelled = false;

    const stopPolling = (): void => {
      if (timerRef.current !== null) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      controllerRef.current?.abort();
      controllerRef.current = null;
    };

    const tick = async (): Promise<void> => {
      // Abort any in-flight request from the previous tick so a slow
      // server doesn't pile up fetches when the interval is short.
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      try {
        const result = await runsApi.getByTask(taskId, controller.signal);
        if (cancelled) return;
        setRun(result);
        setError(null);
        // Once the runner has settled we don't need to keep asking
        // the server — the row is terminal and won't change. Surface
        // the final row so the badge / banner can render the end
        // state, then tear down the interval.
        if (isTerminal(result)) {
          stopPolling();
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err as Error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    // Fire immediately so the badge shows on first render, then
    // continue at the configured interval. The WebSocket broadcast
    // path (board page listens for ws events) will also flip the run
    // row's column status, so the polling is the safety net rather
    // than the primary signal.
    void tick();
    timerRef.current = setInterval(() => {
      void tick();
    }, intervalMs);

    return () => {
      cancelled = true;
      if (timerRef.current !== null) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, [taskId, intervalMs, enabled]);

  return { run, loading, error };
}
