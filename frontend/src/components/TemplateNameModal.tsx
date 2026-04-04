import { useState } from 'react';
import { useTranslation } from 'react-i18next';

interface TemplateNameModalProps {
  isOpen: boolean;
  boardId: string;
  boardName: string;
  onClose: () => void;
  onSubmit: (templateName: string) => Promise<void>;
}

export function TemplateNameModal({
  isOpen,
  boardName: initialBoardName,
  onClose,
  onSubmit,
}: TemplateNameModalProps) {
  const { t } = useTranslation();
  const [templateName, setTemplateName] = useState(initialBoardName);

  const handleSubmit = async () => {
    if (!templateName.trim()) return;
    await onSubmit(templateName.trim());
    handleClose();
  };

  const handleClose = () => {
    setTemplateName('');
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={handleClose}
    >
      <div className="absolute inset-0" />
      <div
        className="relative z-10 w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl border border-zinc-100"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-orange-500 to-orange-600 text-white shadow-lg">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>
            </svg>
          </div>
          <h3 className="text-lg font-bold text-zinc-800">
            {t('modal.saveAsTemplate')}
          </h3>
        </div>
        <p className="mb-4 text-sm text-zinc-600">
          {t('modal.templateNameHint', { boardName: initialBoardName })}
        </p>
        <div className="mb-6">
          <label className="mb-2 block text-sm font-semibold text-zinc-700">
            {t('modal.templateName')}
          </label>
          <input
            type="text"
            value={templateName}
            onChange={(e) => setTemplateName(e.target.value)}
            placeholder={t('modal.enterTemplateName')}
            className="w-full rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-zinc-800 placeholder-zinc-400 transition-all focus:border-blue-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            autoFocus
          />
        </div>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={handleClose}
            className="flex-1 rounded-xl bg-zinc-100 px-4 py-3 font-medium text-zinc-600 hover:bg-zinc-200 transition-colors"
          >
            {t('task.cancel')}
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!templateName.trim()}
            className={`flex-1 rounded-xl px-4 py-3 font-medium transition-all shadow-sm hover:shadow ${!templateName.trim() ? 'bg-gradient-to-r from-zinc-300 to-zinc-300 text-zinc-400' : 'bg-gradient-to-r from-orange-500 to-orange-600 text-white hover:from-orange-600 hover:to-orange-700'}`}
          >
            {t('task.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
