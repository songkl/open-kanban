import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useFocusTrap } from '@/hooks/useFocusTrap';

interface AddSubtaskModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (title: string) => void;
}

export function AddSubtaskModal({
  isOpen,
  onClose,
  onSubmit,
}: AddSubtaskModalProps) {
  const { t } = useTranslation();
  const [title, setTitle] = useState('');

  const handleClose = useCallback(() => {
    setTitle('');
    onClose();
  }, [onClose]);

  const dialogRef = useFocusTrap<HTMLDivElement>({
    enabled: isOpen,
    initialFocus: 'first',
    onEscape: handleClose,
    restoreFocus: true,
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (title.trim()) {
      onSubmit(title.trim());
      setTitle('');
      handleClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-subtask-modal-title"
        className="relative z-10 w-full max-w-md rounded-xl bg-white dark:bg-zinc-800 outline-none p-6"
      >
        <h2 id="add-subtask-modal-title" className="mb-4 text-lg font-semibold text-zinc-800 dark:text-zinc-100">{t('subtask.add')}</h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="add-subtask-title" className="sr-only">{t('subtask.titlePlaceholder')}</label>
            <input
              id="add-subtask-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('subtask.titlePlaceholder')}
              aria-label={t('subtask.titlePlaceholder')}
              aria-required="true"
              className="w-full rounded-md border border-zinc-200 dark:border-zinc-700 px-4 py-3 text-base focus:border-blue-500 focus:outline-none"
            />
          </div>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={handleClose}
              className="flex-1 rounded-md bg-zinc-100 dark:bg-zinc-700 px-4 py-2.5 text-base font-medium text-zinc-700 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-600"
            >
              {t('subtask.cancel')}
            </button>
            <button
              type="submit"
              disabled={!title.trim()}
              className="flex-1 rounded-md bg-blue-500 px-4 py-2.5 text-base font-medium text-white hover:bg-blue-600 disabled:bg-zinc-300"
            >
              {t('subtask.add')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
