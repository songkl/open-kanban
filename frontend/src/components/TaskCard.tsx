import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useState, useId, useEffect, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { CardDensity, CustomField, Task, TaskRun } from '@/types/kanban';
import { ConfirmDialog } from './ConfirmDialog';
import { UserAvatar } from './UserAvatar';
import { useTaskRun } from '../hooks/useTaskRun';
import { TaskRunIndicator } from './TaskRunIndicator';
import { CustomFieldChips } from './CustomFieldChips';
import { getDueDateMeta } from '../utils/dueDate';

interface TaskCardProps {
  task: Task;
  columnName?: string;
  onClick: () => void;
  onCommentsClick?: () => void;
  onArchive?: (taskId: string) => void;
  onDelete?: (taskId: string) => void;
  onMoveToColumn?: (taskId: string, toColumnId: string) => void;
  columns?: Array<{ id: string; name: string }>;
  searchQuery?: string;
  isSelected?: boolean;
  onSelect?: (taskId: string, e?: React.ChangeEvent<HTMLInputElement>) => void;
  /**
   * Live `task_runs` row for this card. Surfaced as a runner badge /
   * progress block so the user can see in-flight Agent runs on the
   * board without opening the drawer (s-1193,
   * PM_REVIEW_2026-09-17 §5.1). When absent (no run, or polling
   * disabled) the card renders unchanged.
   */
  run?: TaskRun | null;
  /**
   * s-1197: per-board custom field definitions. When provided, any
   * matching values from `task.meta` render as colored chips between
   * the description and the footer. Threaded from BoardPage → ColumnBoard
   * → Column → TaskCard (same plumbing as `run`) so the chip rendering
   * doesn't need its own localStorage hook.
   */
  customFields?: CustomField[];
  /**
   * s-1213: per-user card density preference (PM-s1188 §3.3).
   *   - 'compact'  → only the ID, title, and priority dot render
   *   - 'standard' → current behaviour (assignee + counts)
   *   - 'detailed' → + description preview + last activity + live Run
   *                 badge when a task_runs row exists for this task
   *
   * Defaults to 'standard' to match the existing rendering for any
   * caller that hasn't been threaded through yet (tests, column
   * detail drawer, etc.).
   */
  density?: CardDensity;
}

  const priorityColors: Record<string, string> = {
  high: 'bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-400',
  medium: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/70 dark:text-yellow-200',
  low: 'bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-400',
};

const priorityBorderColors: Record<string, string> = {
  high: 'border-l-4 border-red-500',
  medium: 'border-l-4 border-yellow-500',
  low: 'border-l-4 border-green-500',
};

function highlightText(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const parts = text.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));
  return parts.map((part, i) =>
    part.toLowerCase() === query.toLowerCase()
      ? <mark key={i} className="bg-yellow-200 dark:bg-yellow-500 rounded px-0.5">{part}</mark>
      : part
  );
}

/**
 * Format the elapsed time since `claimedAt` into a short human label
 * (e.g. "12s", "3m", "1h"). Stays short on purpose — the badge has
 * limited horizontal space on a task card.
 *
 * When `finishedAt` is supplied (i.e. the run has reached a terminal
 * status) the elapsed label is frozen at `finishedAt - claimedAt` so
 * the badge does not keep ticking once the runner has settled.
 */
function formatRunElapsed(
  claimedAt: string,
  t: (key: string, opts?: Record<string, unknown>) => string,
  finishedAt?: string | null
): string {
  const startMs = new Date(claimedAt).getTime();
  if (Number.isNaN(startMs)) return t('taskCard.runnerElapsedSeconds', { count: 0 });
  const endMs = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  const elapsedSec = Math.max(0, Math.floor((endMs - startMs) / 1000));
  if (elapsedSec < 60) return t('taskCard.runnerElapsedSeconds', { count: elapsedSec });
  if (elapsedSec < 3600) {
    return t('taskCard.runnerElapsedMinutes', { count: Math.floor(elapsedSec / 60) });
  }
  return t('taskCard.runnerElapsedHours', { count: Math.floor(elapsedSec / 3600) });
}

