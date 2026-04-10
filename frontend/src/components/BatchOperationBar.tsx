import { useTranslation } from 'react-i18next';
import type { Column as ColumnType } from '../types/kanban';
import { CustomDropdown } from './CustomDropdown';

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

  const priorityOptions = [
    { value: 'high', label: t('task.priority.high') },
    { value: 'medium', label: t('task.priority.medium') },
    { value: 'low', label: t('task.priority.low') },
  ];

  const assigneeOptions = [
    { value: '', label: t('task.clearAssignee') },
    ...uniqueAssignees.map(a => ({ value: a, label: a })),
  ];

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-xl bg-zinc-800 dark:bg-zinc-700 px-4 py-3 shadow-2xl ring-1 ring-zinc-200/20 dark:ring-zinc-600/50">
      <span className="text-sm text-zinc-200 dark:text-zinc-200 font-medium">
        {t('task.selectedCount', { count: selectedTasks.size })}
      </span>
      <div className="h-4 w-px bg-zinc-600" />
      <CustomDropdown
        options={columns.map(col => ({ value: col.id, label: col.name }))}
        value=""
        onChange={(val) => { if (val) onBatchMove(val); }}
        placeholder={t('task.moveToColumn')}
        className="w-36"
      />
      <CustomDropdown
        options={priorityOptions}
        value=""
        onChange={(val) => { if (val) onBatchUpdatePriority(val); }}
        placeholder={t('task.setPriority')}
        className="w-32"
      />
      <CustomDropdown
        options={assigneeOptions}
        value=""
        onChange={onBatchUpdateAssignee}
        placeholder={t('task.setAssignee')}
        className="w-32"
      />
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