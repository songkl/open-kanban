import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TaskRun } from '@/types/kanban';

interface TaskRunIndicatorProps {
  run: TaskRun;
  /** When true, render only the spinner + status badge (compact mode). */
  compact?: boolean;
}

const STATUS_BORDER: Record<TaskRun['status'], string> = {
  claimed: 'border-blue-200 dark:border-blue-700/50',
  running: 'border-violet-200 dark:border-violet-700/50',
  completed: 'border-green-200 dark:border-green-700/50',
  failed: 'border-red-200 dark:border-red-700/50',
  released: 'border-zinc-200 dark:border-zinc-700/50',
};

const STATUS_BG: Record<TaskRun['status'], string> = {
  claimed: 'bg-blue-50/60 dark:bg-blue-900/20',
  running: 'bg-violet-50/60 dark:bg-violet-900/20',
  completed: 'bg-green-50/60 dark:bg-green-900/20',
  failed: 'bg-red-50/60 dark:bg-red-900/20',
  released: 'bg-zinc-50/60 dark:bg-zinc-800/40',
};

const STATUS_DOT: Record<TaskRun['status'], string> = {
  claimed: 'bg-blue-500',
  running: 'bg-violet-500',
  completed: 'bg-green-500',
  failed: 'bg-red-500',
  released: 'bg-zinc-400',
};

/**
 * Compute elapsed seconds between `claimedAt` and `endMs` (defaults to
 * now). Frozen at `endMs` once the run settles so the badge doesn't
 * keep ticking past the terminal state (s-1168).
 */
function computeElapsedSec(claimedAt: string, endMs: number | null): number {
  const startMs = new Date(claimedAt).getTime();
  if (Number.isNaN(startMs)) return 0;
  const stopMs = endMs ?? Date.now();
  return Math.max(0, Math.floor((stopMs - startMs) / 1000));
}

function formatElapsed(elapsedSec: number, t: (key: string, opts?: Record<string, unknown>) => string): string {
  if (elapsedSec < 60) return t('taskCard.runnerElapsedSeconds', { count: elapsedSec });
  if (elapsedSec < 3600) return t('taskCard.runnerElapsedMinutes', { count: Math.floor(elapsedSec / 60) });
  return t('taskCard.runnerElapsedHours', { count: Math.floor(elapsedSec / 3600) });
}

const TERMINAL_STATUSES: ReadonlySet<TaskRun['status']> = new Set(['completed', 'failed', 'released']);

/**
 * TaskRunIndicator — surfaces the live `task_runs` row directly on the
 * task card so a non-trivial Agent run is visible on the board
 * without opening the drawer (s-1193, PM_REVIEW_2026-09-17 §5.1).
 *
 * Two layout modes:
 *   - compact=true  → small badge (spinner + status dot + "Runner · 5s")
 *                     that fits inside the existing footer row.
 *   - compact=false → full-width block (spinner + progress bar + runner
 *                     + elapsed + status pill) rendered above the
 *                     footer so the run is the visual centerpiece.
 */
export function TaskRunIndicator({ run, compact = false }: TaskRunIndicatorProps) {
  const { t } = useTranslation();
  const isLive = run.status === 'claimed' || run.status === 'running';
  const finishedMs = run.finishedAt ? new Date(run.finishedAt).getTime() : null;

  // Tick once a second so the elapsed counter advances in real time
  // while the run is live. The interval is torn down as soon as the
  // status leaves the live set so terminal rows don't keep the timer
  // alive (s-1168).
  const [, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!isLive) return undefined;
    const handle = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(handle);
  }, [isLive]);

  const elapsedSec = computeElapsedSec(run.claimedAt, finishedMs);
  const elapsedLabel = formatElapsed(elapsedSec, t);
  const statusKey = run.status;
  const runnerShort = run.runnerId.length > 18 ? `${run.runnerId.slice(0, 15)}…` : run.runnerId;

  if (compact) {
    return (
      <span
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${STATUS_BG[run.status]} ${STATUS_BORDER[run.status]}`}
        data-testid="task-run-indicator-compact"
        data-status={run.status}
        title={t('taskCard.runnerBadgeAria', { runnerId: run.runnerId, elapsed: elapsedLabel })}
        aria-label={t('taskCard.runnerBadgeAria', { runnerId: run.runnerId, elapsed: elapsedLabel })}
      >
        {isLive ? (
          <span
            className="inline-block h-2 w-2 animate-spin rounded-full border-2 border-current border-t-transparent"
            aria-hidden
          />
        ) : (
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${STATUS_DOT[run.status]}`} aria-hidden />
        )}
        <span className="text-zinc-600 dark:text-zinc-300">🤖</span>
        <span className="max-w-[7rem] truncate font-mono text-zinc-700 dark:text-zinc-200">{runnerShort}</span>
        <span className="text-zinc-400 dark:text-zinc-500">·</span>
        <span className="tabular-nums text-zinc-600 dark:text-zinc-300">{elapsedLabel}</span>
      </span>
    );
  }

  return (
    <div
      className={`mt-3 rounded-lg border ${STATUS_BORDER[run.status]} ${STATUS_BG[run.status]} px-3 py-2`}
      data-testid="task-run-indicator"
      data-status={run.status}
    >
      <div className="flex items-center gap-2">
        {isLive ? (
          <span
            className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-violet-500 border-t-transparent"
            aria-hidden
            data-testid="run-spinner"
          />
        ) : (
          <span className={`inline-block h-2 w-2 rounded-full ${STATUS_DOT[run.status]}`} aria-hidden />
        )}
        <span className="text-xs font-semibold uppercase tracking-wide text-zinc-700 dark:text-zinc-200">
          {t(`taskModal.runStatus.${statusKey}`)}
        </span>
        <span className="text-zinc-400 dark:text-zinc-500">·</span>
        <span className="truncate text-xs text-zinc-600 dark:text-zinc-300" title={run.runnerId}>
          {t('taskCard.runnerLabel', { runnerId: runnerShort })}
        </span>
        <span className="ml-auto text-xs tabular-nums text-zinc-500 dark:text-zinc-400" data-testid="run-elapsed">
          {elapsedLabel}
        </span>
      </div>
      {/* Progress bar: indeterminate animation while live; settled fill
          width = 100% on terminal. Avoids a misleading fixed-X% value
          since we don't have a duration estimate for a generic Agent
          run. */}
      <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-white/60 dark:bg-zinc-900/40">
        <div
          className={`h-full rounded-full ${
            isLive
              ? 'w-full animate-pulse bg-violet-500/70'
              : run.status === 'completed'
              ? 'w-full bg-green-500'
              : run.status === 'failed'
              ? 'w-full bg-red-500'
              : 'w-full bg-zinc-400'
          }`}
          data-testid="run-progress-bar"
          data-terminal={TERMINAL_STATUSES.has(run.status) ? 'true' : 'false'}
        />
      </div>
    </div>
  );
}