/**
 * RunnerBadge — small pill rendered on a task card while a CLI runner
 * is processing it (see `devDoc/CLI_RUNNER_PLAN_2026-09-12.md` §5).
 * Refreshes the elapsed label every second while the run is live
 * (`claimed` / `running`) so the running timer stays accurate without
 * re-querying the API on every tick. Once the run settles into a
 * terminal state (`completed` / `failed` / `released`) the interval
 * is skipped and the label is frozen at the `finishedAt` time so the
 * card stops re-rendering for a runner that has already gone away.
 */
function RunnerBadge({
  runnerId,
  label,
  live,
}: {
  runnerId: string;
  label: string;
  live: boolean;
}) {
  const { t } = useTranslation();
  // Re-render every second so the elapsed label stays accurate. The
  // 1s cadence is intentional — finer granularity wastes CPU on every
  // task card on the board; coarser granularity makes the badge feel
  // stale. Skip the interval entirely for terminal runs (s-1168) so a
  // settled task does not keep ticking on the board.
  const [, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!live) return undefined;
    const handle = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(handle);
  }, [live]);
  return (
    <span
      className="inline-flex max-w-[10rem] items-center gap-1 overflow-hidden rounded-full bg-violet-50 dark:bg-violet-900/30 px-2 py-0.5 text-xs font-medium text-violet-700 dark:text-violet-300 border border-violet-200 dark:border-violet-700/50"
      aria-label={t('taskCard.runnerBadgeAria', { runnerId, elapsed: label })}
      title={`${runnerId} · ${label}`}
      data-testid="runner-badge"
    >
      <span aria-hidden className="flex-shrink-0">🤖</span>
      <span className="font-mono truncate" title={runnerId}>{runnerId}</span>
      <span aria-hidden className="flex-shrink-0">·</span>
      <span className="flex-shrink-0">{label}</span>
    </span>
  );
}

