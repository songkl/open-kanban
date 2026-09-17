import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TaskRun } from '@/types/kanban';

interface RunTimelineProps {
  run: TaskRun;
}

const TERMINAL_STATUSES: ReadonlySet<TaskRun['status']> = new Set(['completed', 'failed', 'released']);

/**
 * Compute elapsed seconds between `claimedAt` and `endMs`.
 * Frozen at `finishedAt` once the run settles so the timeline stops
 * ticking (s-1168).
 */
function computeElapsedSec(claimedAt: string, endMs: number | null): number {
  const startMs = new Date(claimedAt).getTime();
  if (Number.isNaN(startMs)) return 0;
  const stopMs = endMs ?? Date.now();
  return Math.max(0, Math.floor((stopMs - startMs) / 1000));
}

function formatElapsed(elapsedSec: number): string {
  if (elapsedSec < 60) return `${elapsedSec}s`;
  if (elapsedSec < 3600) return `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`;
  return `${Math.floor(elapsedSec / 3600)}h ${Math.floor((elapsedSec % 3600) / 60)}m`;
}

interface StepDef {
  key: 'claimed' | 'running' | 'finished';
  labelKey: string;
}

const STEPS: StepDef[] = [
  { key: 'claimed', labelKey: 'taskModal.runTimelineStepClaimed' },
  { key: 'running', labelKey: 'taskModal.runTimelineStepRunning' },
  { key: 'finished', labelKey: 'taskModal.runTimelineStepFinished' },
];

/**
 * Map a `task_runs.status` row to the three timeline steps the PM
 * review asked for (Claimed → Running → Finished). The `finished`
 * step is further broken out by terminal status so the colour of the
 * last node reflects success / failure without a fourth step.
 */
function resolveStepState(run: TaskRun): {
  claimed: 'done' | 'active' | 'pending';
  running: 'done' | 'active' | 'pending';
  finished: 'done' | 'active' | 'pending';
  failure: boolean;
} {
  const isTerminal = TERMINAL_STATUSES.has(run.status);
  const isFailure = run.status === 'failed';
  if (run.status === 'claimed') {
    return { claimed: 'active', running: 'pending', finished: 'pending', failure: false };
  }
  if (run.status === 'running') {
    return { claimed: 'done', running: 'active', finished: 'pending', failure: false };
  }
  // claimed/running/failed/released/completed all reach the finished step.
  return {
    claimed: 'done',
    running: isFailure ? 'done' : 'done',
    finished: isTerminal ? 'active' : 'pending',
    failure: isFailure,
  };
}

const NODE_STYLES: Record<'done' | 'active' | 'pending', string> = {
  done: 'bg-violet-500 text-white border-violet-500',
  active: 'bg-white dark:bg-zinc-800 text-violet-600 dark:text-violet-300 border-violet-500 ring-2 ring-violet-200 dark:ring-violet-700/50',
  pending: 'bg-white dark:bg-zinc-800 text-zinc-400 dark:text-zinc-500 border-zinc-300 dark:border-zinc-600',
};

const LINE_DONE = 'bg-violet-500';
const LINE_PENDING = 'bg-zinc-200 dark:bg-zinc-700';

/**
 * RunTimeline — CI-pipeline style stepper shown in the task drawer
 * header while a CLI runner holds the task.
 *
 * Renders three nodes (Claimed → Running → Finished) connected by a
 * horizontal track. The track animates with a violet pulse while the
 * run is in-flight so the operator can tell at a glance whether the
 * runner is still progressing (s-1193, PM_REVIEW_2026-09-17 §5.1
 * finding #2).
 */
export function RunTimeline({ run }: RunTimelineProps) {
  const { t, i18n } = useTranslation();
  const isLive = run.status === 'claimed' || run.status === 'running';
  const finishedMs = run.finishedAt ? new Date(run.finishedAt).getTime() : null;

  const [, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!isLive) return undefined;
    const handle = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(handle);
  }, [isLive]);

  const elapsedSec = computeElapsedSec(run.claimedAt, finishedMs);
  const stepState = resolveStepState(run);
  const totalSteps = STEPS.length;

  const locale = i18n.language === 'zh' ? 'zh-CN' : i18n.language;
  const timeFmt = new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  return (
    <div
      className="mt-2 rounded-lg border border-violet-200 dark:border-violet-700/50 bg-violet-50/40 dark:bg-violet-900/10 p-3"
      data-testid="run-timeline"
      data-status={run.status}
    >
      <div className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
        <span className="font-semibold">
          {t('taskModal.runTimelineTitle')}
        </span>
        <span className="tabular-nums" data-testid="run-timeline-elapsed">
          {formatElapsed(elapsedSec)}
        </span>
      </div>
      <div className="flex items-center" role="list">
        {STEPS.map((step, idx) => {
          const state = stepState[step.key];
          const isFinishedNode = idx === totalSteps - 1;
          const nextLineActive = idx < totalSteps - 1 && stepState[STEPS[idx + 1].key] !== 'pending';
          return (
            <div key={step.key} className="flex flex-1 items-center" role="listitem">
              <div className="flex flex-col items-center gap-1">
                <span
                  className={`flex h-6 w-6 items-center justify-center rounded-full border text-[11px] font-bold ${NODE_STYLES[state]}`}
                  aria-current={state === 'active' ? 'step' : undefined}
                  data-step={step.key}
                  data-state={state}
                >
                  {state === 'done' ? '✓' : idx + 1}
                </span>
                <span className="text-[10px] font-medium text-zinc-600 dark:text-zinc-400">
                  {t(step.labelKey)}
                </span>
              </div>
              {idx < totalSteps - 1 && (
                <div
                  className={`mx-1 h-0.5 flex-1 rounded-full ${
                    nextLineActive || (isLive && !isFinishedNode) ? LINE_DONE : LINE_PENDING
                  } ${isLive && !isFinishedNode ? 'animate-pulse' : ''}`}
                  data-testid={`run-timeline-line-${idx}`}
                />
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex items-center justify-between text-[11px] text-zinc-500 dark:text-zinc-400">
        <span className="truncate" title={run.runnerId}>
          {t('taskModal.runRunner')}: <span className="font-mono text-zinc-700 dark:text-zinc-200">{run.runnerId}</span>
        </span>
        <span>
          {run.finishedAt
            ? `${t('taskModal.runFinishedAt')} ${timeFmt.format(new Date(run.finishedAt))}`
            : `${t('taskModal.runClaimedAt')} ${timeFmt.format(new Date(run.claimedAt))}`}
        </span>
      </div>
    </div>
  );
}