import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Column } from '@/types/kanban';
import { useTranslation } from 'react-i18next';

interface ColumnCardProps {
  column: Column;
  onEdit: (column: Column) => void;
  onDelete: (columnId: string) => void;
  onPermission: (column: Column) => void;
  canEdit?: boolean;
  canDelete?: boolean;
  canManagePermission?: boolean;
}

export function ColumnCard({
  column,
  onEdit,
  onDelete,
  onPermission,
  canEdit,
  canDelete,
  canManagePermission,
}: ColumnCardProps) {
  const { t } = useTranslation();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: column.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="group flex items-center gap-4 rounded-xl bg-white p-4 shadow-sm border border-zinc-100 hover:shadow-md hover:border-zinc-200 transition-all duration-200"
    >
      <button
        {...attributes}
        {...listeners}
        className="cursor-grab text-zinc-300 hover:text-zinc-500 active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity"
        title={t('column.dragToSort')}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-5 w-5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 8h16M4 16h16"
          />
        </svg>
      </button>
      <div
        className="h-6 w-6 rounded-full shadow-sm"
        style={{ backgroundColor: column.color }}
      />
      <span className="flex-1 font-semibold text-zinc-800">{column.name}</span>
      {column.status && (
        <span className="rounded-full bg-zinc-50 px-3 py-1 text-xs font-medium text-zinc-500 border border-zinc-100">
          {column.status}
        </span>
      )}
      <span className="text-xs text-zinc-400 font-mono">#{column.position + 1}</span>
      <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
        {canManagePermission && (
          <button
            onClick={() => onPermission(column)}
            className="rounded-lg bg-violet-50 px-3 py-1.5 text-sm font-medium text-violet-600 hover:bg-violet-100 transition-colors"
          >
            {t('column.permissions')}
          </button>
        )}
        {canEdit && (
          <button
            onClick={() => onEdit(column)}
            className="rounded-lg bg-blue-50 px-3 py-1.5 text-sm font-medium text-blue-600 hover:bg-blue-100 transition-colors"
          >
            {t('column.edit')}
          </button>
        )}
        {canDelete && (
          <button
            onClick={() => onDelete(column.id)}
            className="rounded-lg bg-red-50 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-100 transition-colors"
          >
            {t('column.delete')}
          </button>
        )}
      </div>
    </div>
  );
}
