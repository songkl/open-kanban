import { useTranslation } from 'react-i18next';
import type { Column, ColumnPermission } from '@/types/kanban';
import { ColumnPermissionsModal } from './ColumnPermissionsModal';

interface BoardColumnPermissionsModalProps {
  isOpen: boolean;
  columns: Column[];
  loading: boolean;
  selectedColumn: Column | null;
  permissions: ColumnPermission[];
  permissionLoading: boolean;
  onSelectColumn: (column: Column) => void;
  onClose: () => void;
  onBack: () => void;
  onDeletePermission: (permissionId: string) => void;
  onPermissionAdded: () => void;
}

export function BoardColumnPermissionsModal({
  isOpen,
  columns,
  loading,
  selectedColumn,
  permissions,
  permissionLoading,
  onSelectColumn,
  onClose,
  onBack,
  onDeletePermission,
  onPermissionAdded,
}: BoardColumnPermissionsModalProps) {
  const { t } = useTranslation();

  if (!isOpen) return null;

  if (selectedColumn) {
    return (
      <ColumnPermissionsModal
        isOpen={isOpen}
        column={selectedColumn}
        permissions={permissions}
        loading={permissionLoading}
        onClose={onClose}
        onDeletePermission={onDeletePermission}
        onPermissionAdded={onPermissionAdded}
      />
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl bg-white dark:bg-zinc-800 p-6 shadow border border-zinc-100 dark:border-zinc-700 max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 text-white">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
              <line x1="9" y1="3" x2="9" y2="21"/>
              <line x1="15" y1="3" x2="15" y2="21"/>
            </svg>
          </div>
          <div>
            <h2 className="text-xl font-bold text-zinc-800 dark:text-zinc-100">{t('board.columnPermissions')}</h2>
            <p className="text-sm text-zinc-500 dark:text-zinc-500">{t('board.columnPermissionsHint')}</p>
          </div>
        </div>

        {loading ? (
          <div className="py-8 text-center text-zinc-500 dark:text-zinc-500">{t('common.loading')}</div>
        ) : columns.length === 0 ? (
          <p className="py-6 text-center text-sm text-zinc-400 dark:text-zinc-500">{t('column.noColumns')}</p>
        ) : (
          <div className="space-y-2">
            {columns.map((column) => (
              <button
                key={column.id}
                onClick={() => onSelectColumn(column)}
                className="flex w-full items-center justify-between rounded-xl border border-zinc-100 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-700 px-3 py-2 text-left hover:bg-zinc-100 dark:hover:bg-zinc-600 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div
                    className="h-5 w-5 rounded-full shadow-sm"
                    style={{ backgroundColor: column.color }}
                  />
                  <span className="text-sm font-medium text-zinc-800 dark:text-zinc-100">{column.name}</span>
                </div>
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="text-zinc-400"
                >
                  <polyline points="9 18 15 12 9 6"/>
                </svg>
              </button>
            ))}
          </div>
        )}

        <div className="mt-6 flex justify-between">
          <button
            onClick={onBack}
            className="rounded-xl bg-zinc-100 dark:bg-zinc-700 px-4 py-2 text-sm font-medium text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-600 transition-colors"
          >
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
