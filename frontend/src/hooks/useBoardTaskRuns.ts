import { useEffect, useRef } from 'react';
import { runsApi } from '../services/api';
import { useRunStore } from '../store/runStore';
import type { TaskRun } from '../types/kanban';

export interface BoardTaskRunCompletion {
  taskId: string;
  run: TaskRun;
  previousStatus: TaskRun['status'] | null;
}

export interface UseBoardTaskRunsOptions {
  /** Polling cadence in ms. Defaults to 5000 (matches useTaskRun). */
  intervalMs?: number;
  /** Skip polling when disabled (e.g. when the drawer already polls the same task). */
  enabled?: boolean;
  /**
   * Called whenever a run row transitions into a terminal state
   * (`completed`, `failed`, `released`). The previous status is
   * surfaced so callers can filter out "already terminal" re-fetches
   * that don't represent a fresh completion.
   */
  onRunComplete?: (event: BoardTaskRunCompletion) => void;
}

/**
 * useBoardTaskRuns — board-level poll for in-flight `task_runs` rows.
 *
 * Why one hook for the whole board: a 100-card board with 5 in-flight
 * runners would otherwise fire 5 × 1 = 5 polling timers (one per
 * TaskCard), which is wasteful and creates fan-out on the backend.
 * Centralising the poll into a single shared loop means the cost is
 * always `O(N)` where N = # of tasks currently in flight, regardless
 * of how many cards are mounted.
 *
 * The hook writes results into `useRunStore` so individual TaskCards
 * can subscribe via a narrow selector without re-rendering the whole
 * board on every poll tick.
 */
export function useBoardTaskRuns(
  taskIds: string[],
  options: UseBoardTaskRunsOptions = {}
): void {
  const intervalMs = options.intervalMs ?? 5000;
  const enabled = options.enabled ?? true;
  const onRunComplete = options.onRunComplete;

  const setRuns = useRunStore((s) => s.setRuns);
  const clearRun = useRunStore((s) => s.clearRun);

  // Latest taskIds snapshot for the tick effect — keyed by length and
  // a sorted join so a stable task list does not reset the timer.
  const taskIdsRef = useRef<string>('');
  const onCompleteRef = useRef(onRunComplete);
  useEffect(() => {
    onCompleteRef.current = onRunComplete;
  }, [onRunComplete]);

  useEffect(() => {
    if (!enabled || taskIds.length === 0) {
      taskIdsRef.current = '';
      return undefined;
    }
    const sortedKey = [...taskIds].sort().join('|');
    // If the task set has not changed, do nothing — the existing
    // tick effect keeps running and re-pulls whatever subset of the
    // current board is in flight.
    if (sortedKey === taskIdsRef.current) {
      return undefined;
    }
    taskIdsRef.current = sortedKey;

    const previousStatus = new Map<string, TaskRun['status']>();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) return;
      // Pull only the IDs that are *still* on the board. We use the
      // latest taskIdsRef snapshot rather than the closure variable
      // so a freshly mounted card gets included on the next tick.
      const ids = taskIdsRef.current ? taskIdsRef.current.split('|') : [];
      if (ids.length === 0) return;

      const results = await Promise.all(
        ids.map(async (taskId): Promise<[string, TaskRun | null]> => {
          try {
            const row = await runsApi.getByTask(taskId);
            return [taskId, row];
          } catch {
            return [taskId, null];
          }
        })
      );

      if (cancelled) return;

      const updates: Array<[string, TaskRun]> = [];
      for (const [taskId, row] of results) {
        if (!row) {
          // No active run — clear any stale row so a terminal card
          // doesn't keep rendering a spinner.
          const prev = previousStatus.get(taskId);
          if (prev) {
            previousStatus.delete(taskId);
          }
          clearRun(taskId);
          continue;
        }
        updates.push([taskId, row]);
        const prev = previousStatus.get(taskId);
        if (
          prev &&
          prev !== row.status &&
          (row.status === 'completed' ||
            row.status === 'failed' ||
            row.status === 'released')
        ) {
          onCompleteRef.current?.({ taskId, run: row, previousStatus: prev });
        }
        previousStatus.set(taskId, row.status);
      }
      if (updates.length > 0) {
        setRuns(updates);
      }

      if (intervalMs > 0) {
        timer = setTimeout(tick, intervalMs);
      }
    };

    // Fire the first tick immediately so the badge appears without
    // waiting `intervalMs` after the board mounts.
    tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [taskIds, intervalMs, enabled, setRuns, clearRun]);
}