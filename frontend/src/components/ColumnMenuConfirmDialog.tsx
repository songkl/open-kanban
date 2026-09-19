import { useTranslation } from 'react-i18next';
import { useFocusTrap } from '../hooks/useFocusTrap';

export type ColumnBulkAction = 'archive' | 'complete' | 'exportCsv';

interface ColumnMenuConfirmDialogProps {
  isOpen: boolean;
  action: ColumnBulkAction | null;
  columnName: string;
  affectedTasks: Array<{ id: string; title: string }>;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * s-1212 — confirmation dialog for the column-header ⋯ menu.
 *
 * The dialog doubles as the affected-task preview that the task
 * description called out ("Confirm modal that lists the affected
 * tasks before committing"). We render up to 50 task titles and
 * a "+N more" suffix when the column is over the preview
 * threshold so the dialog stays usable on real boards (some
 * columns hold hundreds of tasks).
 */
export function ColumnMenuConfirmDialog({
  isOpen,
  action,
  columnName,
  affectedTasks,
  onConfirm,
  onCancel,
}: ColumnMenuConfirmDialogProps) {
  const { t } = useTranslation();

  const dialogRef = useFocusTrap<HTMLDivElement>({
    enabled: isOpen,
    initialFocus: 'first',
    onEscape: onCancel,
    restoreFocus: true,
  });

  if (!isOpen || !action) return null;

  const count = affectedTasks.length;
  const previewLimit = 50;
  const previewTasks = affectedTasks.slice(0, previewLimit);
  const remainingCount = Math.max(0, count - previewLimit);

  const title = t(`column.bulkConfirm.${action}Title`, { columnName });
  const message = t(`column.bulkConfirm.${action}Message`, { count });
  const variant: 'warning' | 'default' =
    action === 'archive' ? 'warning' : 'default';

  const titleId = 'column-bulk-confirm-title';
  const descId = 'column-bulk-confirm-desc';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div className="absolute inset-0" />
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="relative z-10 w-full max-w-md rounded-2xl bg-white dark:bg-zinc-800 border border-zinc-100 outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center gap-3">
          <div
            aria-hidden="true"
            className={`flex h-10 w-10 items-center justify-center rounded-xl text-white shadow-lg ${
              variant === 'warning'
                ? 'bg-gradient-to-br from-amber-500 to-orange-500'
                : 'bg-gradient-to-br from-blue-500 to-blue-600'
            }`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>
          <h3 id={titleId} className="text-lg font-bold text-zinc-800 dark:text-zinc-100">
            {title}
          </h3>
        </div>
        <p id={descId} className="mb-4 text-sm text-zinc-600 dark:text-zinc-300">
          {message}
        </p>
        {action !== 'exportCsv' && previewTasks.length > 0 && (
          <div className="mb-4 max-h-48 overflow-y-auto rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900/40 p-3">
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              {t('column.bulkConfirm.affected')}
            </div>
            <ul className="space-y-1 text-sm text-zinc-700 dark:text-zinc-300">
              {previewTasks.map((task) => (
                <li key={task.id} className="truncate" title={task.title}>
                  • {task.title}
                </li>
              ))}
              {remainingCount > 0 && (
                <li className="text-zinc-500 dark:text-zinc-500">
                  + {remainingCount} {t('bulkConfirm.affected', 'more')}
                </li>
              )}
            </ul>
          </div>
        )}
        <div className="flex gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-xl bg-zinc-100 dark:bg-zinc-700 px-4 py-3 font-medium text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-600 transition-colors"
          >
            {t('column.bulkConfirm.cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`flex-1 rounded-xl px-4 py-3 font-medium text-white transition-all shadow-sm hover:shadow ${
              variant === 'warning'
                ? 'bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600'
                : 'bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700'
            }`}
            data-testid={`column-bulk-confirm-${action}`}
          >
            {t('column.bulkConfirm.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
