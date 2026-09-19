import { create } from 'zustand';
import type { TaskRun } from '../types/kanban';

/**
 * Shared store of in-flight `task_runs` rows keyed by taskId.
 *
 * Why a store instead of prop-drilling: TaskCard is rendered inside
 * the virtualised Column list (~50–500 cards visible at once). Having
 * the board-level WebSocket poller write into a single map keeps the
 * render path O(1) per card and avoids each card firing its own
 * `GET /api/v1/runs/:taskId` request every 5s.
 *
 * Lifecycle:
 *   - `setRun(taskId, run)` updates / inserts a row
 *   - `clearRun(taskId)` removes a row (used when the task is moved
 *     out of the visible board, or when the run row expires after a
 *     terminal status)
 *
 * The store does not own polling — see `useBoardTaskRuns` for the
 * effect that drives these mutations.
 */
interface RunStore {
  runs: Record<string, TaskRun>;
  setRun: (taskId: string, run: TaskRun) => void;
  setRuns: (entries: Array<[string, TaskRun]>) => void;
  clearRun: (taskId: string) => void;
  clearAll: () => void;
}

export const useRunStore = create<RunStore>()((set) => ({
  runs: {},
  setRun: (taskId, run) =>
    set((state) => ({ runs: { ...state.runs, [taskId]: run } })),
  setRuns: (entries) =>
    set((state) => {
      const next = { ...state.runs };
      for (const [taskId, run] of entries) {
        next[taskId] = run;
      }
      return { runs: next };
    }),
  clearRun: (taskId) =>
    set((state) => {
      if (!(taskId in state.runs)) return state;
      const next = { ...state.runs };
      delete next[taskId];
      return { runs: next };
    }),
  clearAll: () => set({ runs: {} }),
}));

/**
 * Selector that returns the run for a single taskId. Using a selector
 * keeps re-renders narrow: a TaskCard only re-renders when *its own*
 * run row changes, not when any other task's run flips status.
 */
export function selectRunFor(taskId: string) {
  return (state: RunStore): TaskRun | null => state.runs[taskId] ?? null;
}