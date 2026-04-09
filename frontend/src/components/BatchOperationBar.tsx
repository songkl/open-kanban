import { useTranslation } from 'react-i18next';
import type { Column as ColumnType } from '../types/kanban';

interface BatchOperationBarProps {
  selectedTasks: Set<string>;
  columns: ColumnType[];
  uniqueAssignees: string[];
  onBatchMove: (targetColumnId: string) => void;
  onBatchUpdatePriority: (priority: string) => void;
  onBatchUpdateAssignee: (assignee: string) => void;
  onBatchArchive: () => void;
  onBatchDelete: () => void;
  onClearSelection: () => void;
}

export function BatchOperationBar({
  selectedTasks,
  columns,
  uniqueAssignees,
  onBatchMove,
  onBatchUpdatePriority,
  onBatchUpdateAssignee,
  onBatchArchive,
  onBatchDelete,
  onClearSelection,
}: BatchOperationBarProps) {
  const { t } = useTranslation();

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-xl bg-zinc-800 dark:bg-zinc-700 px-4 py-3 shadow-2xl ring-1 ring-zinc-200/20 dark:ring-zinc-600/50">
      <span className="text-sm text-zinc-200 dark:text-zinc-200 font-medium">
        {t('task.selectedCount', { count: selectedTasks.size })}
      </span>
      <div className="h-4 w-px bg-zinc-600" />
      <label htmlFor="batch-move" className="sr-only">{t('task.moveToColumn')}</label>
      <select
        id="batch-move"
        onChange={(e) => {
          if (e.target.value) onBatchMove(e.target.value);
          e.target.value = '';
        }}
        className="rounded-md bg-zinc-700 border border-zinc-600 px-2 py-1 text-sm text-zinc-200"
      >
        <option value="">{t('task.moveToColumn')}</option>
        {columns.map((col) => (
          <option key={col.id} value={col.id}>
            {col.name}
          </option>
        ))}
      </select>
      <label htmlFor="batch-priority" className="sr-only">{t('task.setPriority')}</label>
      <select
        id="batch-priority"
        onChange={(e) => {
          if (e.target.value) onBatchUpdatePriority(e.target.value);
          e.target.value = '';
        }}
        className="rounded-md bg-zinc-700 border border-zinc-600 px-2 py-1 text-sm text-zinc-200"
      >
        <option value="">{t('task.setPriority')}</option>
        <option value="high">{t('task.priority.high')}</option>
        <option value="medium">{t('task.priority.medium')}</option>
        <option value="low">{t('task.priority.low')}</option>
      </select>
      <label htmlFor="batch-assignee" className="sr-only">{t('task.setAssignee')}</label>
      <select
        id="batch-assignee"
        onChange={(e) => {
          onBatchUpdateAssignee(e.target.value);
          e.target.value = '';
        }}
        className="rounded-md bg-zinc-700 border border-zinc-600 px-2 py-1 text-sm text-zinc-200"
      >
        <option value="">{t('task.setAssignee')}</option>
        <option value="">{t('task.clearAssignee')}</option>
        {uniqueAssignees.map((a) => (
          <option key={a} value={a}>
            {a}
          </option>
        ))}
      </select>
      <div className="h-4 w-px bg-zinc-600" />
      <button
        onClick={onBatchArchive}
        className="rounded-md bg-orange-600 hover:bg-orange-500 px-3 py-1 text-sm text-white font-medium transition-colors"
      >
        {t('task.archive')}
      </button>
      <button
        onClick={onBatchDelete}
        className="rounded-md bg-red-600 hover:bg-red-500 px-3 py-1 text-sm text-white font-medium transition-colors"
      >
        {t('task.delete')}
      </button>
      <button
        onClick={onClearSelection}
        className="rounded-md bg-zinc-600 hover:bg-zinc-500 px-3 py-1 text-sm text-white font-medium transition-colors"
      >
        {t('task.clearSelection')}
      </button>
    </div>
  );
}