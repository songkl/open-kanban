import { useState, useEffect, useCallback, startTransition } from 'react';
import { useTranslation } from 'react-i18next';

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

  const resetForm = useCallback(() => {
    startTransition(() => {
      setTitle('');
    });
  }, []);

  useEffect(() => {
    if (isOpen) {
      void resetForm();
    }
  }, [isOpen, resetForm]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (title.trim()) {
      onSubmit(title.trim());
      setTitle('');
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" />

      <div className="relative z-10 w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
        <h2 className="mb-4 text-lg font-semibold text-zinc-800">{t('subtask.add')}</h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('subtask.titlePlaceholder')}
              className="w-full rounded-md border border-zinc-200 px-4 py-3 text-base focus:border-blue-500 focus:outline-none"
              autoFocus
            />
          </div>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-md bg-zinc-100 px-4 py-2.5 text-base font-medium text-zinc-700 hover:bg-zinc-200"
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