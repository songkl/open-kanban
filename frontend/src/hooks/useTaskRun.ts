import { useEffect, useState, useRef, useCallback } from 'react';
import type { TaskRun } from '@/types/kanban';
import { runsApi } from '@/services/api';

export interface UseTaskRunOptions {
  /** Poll cadence in ms. Defaults to 5000. Set to 0 to disable polling. */
  intervalMs?: number;
  /**
   * Skip the first poll until the caller has had a chance to settle
   * (e.g. when used inside a modal that opens lazily). Defaults to
   * false.
   */
  enabled?: boolean;
}

export interface UseTaskRunResult {
  /** Latest run row, or null when no row exists / fetch failed. */
  run: TaskRun | null;
  /** True while the very first fetch is in flight. */
  loading: boolean;
  /** Last fetch error (network/parse), or null. */
  error: Error | null;
  /**
   * s-1191: Force the next poll to fire immediately. Used by the
   * "Retry run" button so the badge reflects the requeued state
   * without waiting for the next `intervalMs` tick.
   */
  refetch: () => void;
}

const TERMINAL_STATUSES: ReadonlySet<TaskRun['status']> = new Set([
  'completed',
  'failed',
  'released',
]);

/**
 * useTaskRun — polls GET /api/v1/runs/:taskId while the drawer (or
 * any other caller) needs the latest `task_runs` row.
 *
 * Why polling instead of WebSocket: the CLI runner heartbeats every
 * 5–15s and the drawer only needs near-real-time accuracy; the cost
 * of a second WebSocket channel for one row is not worth it.
 *
 * Stops polling the moment the row reaches a terminal state so we
 * don't fire `intervalMs` requests forever for a runner that has
 * already settled (s-1168).
 */
export function useTaskRun(taskId: string | undefined | null, options: UseTaskRunOptions = {}): UseTaskRunResult {
  const intervalMs = options.intervalMs ?? 5000;
  const enabled = options.enabled ?? true;
  const [run, setRun] = useState<TaskRun | null>(null);
  const [loading, setLoading] = useState<boolean>(Boolean(taskId) && enabled);
  const [error, setError] = useState<Error | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // s-1191: bumped by `refetch()` so the next tick fires ASAP rather
  // than after `intervalMs` ms. Stored in a ref so the tick effect
  // closure always sees the latest value without having to rebind the
  // timer.
  const refetchCounterRef = useRef(0);
  const refetchTickRef = useRef<(() => void) | null>(null);

  const refetch = useCallback((): void => {
    refetchCounterRef.current += 1;
    refetchTickRef.current?.();
  }, []);

  useEffect(() => {
    if (!taskId || !enabled) {
      setRun(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let observedCounter = refetchCounterRef.current;

    const tick = async () => {
      // Re-fire immediately when the consumer bumped the refetch
      // counter between ticks.
      if (refetchCounterRef.current !== observedCounter) {
        observedCounter = refetchCounterRef.current;
      }
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const row = await runsApi.getByTask(taskId, { signal: controller.signal });
        if (cancelled) return;
        setRun(row);
        setError(null);
        setLoading(false);
        if (row && TERMINAL_STATUSES.has(row.status)) {
          // Settled — stop polling so we don't keep firing requests
          // for a runner that's already gone (s-1168). The terminal
          // row is still surfaced so callers can render the final
          // badge / banner.
          return;
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (err && typeof err === 'object' && 'isAbortError' in err && (err as { isAbortError?: boolean }).isAbortError) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      }
      if (!cancelled && intervalMs > 0) {
        timer = setTimeout(tick, intervalMs);
      }
    };
    refetchTickRef.current = () => {
      if (timer) clearTimeout(timer);
      void tick();
    };

    tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      abortRef.current?.abort();
    };
  }, [taskId, enabled, intervalMs]);

  return { run, loading, error, refetch };
}