export function TaskCard({ task, columnName, onClick, onCommentsClick, onArchive, onDelete, onMoveToColumn, columns, searchQuery, isSelected, onSelect, run: runProp, customFields, density }: TaskCardProps) {
  const { t } = useTranslation();
  const randomId = useId();
  const taskId = task?.id ?? `temp-${randomId}`;
  const [isExpanded, setIsExpanded] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [showMoveSubmenu, setShowMoveSubmenu] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const [confirmDialog, setConfirmDialog] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
    variant?: 'danger' | 'warning' | 'default';
  }>({ isOpen: false, title: '', message: '', onConfirm: () => {} });

  // Poll for an in-flight CLI runner. The badge only renders when the
  // server returns a live `task_runs` row (claimed or running); a 404
  // flips `run` back to null and the badge disappears.
  const { run: polledRun } = useTaskRun(task?.id, { intervalMs: 5000 });
  const run = runProp ?? polledRun;

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    isDragging,
  } = useSortable({
    id: taskId,
    // Drop animation makes the card visually bounce back to its pre-drag
    // position before React's reconciliation moves it to the new DOM
    // spot. Disable it so the card always lands at its final position
    // immediately, matching the synchronous `setColumns` update that
    // the parent does in onDragEnd. While dragging, `useSortable`
    // already drives the card in real time via `transform` without any
    // CSS transition, so this only affects the post-drop settle phase.
    transition: null,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
  };

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (showMoreMenu && moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setShowMoreMenu(false);
        setShowMoveSubmenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showMoreMenu]);

  const handleCardClick = (e: React.MouseEvent) => {
    if ((e.metaKey || e.ctrlKey) && onSelect) {
      e.preventDefault();
      onSelect(task.id, e as unknown as React.ChangeEvent<HTMLInputElement>);
    } else {
      onClick();
    }
  };

  // s-1213: density gating (PM-s1188 §3.3). Compact shows just the
  // top header strip; detailed layers on a description preview, a
  // last-activity timestamp, and a run badge that only fires when a
  // live run row exists. Standard mirrors the legacy rendering so
  // existing snapshots / tests stay green.
  const isCompact = density === 'compact';
  const isDetailed = density === 'detailed';
  const isLiveRun = Boolean(run && (run.status === 'claimed' || run.status === 'running'));
  const lastActivityLabel = useMemo(() => {
    if (!task.updatedAt) return null;
    const updated = new Date(task.updatedAt);
    if (Number.isNaN(updated.getTime())) return null;
    return updated.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }, [task.updatedAt]);

  // s-1230: deadline chip metadata. Computed once per render so the
  // priority + due-date row in the footer stays consistent for the
  // same input — also avoids re-parsing the date on every scroll
  // tick from the virtualised list.
  const _dueDateMeta = useMemo(() => (task.dueAt ? getDueDateMeta(task.dueAt) : null), [task.dueAt]);
  void _dueDateMeta;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={handleCardClick}
      className={`group relative cursor-grab rounded-xl bg-white dark:bg-zinc-800/80 p-4 shadow-sm border border-zinc-100 dark:border-zinc-700/50 transition-all hover:shadow-lg hover:border-zinc-200 dark:border-zinc-700 dark:hover:border-zinc-600 active:cursor-grabbing max-w-full ${
        isDragging ? 'opacity-60 ring-2 ring-blue-400 scale-105 z-50 shadow-blue-200 dark:shadow-blue-900/50' : ''
      } ${priorityBorderColors[task.priority] || priorityBorderColors.medium} ${isSelected ? 'ring-2 ring-blue-500 bg-blue-50/50 dark:bg-blue-900/20' : ''}`}
    >
      {/* Selection checkbox */}
      {onSelect && (
        <div
          className={`absolute left-1 top-1/2 -translate-y-1/2 z-10 ${
            isDragging ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          }`}
          onMouseDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <label className="sr-only" htmlFor={`task-select-${task.id}`}>
            {t('taskCard.selectTask')}
          </label>
          <input
            id={`task-select-${task.id}`}
            name={`task-select-${task.id}`}
            type="checkbox"
            checked={isSelected || false}
            onChange={(e) => onSelect && onSelect(task.id, e)}
            className="h-4 w-4 rounded border-zinc-300 dark:border-zinc-600 text-blue-500 focus:ring-blue-400 cursor-pointer"
            aria-label={t('taskCard.selectTask')}
          />
        </div>
      )}

      {/* Drag indicator */}
      <div
        className={`absolute left-1 top-1/2 -translate-y-1/2 flex flex-col gap-1 ${
          isDragging ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        } ${onSelect ? 'left-5' : ''}`}
        title={t('taskCard.dragToSort')}
      >
        <span className="h-0.5 w-1.5 rounded-full bg-zinc-400" />
        <span className="h-0.5 w-1.5 rounded-full bg-zinc-400" />
        <span className="h-0.5 w-1.5 rounded-full bg-zinc-400" />
      </div>

        <div className={`flex items-start justify-between gap-3 ${onSelect ? 'pl-6' : 'pl-3'}`}>
        <div className="flex-1 min-w-0">
          <div className="mb-1.5 flex items-center gap-2">
            <span
              className={`inline-block h-2 w-2 rounded-full flex-shrink-0 ${
                task.priority === 'high' ? 'bg-red-500 shadow-sm shadow-red-500/50' :
                task.priority === 'medium' ? 'bg-yellow-500 shadow-sm shadow-yellow-500/50' :
                'bg-green-500 shadow-sm shadow-green-500/50'
              }`}
            />
            <span className="text-xs text-zinc-400 dark:text-zinc-400 font-mono">
              #{String(task.id || '').slice(-6)}
            </span>
          </div>
          <h3 className="font-semibold text-zinc-800 dark:text-zinc-100 break-words leading-snug">
            {searchQuery ? highlightText(task.title || 'Untitled', searchQuery) : task.title || 'Untitled'}
          </h3>
        </div>
        <div className="flex items-center gap-1 relative">
          {!isCompact && (onArchive || onDelete || onMoveToColumn) && (
            <button
              type="button"
              onMouseDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                setShowMoreMenu(!showMoreMenu);
              }}
              className="flex-shrink-0 rounded-lg p-1.5 text-zinc-400 dark:text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-600 dark:bg-zinc-700 hover:text-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-700 dark:hover:text-zinc-300 z-10 relative transition-colors"
              title={t('taskCard.moreActions')}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="1"/>
                <circle cx="12" cy="5" r="1"/>
                <circle cx="12" cy="19" r="1"/>
              </svg>
            </button>
          )}
          {showMoreMenu && (
            <div
              ref={moreMenuRef}
              className="absolute right-0 top-full mt-1 w-40 rounded-md bg-white dark:bg-zinc-700 shadow-lg ring-1 ring-zinc-200 dark:ring-zinc-600 z-20"
              onMouseDown={(e) => e.stopPropagation()}
            >
              {onMoveToColumn && columns && (
                <div className="relative">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowMoveSubmenu(!showMoveSubmenu);
                    }}
                    className="w-full text-left px-3 py-2 text-sm text-blue-500 hover:bg-zinc-100 dark:hover:bg-zinc-600 rounded-t-md flex items-center justify-between"
                  >
                    <span>{t('taskCard.moveToColumn')}</span>
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={showMoveSubmenu ? 'rotate-90' : ''}>
                      <polyline points="9 18 15 12 9 6"/>
                    </svg>
                  </button>
                  {showMoveSubmenu && (
                    <div className="absolute top-full left-0 mt-1 w-36 rounded-md bg-white dark:bg-zinc-700 shadow-lg ring-1 ring-zinc-200 dark:ring-zinc-600 z-30">
                      {columns.filter(col => col.id !== task.columnId).map(col => (
                        <button
                          key={col.id}
                          onClick={(e) => {
                            e.stopPropagation();
                            onMoveToColumn(task.id, col.id);
                            setShowMoreMenu(false);
                            setShowMoveSubmenu(false);
                          }}
                          className="w-full text-left px-3 py-2 text-sm text-zinc-700 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-600 first:rounded-t-md last:rounded-b-md"
                        >
                          {col.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {onArchive && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onArchive(task.id);
                    setShowMoreMenu(false);
                  }}
                  className="w-full text-left px-3 py-2 text-sm text-orange-500 hover:bg-zinc-100 dark:hover:bg-zinc-600 rounded-t-md"
                >
                  {t('taskCard.archiveTask')}
                </button>
              )}
              {onDelete && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmDialog({
                      isOpen: true,
                      title: t('taskModal.confirmDeleteTitle'),
                      message: t('task.confirmDelete'),
                      variant: 'danger',
                      onConfirm: () => {
                        onDelete(task.id);
                        setConfirmDialog(prev => ({ ...prev, isOpen: false }));
                      },
                    });
                    setShowMoreMenu(false);
                  }}
                  className="w-full text-left px-3 py-2 text-sm text-red-500 hover:bg-zinc-100 dark:hover:bg-zinc-600 rounded-b-md"
                >
                  {t('taskCard.deleteTask')}
                </button>
              )}
            </div>
          )}
          {!isCompact && (
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onClick();
            }}
            className="flex-shrink-0 rounded-lg p-1.5 text-zinc-400 dark:text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-600 dark:bg-zinc-700 hover:text-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-700 dark:hover:text-zinc-300 z-10 relative transition-colors"
            title={t('taskCard.viewDetails')}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <path d="M12 16v-4"/>
              <path d="M12 8h.01"/>
            </svg>
          </button>
          )}
        </div>
      </div>
      {/* s-1193: live Runner badge / progress block — surfaces the
          in-flight Agent run directly on the board (PM_REVIEW_2026-09-17
          §5.1). Rendered only when a `task_runs` row exists so the card
          footprint is unchanged for tasks without a runner.
          s-1213: hidden in compact density; in detailed mode we only
          surface live runs (claimed/running) so the badge stays a
          signal rather than a stale footer. */}
      {!isCompact && run && (!isDetailed || isLiveRun) && (
        <div className={`mt-2 ${onSelect ? 'pl-6' : 'pl-3'} pr-1`}>
          <TaskRunIndicator run={run} />
        </div>
      )}
      {!isCompact && task.description && typeof task.description === 'string' && (
        <div className="mb-3 pl-3">
          <p
            className={`text-sm text-zinc-500 dark:text-zinc-500 cursor-pointer hover:text-zinc-600 dark:text-zinc-300 dark:hover:text-zinc-300 transition-all leading-relaxed ${
              isExpanded ? '' : 'line-clamp-2'
            }`}
            onClick={(e) => {
              e.stopPropagation();
              setIsExpanded(!isExpanded);
            }}
            title={isExpanded ? t('taskCard.clickToCollapse') : t('taskCard.clickToExpand')}
          >
            {searchQuery ? highlightText(task.description, searchQuery) : task.description}
          </p>
          {task.description.length > 50 && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setIsExpanded(!isExpanded);
              }}
              className="mt-1 text-xs text-blue-500 hover:text-blue-600 font-medium"
            >
              {isExpanded ? t('taskCard.collapse') : t('taskCard.expand')}
            </button>
          )}
        </div>
      )}
      {/* s-1197: custom field chips. Render only when at least one
          defined field has a non-empty value on the task meta; otherwise
          the component returns null so the layout stays identical for
          boards without custom fields defined. */}
      {!isCompact && customFields && customFields.length > 0 && (
        <CustomFieldChips meta={task.meta} customFields={customFields} />
      )}
      {/* Subtasks preview */}
      {!isCompact && task.subtasks && task.subtasks.length > 0 && (
        <div className="mb-3 pl-3 space-y-1.5">
          {task.subtasks.slice(0, 3).map((subtask) => (
            <div key={subtask.id} className="flex items-center gap-2 text-xs">
              <span className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${subtask.completed ? 'bg-green-500' : 'bg-zinc-300 dark:bg-zinc-600'}`} />
              <span className={subtask.completed ? 'text-zinc-400 dark:text-zinc-500 line-through truncate' : 'text-zinc-600 dark:text-zinc-300 truncate'}>
                {subtask.title}
              </span>
            </div>
          ))}
          {task.subtasks.length > 3 && (
            <span className="text-xs text-zinc-400 dark:text-zinc-400">{t('taskCard.moreSubtasks', { count: task.subtasks.length - 3 })}</span>
          )}
        </div>
      )}
      {!isCompact && (
      <div className="flex items-center justify-between pl-3 pt-1 border-t border-zinc-100 dark:border-zinc-700/50">
        <div className="flex items-center gap-2.5 flex-wrap">
          {columnName === t('task.status.done') && (
            <span className="text-green-500" title={t('taskCard.completed')}>✓</span>
          )}
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
              priorityColors[task.priority] || priorityColors.medium
            }`}
          >
            {task.priority === 'high' ? t('task.priority.high') : task.priority === 'medium' ? t('task.priority.medium') : t('task.priority.low')}
          </span>
          {run && (
            <RunnerBadge
              runnerId={run.runnerId}
              label={formatRunElapsed(run.claimedAt, t, run.finishedAt ?? null)}
              live={run.status === 'claimed' || run.status === 'running'}
            />
          )}
          {task.subtasks && task.subtasks.length > 0 && (
            <span className="text-xs text-zinc-400 dark:text-zinc-400">
              ✓ {task.subtasks.filter((s) => s.completed).length}/{task.subtasks.length}
            </span>
          )}
          {/* s-1213: last-activity stamp surfaces in detailed density
              so the triage operator can spot stale cards at a glance. */}
          {isDetailed && lastActivityLabel && (
            <span
              className="text-xs text-zinc-400 dark:text-zinc-500"
              data-testid="task-card-last-activity"
              title={task.updatedAt}
            >
              {t('taskCard.lastActivity', { when: lastActivityLabel })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* s-1202: assign distinct icons to assignee vs last runner so
              the user can no longer mistake a Runner device name for the
              task's real owner. The "Created by" tooltip explicitly
              spells out what the red avatar represents — previously it
              carried no explanation (PM_REVIEW_2026-09-17 §3.2). */}
          {task.assignee && (
            <span
              className="flex items-center gap-1 rounded-full bg-blue-50 dark:bg-blue-900/30 px-2 py-0.5 text-[11px] font-medium text-blue-700 dark:text-blue-300 max-w-[9rem]"
              title={t('taskCard.assigneeBadgeTitle', { name: task.assignee })}
              aria-label={t('taskCard.assigneeBadgeAria', { name: task.assignee })}
              data-testid="task-card-assignee-badge"
            >
              <span aria-hidden className="text-[11px] leading-none">👤</span>
              <span className="truncate">{task.assignee}</span>
            </span>
          )}
          {/* s-1213: detailed density keeps the last-runner chip only
              while the run is actually live. Once the runner settles
              into a terminal status the chip drops out so it stops
              reading as "currently being worked on". */}
          {run && (!isDetailed || isLiveRun) && (
            <span
              className="flex items-center gap-1 rounded-full bg-violet-50 dark:bg-violet-900/30 px-2 py-0.5 text-[11px] font-medium text-violet-700 dark:text-violet-300 max-w-[9rem]"
              title={t('taskCard.lastRunnerBadgeTitle', { runnerId: run.runnerId })}
              aria-label={t('taskCard.lastRunnerBadgeAria', { runnerId: run.runnerId })}
              data-testid="task-card-last-runner-badge"
            >
              <span aria-hidden className="text-[11px] leading-none">🤖</span>
              <span className="truncate font-mono">
                {run.runnerId.length > 14 ? `${run.runnerId.slice(0, 11)}…` : run.runnerId}
              </span>
            </span>
          )}
          {(task.createdByNickname || task.createdByUsername) && (
            <div
              className="flex items-center gap-1.5"
              title={t('taskCard.createdByTooltip', {
                name: task.createdByNickname || task.createdByUsername || '',
              })}
              aria-label={t('taskCard.createdByTooltip', {
                name: task.createdByNickname || task.createdByUsername || '',
              })}
              data-testid="task-card-created-by"
            >
              <UserAvatar
                username={task.createdByNickname || task.createdByUsername || ''}
                avatar={task.createdByAvatar}
                size="sm"
                title={t('taskCard.createdByTooltip', {
                  name: task.createdByNickname || task.createdByUsername || '',
                })}
              />
              <span className="text-xs text-zinc-500 dark:text-zinc-500 truncate max-w-[8rem]">
                {task.createdByNickname || task.createdByUsername}
              </span>
            </div>
          )}
          {((task._count?.comments ?? 0) > 0 || (task.comments && task.comments.length > 0)) && (
            <span
              className="flex items-center gap-1 cursor-pointer text-xs text-zinc-400 dark:text-zinc-500 hover:text-blue-500 transition-colors"
              onClick={(e) => {
                e.stopPropagation();
                if (onCommentsClick) {
                  onCommentsClick();
                } else {
                  onClick();
                }
              }}
              title={t('taskCard.viewComments')}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
              {task._count?.comments ?? task.comments?.length ?? 0}
            </span>
          )}
        </div>
      </div>
      )}
      {confirmDialog.isOpen && (
        <ConfirmDialog
          isOpen={confirmDialog.isOpen}
          title={confirmDialog.title}
          message={confirmDialog.message}
          variant={confirmDialog.variant}
          onConfirm={confirmDialog.onConfirm}
          onCancel={() => setConfirmDialog(prev => ({ ...prev, isOpen: false }))}
        />
      )}
    </div>
  );
}
