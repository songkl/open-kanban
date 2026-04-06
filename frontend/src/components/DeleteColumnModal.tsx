import { useTranslation } from 'react-i18next';

interface DeleteColumnModalProps {
  isOpen: boolean;
  column: { id: string; name: string; taskCount: number } | null;
  onClose: () => void;
  onConfirm: () => void;
}

export function DeleteColumnModal({
  isOpen,
  column,
  onClose,
  onConfirm,
}: DeleteColumnModalProps) {
  const { t } = useTranslation();

  if (!isOpen || !column) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl border border-zinc-100"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-red-500 to-red-600 text-white">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
          </div>
          <h2 className="text-xl font-bold text-zinc-800">{t('modal.deleteColumn')}</h2>
        </div>

        <div className="mb-6">
          <p className="text-zinc-600 mb-3">
            {t('column.confirmDeleteMessage', { columnName: column.name })}
          </p>
          {column.taskCount > 0 && (
            <div className="p-3 bg-red-50 border border-red-100 rounded-xl">
              <p className="text-sm text-red-600">
                <span className="font-semibold">{column.taskCount}</span> {t('column.tasksWillBeDeleted')}
              </p>
            </div>
          )}
        </div>

        <div className="mt-8 flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 rounded-xl bg-zinc-100 px-4 py-3 font-medium text-zinc-600 hover:bg-zinc-200 transition-colors"
          >
            {t('column.cancel')}
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 rounded-xl bg-gradient-to-r from-red-500 to-red-600 px-4 py-3 font-medium text-white hover:from-red-600 hover:to-red-700 transition-all shadow-sm hover:shadow"
          >
            {t('column.delete')}
          </button>
        </div>
      </div>
    </div>
  );
}
