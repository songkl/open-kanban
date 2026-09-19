import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { publicBoardApi, type PublicBoard, type PublicColumn, type PublicTask } from '../services/api';

function PublicTaskCard({ task }: { task: PublicTask }) {
  const priorityColor = {
    low: 'border-zinc-300 dark:border-zinc-600',
    medium: 'border-blue-300 dark:border-blue-500',
    high: 'border-red-400 dark:border-red-500',
  }[task.priority] ?? 'border-zinc-300 dark:border-zinc-600';

  return (
    <div
      className={`rounded-lg border ${priorityColor} bg-white dark:bg-zinc-800 p-3 shadow-sm`}
      data-testid="public-task-card"
    >
      <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{task.title}</div>
      {task.description && (
        <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400 whitespace-pre-wrap break-words line-clamp-3">
          {task.description}
        </p>
      )}
      <div className="mt-2 flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
        <span className="inline-flex items-center rounded-full bg-zinc-100 dark:bg-zinc-700 px-2 py-0.5">
          {task.priority}
        </span>
        {task.assignee && (
          <span className="inline-flex items-center rounded-full bg-zinc-100 dark:bg-zinc-700 px-2 py-0.5">
            @{task.assignee}
          </span>
        )}
        {(task._count.comments > 0 || task._count.subtasks > 0) && (
          <span className="ml-auto text-zinc-400 dark:text-zinc-500">
            {task._count.comments > 0 && (
              <span className="mr-2" title="comments">💬 {task._count.comments}</span>
            )}
            {task._count.subtasks > 0 && (
              <span title="subtasks">☑ {task._count.subtasks}</span>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

function PublicColumnView({ column }: { column: PublicColumn }) {
  return (
    <div className="flex h-full w-72 shrink-0 flex-col rounded-xl bg-zinc-100/70 dark:bg-zinc-900/70 p-3">
      <div className="mb-3 flex items-center gap-2">
        <span
          className="inline-block h-2.5 w-2.5 rounded-full"
          style={{ backgroundColor: column.color }}
        />
        <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">{column.name}</h2>
        <span className="ml-auto text-xs text-zinc-500 dark:text-zinc-400">{column.tasks.length}</span>
      </div>
      {column.description && (
        <p className="mb-2 text-xs text-zinc-500 dark:text-zinc-400 whitespace-pre-wrap break-words">
          {column.description}
        </p>
      )}
      <div className="flex flex-col gap-2 overflow-y-auto" data-testid="public-column">
        {column.tasks.map((task) => (
          <PublicTaskCard key={task.id} task={task} />
        ))}
        {column.tasks.length === 0 && (
          <div className="rounded border border-dashed border-zinc-300 dark:border-zinc-700 p-4 text-center text-xs text-zinc-400 dark:text-zinc-500">
            (empty)
          </div>
        )}
      </div>
    </div>
  );
}

export function PublicBoardPage() {
  const { t } = useTranslation();
  const { token } = useParams<{ token: string }>();
  const [board, setBoard] = useState<PublicBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setError(t('publicBoard.missingToken', 'Missing share token'));
      setLoading(false);
      return;
    }
    setLoading(true);
    publicBoardApi
      .get(token)
      .then((data) => {
        if (cancelled) return;
        setBoard(data);
        setError(null);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setBoard(null);
        setError(err.message || t('publicBoard.notFound', 'Board not found'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // t is intentionally omitted: depending on it would re-run
    // the effect on every render because react-i18next returns a
    // fresh function identity each call. The token alone is the
    // correct dependency — token changes only when the route does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950" data-testid="public-board-page">
      <header className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-6 py-4">
        <div className="flex items-center gap-3">
          <Link
            to="/"
            className="text-sm text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
          >
            {t('publicBoard.openKanban', 'Open Kanban')}
          </Link>
          {board && (
            <div className="ml-auto flex items-center gap-2">
              <span className="inline-flex items-center rounded-full bg-amber-100 dark:bg-amber-900/40 px-2 py-0.5 text-xs font-medium text-amber-800 dark:text-amber-200">
                {t('publicBoard.readOnly', 'Read-only')}
              </span>
              <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{board.name}</h1>
            </div>
          )}
        </div>
        {board?.description && (
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400 whitespace-pre-wrap">
            {board.description}
          </p>
        )}
      </header>

      <main className="p-6">
        {loading && (
          <div className="flex h-64 items-center justify-center text-sm text-zinc-500 dark:text-zinc-400">
            {t('publicBoard.loading', 'Loading…')}
          </div>
        )}
        {error && (
          <div className="flex h-64 flex-col items-center justify-center gap-2 text-center">
            <div className="text-base font-medium text-zinc-700 dark:text-zinc-300">
              {t('publicBoard.notFound', 'Board not found')}
            </div>
            <div className="max-w-md text-sm text-zinc-500 dark:text-zinc-400">
              {t(
                'publicBoard.notFoundHint',
                'The share link may have been revoked, expired, or the board may have been deleted.'
              )}
            </div>
          </div>
        )}
        {board && (
          <div className="flex gap-4 overflow-x-auto pb-4" data-testid="public-board-columns">
            {board.columns.map((column) => (
              <PublicColumnView key={column.id} column={column} />
            ))}
            {board.columns.length === 0 && (
              <div className="flex h-64 flex-1 items-center justify-center text-sm text-zinc-500 dark:text-zinc-400">
                {t('publicBoard.noColumns', 'No columns to show.')}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}