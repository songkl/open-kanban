import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { boardsApi, templatesApi } from '../services/api';
import { ErrorToastContainer } from '../components/ErrorToast';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { BoardCard } from '../components/BoardCard';
import { CreateBoardModal } from '../components/CreateBoardModal';
import { ImportModal, ImportConflictConfirm } from '../components/ImportModal';
import { TemplateNameModal } from '../components/TemplateNameModal';

import type { Board } from '../types/kanban';

interface Template {
  id: string;
  name: string;
  boardId?: string;
  columnsConfig: string;
  includeTasks: boolean;
  createdAt: string;
}

export function BoardsPage() {
  const { t } = useTranslation();
  const [boards, setBoards] = useState<Board[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [editingBoard, setEditingBoard] = useState<Board | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [showImportConflictConfirm, setShowImportConflictConfirm] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingImportData, setPendingImportData] = useState<{ data: unknown; boardId?: string } | null>(null);

  const [confirmDialog, setConfirmDialog] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
    variant?: 'danger' | 'warning' | 'default';
  }>({ isOpen: false, title: '', message: '', onConfirm: () => {} });

  const [templateNameModal, setTemplateNameModal] = useState<{
    isOpen: boolean;
    boardId: string;
    boardName: string;
  }>({ isOpen: false, boardId: '', boardName: '' });

  useEffect(() => {
    fetchBoards();
    fetchTemplates();
  }, []);

  const fetchTemplates = async () => {
    try {
      const data = await templatesApi.getAll();
      setTemplates(data || []);
    } catch (error) {
      console.error('Failed to fetch templates:', error);
    }
  };

  const fetchBoards = async () => {
    try {
      setLoadError(null);
      const data = await boardsApi.getAll();
      setBoards(data || []);
    } catch (error: any) {
      console.error('Failed to fetch boards:', error);
      setLoadError(error?.message || t('app.error.loadFailed'));
    }
  };

  const showToastMessage = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 2000);
  };

  const handleBoardSubmit = async (data: {
    name: string;
    description?: string;
    boardId?: string;
    templateId?: string;
  }) => {
    try {
      if (editingBoard) {
        await boardsApi.update(editingBoard.id, { name: data.name, description: data.description });
        showToastMessage(t('toast.boardUpdated'));
      } else {
        if (data.templateId) {
          await boardsApi.createFromTemplate({
            name: data.name,
            templateId: data.templateId,
            boardId: data.boardId,
          });
        } else {
          await boardsApi.create({
            name: data.name,
            id: data.boardId,
          });
        }
        showToastMessage(t('toast.boardCreated'));
      }
      fetchBoards();
      closeModal();
    } catch (error) {
      console.error('Failed to save board:', error);
      showToastMessage(t('toast.saveFailed'));
    }
  };

  const handleDelete = async (id: string, name: string) => {
    setConfirmDialog({
      isOpen: true,
      title: t('confirm.deleteBoardTitle') || t('modal.deleteConfirmTitle', { name }),
      message: t('confirm.deleteBoard', { name }),
      variant: 'danger',
      onConfirm: async () => {
        try {
          await boardsApi.delete(id);
          showToastMessage(t('toast.boardDeleted'));
          fetchBoards();
        } catch (error) {
          console.error('Failed to delete board:', error);
          showToastMessage(t('toast.deleteFailed'));
        }
        setConfirmDialog((prev) => ({ ...prev, isOpen: false }));
      },
    });
  };

  const openAddModal = () => {
    setEditingBoard(null);
    setShowModal(true);
  };

  const openEditModal = (board: Board) => {
    setEditingBoard(board);
    setShowModal(true);
  };

  const closeModal = () => {
    setShowModal(false);
    setEditingBoard(null);
  };

  const handleCopyBoard = async (boardId: string, _boardName: string) => {
    try {
      await boardsApi.copy(boardId);
      showToastMessage(t('toast.boardCopied'));
      fetchBoards();
    } catch (error) {
      console.error('Failed to copy board:', error);
      showToastMessage(t('toast.copyFailed'));
    }
  };

  const handleSaveAsTemplate = (boardId: string, boardName: string) => {
    setTemplateNameModal({ isOpen: true, boardId, boardName });
  };

  const handleTemplateNameSubmit = async (templateName: string) => {
    if (!templateName.trim() || !templateNameModal.boardId) return;

    try {
      await templatesApi.create({
        name: templateName.trim(),
        boardId: templateNameModal.boardId,
        includeTasks: false,
      });
      showToastMessage(t('toast.templateSaved'));
      fetchTemplates();
    } catch (error) {
      console.error('Failed to save template:', error);
      showToastMessage(t('toast.saveFailed'));
    }
    setTemplateNameModal({ isOpen: false, boardId: '', boardName: '' });
  };

  const handleDeleteTemplate = (templateId: string) => {
    setConfirmDialog({
      isOpen: true,
      title: t('confirm.deleteTemplateTitle') || t('modal.deleteConfirmTitle', { name: '' }),
      message: t('confirm.deleteTemplate'),
      variant: 'danger',
      onConfirm: async () => {
        try {
          await templatesApi.delete(templateId);
          showToastMessage(t('toast.templateDeleted'));
          fetchTemplates();
        } catch (error) {
          console.error('Failed to delete template:', error);
          showToastMessage(t('toast.deleteFailed'));
        }
        setConfirmDialog((prev) => ({ ...prev, isOpen: false }));
      },
    });
  };

  const openImportModal = () => {
    setShowImportModal(true);
  };

  const closeImportModal = () => {
    setShowImportModal(false);
    setShowImportConflictConfirm(false);
    setPendingImportData(null);
  };

  const handleImport = async (importData: { data: unknown; boardId?: string }, withReset: boolean) => {
    try {
      await boardsApi.import({ data: importData.data as Record<string, unknown>, boardId: importData.boardId, reset: withReset });
      showToastMessage(t('toast.importSuccess'));
      closeImportModal();
      fetchBoards();
    } catch (error: any) {
      console.error('Import failed:', error);
      if (error?.response?.status === 409) {
        if (!pendingImportData && importData.data) {
          setPendingImportData(importData);
        }
        setShowImportConflictConfirm(true);
      } else {
        showToastMessage(t('toast.importFailed'));
      }
    }
  };

  const handleImportConflictConfirm = async () => {
    setShowImportConflictConfirm(false);
    if (pendingImportData) {
      try {
        await boardsApi.import({ data: pendingImportData.data as Record<string, unknown>, boardId: pendingImportData.boardId, reset: true });
        showToastMessage(t('toast.importSuccess'));
        closeImportModal();
        fetchBoards();
      } catch (error) {
        showToastMessage(t('toast.importFailed'));
      }
      setPendingImportData(null);
    } else {
      showToastMessage(t('toast.importFailed'));
    }
  };

  const handleExport = async (boardId: string, boardName: string, format: 'json' | 'csv') => {
    try {
      const response = await boardsApi.export(boardId, format);
      if (!response.ok) {
        throw new Error('Export failed');
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      a.download = `${boardName}_${timestamp}.${format}`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      showToastMessage(t('toast.exportSuccess'));
    } catch (error) {
      console.error('Export failed:', error);
      showToastMessage(t('toast.exportFailed'));
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-zinc-100 to-zinc-50 p-6">
      <div className="mx-auto max-w-7xl">
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-blue-600 text-white shadow-lg shadow-blue-500/30">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
              </svg>
            </div>
            <div>
              <h1 className="text-2xl font-bold text-zinc-800">{t('nav.boardManagement')}</h1>
              <p className="text-sm text-zinc-500">{t('board.count', { count: boards.length })}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Link
              to="/columns"
              className="flex items-center gap-2 rounded-xl bg-white px-4 py-2.5 text-sm font-medium text-zinc-600 shadow-sm border border-zinc-100 hover:bg-zinc-50 hover:border-zinc-200 transition-all"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="5" height="18"/><rect x="10" y="3" width="5" height="18"/><rect x="17" y="3" width="5" height="18"/>
              </svg>
              {t('nav.columnManagement')}
            </Link>
            <button
              onClick={openAddModal}
              className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-blue-500 to-blue-600 px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-blue-500/30 hover:from-blue-600 hover:to-blue-700 transition-all"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14M5 12h14"/>
              </svg>
              {t('modal.newBoard')}
            </button>
          </div>
        </div>

        {loadError ? (
          <div className="rounded-2xl bg-white p-8 text-center shadow-sm border border-zinc-100">
            <div className="mb-6 flex h-20 w-20 mx-auto items-center justify-center rounded-full bg-red-50 text-red-500">
              <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
            </div>
            <p className="text-lg font-semibold text-zinc-800">{t('app.error.loadFailed')}</p>
            <p className="text-sm text-zinc-400 mt-1 mb-6">{loadError}</p>
            <div className="flex flex-col gap-3 items-center">
              <p className="text-sm text-zinc-500">{t('board.noAccessHint')}</p>
              <div className="flex gap-3">
                <button
                  onClick={() => setShowModal(true)}
                  className="rounded-xl bg-gradient-to-r from-blue-500 to-blue-600 px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-blue-500/30 hover:from-blue-600 hover:to-blue-700 transition-all"
                >
                  {t('board.createNew')}
                </button>
                <button
                  onClick={() => window.location.href = '/settings?tab=permissions'}
                  className="rounded-xl bg-zinc-100 px-5 py-2.5 text-sm font-medium text-zinc-600 hover:bg-zinc-200 transition-colors"
                >
                  {t('board.contactAdmin')}
                </button>
              </div>
              <button
                onClick={fetchBoards}
                className="flex items-center gap-1 text-sm text-blue-500 hover:text-blue-600 transition-colors"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
                </svg>
                {t('app.error.retry')}
              </button>
            </div>
          </div>
        ) : boards.length === 0 ? (
          <div className="rounded-2xl bg-white p-12 text-center shadow-sm border border-zinc-100">
            <div className="mb-4 flex h-20 w-20 mx-auto items-center justify-center rounded-full bg-zinc-50 text-zinc-400">
              <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
              </svg>
            </div>
            <p className="text-lg font-medium text-zinc-500">{t('board.noBoards')}</p>
            <button
              onClick={openAddModal}
              className="mt-4 inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-blue-500 to-blue-600 px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-blue-500/30 hover:from-blue-600 hover:to-blue-700 transition-all"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14M5 12h14"/>
              </svg>
              {t('modal.newBoard')}
            </button>
          </div>
        ) : (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {boards.map((board) => (
              <BoardCard
                key={board.id}
                board={board}
                onEdit={openEditModal}
                onCopy={handleCopyBoard}
                onSaveAsTemplate={handleSaveAsTemplate}
                onExport={handleExport}
                onImport={openImportModal}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}

        {templates.length > 0 && (
          <div className="mt-10">
            <div className="mb-5 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-purple-500 to-purple-600 text-white shadow-lg shadow-purple-500/30">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>
                </svg>
              </div>
              <h2 className="text-xl font-bold text-zinc-800">{t('nav.templates')}</h2>
              <span className="rounded-full bg-purple-100 px-2.5 py-0.5 text-xs font-medium text-purple-600">{templates.length}</span>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {templates.map((template) => (
                <div
                  key={template.id}
                  className="group rounded-2xl bg-white p-5 shadow-sm border border-zinc-100 hover:shadow-lg hover:border-zinc-200 transition-all duration-300"
                >
                  <div className="flex items-center gap-3 mb-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-purple-500/10 to-purple-600/10 text-purple-600">
                      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>
                      </svg>
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="font-semibold text-zinc-800 truncate">{template.name}</h3>
                    </div>
                  </div>
                  <p className="text-xs text-zinc-400 mb-4">
                    {t('template.createdAt')}: {new Date(template.createdAt).toLocaleDateString()}
                  </p>
                  <button
                    onClick={() => handleDeleteTemplate(template.id)}
                    className="w-full flex items-center justify-center gap-2 rounded-xl bg-red-50 px-3 py-2.5 text-sm font-medium text-red-600 border border-red-100 hover:bg-red-100 hover:border-red-200 transition-all"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                    </svg>
                    {t('task.delete')}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <CreateBoardModal
        isOpen={showModal}
        editingBoard={editingBoard}
        templates={templates}
        onClose={closeModal}
        onSubmit={handleBoardSubmit}
      />

      <ImportModal
        isOpen={showImportModal}
        onClose={closeImportModal}
        onImport={handleImport}
      />

      <ImportConflictConfirm
        isOpen={showImportConflictConfirm}
        onCancel={() => setShowImportConflictConfirm(false)}
        onConfirm={handleImportConflictConfirm}
      />

      {confirmDialog.isOpen && (
        <ConfirmDialog
          isOpen={confirmDialog.isOpen}
          title={confirmDialog.title}
          message={confirmDialog.message}
          variant={confirmDialog.variant}
          onConfirm={confirmDialog.onConfirm}
          onCancel={() => setConfirmDialog((prev) => ({ ...prev, isOpen: false }))}
        />
      )}

      <TemplateNameModal
        isOpen={templateNameModal.isOpen}
        boardId={templateNameModal.boardId}
        boardName={templateNameModal.boardName}
        onClose={() => setTemplateNameModal({ isOpen: false, boardId: '', boardName: '' })}
        onSubmit={handleTemplateNameSubmit}
      />

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 rounded-lg bg-zinc-800 px-4 py-2 text-sm text-white">
          {toast}
        </div>
      )}
      <ErrorToastContainer />

      <footer className="fixed bottom-4 right-6 flex items-center gap-2 text-sm text-zinc-400 hover:text-zinc-600">
        <a
          href="https://github.com/songkl/open-kanban"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
          </svg>
          GitHub
        </a>
      </footer>
    </div>
  );
}
