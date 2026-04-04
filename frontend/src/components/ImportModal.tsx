import { useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';

interface ImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImport: (data: { data: unknown; boardId?: string }, withReset: boolean) => Promise<void>;
}

export function ImportModal({ isOpen, onClose, onImport }: ImportModalProps) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importBoardId, setImportBoardId] = useState('');
  const [pendingImportData, setPendingImportData] = useState<{ data: unknown; boardId?: string } | null>(null);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setImportFile(file);
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        if (data.boardId) {
          setImportBoardId(data.boardId);
        }
      } catch (error) {
        console.error('Failed to parse JSON file:', error);
      }
    }
  };

  const handleImport = async (withReset = false) => {
    if (!importFile && !pendingImportData) return;

    try {
      let data: unknown;
      let boardId: string | undefined;
      if (pendingImportData) {
        data = pendingImportData.data;
        boardId = pendingImportData.boardId;
      } else {
        const text = await importFile!.text();
        data = JSON.parse(text);
        boardId = importBoardId || undefined;
      }
      await onImport({ data, boardId }, withReset);
      handleClose();
    } catch (error) {
      console.error('Import failed:', error);
    }
  };

  const handleClose = () => {
    setImportFile(null);
    setImportBoardId('');
    setPendingImportData(null);
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
        className="relative z-10 w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl border border-zinc-100"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-sky-500 to-sky-600 text-white shadow-lg shadow-sky-500/30">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>
            </svg>
          </div>
          <h2 className="text-xl font-bold text-zinc-800">
            {t('modal.importBoard')}
          </h2>
        </div>

        <div className="space-y-5">
          <div>
            <label className="mb-2 block text-sm font-semibold text-zinc-700">
              {t('modal.selectFile')}
            </label>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              onChange={handleFileChange}
              className="w-full rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-800 transition-all focus:border-blue-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 file:mr-4 file:py-1 file:px-3 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-blue-50 file:text-blue-600 hover:file:bg-blue-100"
            />
            <p className="mt-1.5 text-xs text-zinc-400">
              {t('modal.importHint')}
            </p>
          </div>

          <div>
            <label className="mb-2 block text-sm font-semibold text-zinc-700">
              {t('modal.boardId')}({t('modal.optional')})
            </label>
            <input
              type="text"
              value={importBoardId}
              onChange={(e) => setImportBoardId(e.target.value.replace(/\//g, ''))}
              placeholder={t('modal.autoGenerate')}
              className="w-full rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-zinc-800 placeholder-zinc-400 transition-all focus:border-blue-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            />
            <p className="mt-1.5 text-xs text-zinc-400">
              {t('modal.boardIdHint')}
            </p>
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={handleClose}
              className="flex-1 rounded-xl bg-zinc-100 px-4 py-3 font-medium text-zinc-600 hover:bg-zinc-200 transition-colors"
            >
              {t('task.cancel')}
            </button>
            <button
              type="button"
              onClick={() => handleImport(false)}
              disabled={!importFile}
              className={`flex-1 rounded-xl px-4 py-3 font-medium transition-all shadow-sm hover:shadow ${!importFile ? 'bg-gradient-to-r from-zinc-300 to-zinc-300 text-zinc-400' : 'bg-gradient-to-r from-sky-500 to-sky-600 text-white hover:from-sky-600 hover:to-sky-700'}`}
            >
              {t('task.import')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface ImportConflictConfirmProps {
  isOpen: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ImportConflictConfirm({ isOpen, onCancel, onConfirm }: ImportConflictConfirmProps) {
  const { t } = useTranslation();

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div className="absolute inset-0" />
      <div
        className="relative z-10 w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl border border-zinc-100"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-amber-500 to-orange-500 text-white shadow-lg">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
          </div>
          <h3 className="text-lg font-bold text-zinc-800">
            {t('modal.importConflictTitle')}
          </h3>
        </div>
        <p className="mb-6 text-sm text-zinc-600">
          {t('modal.importConflictMessage')}
        </p>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-xl bg-zinc-100 px-4 py-3 font-medium text-zinc-600 hover:bg-zinc-200 transition-colors"
          >
            {t('task.cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="flex-1 rounded-xl bg-gradient-to-r from-red-500 to-red-600 px-4 py-3 font-medium text-white hover:from-red-600 hover:to-red-700 transition-all shadow-sm hover:shadow"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
