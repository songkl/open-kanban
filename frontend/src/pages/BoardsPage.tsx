import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { boardsApi, templatesApi, authApi, presetTemplatesApi } from '../services/api';
import { useSetupGuard } from '../hooks/useSetupGuard';
import { ErrorToastContainer } from '../components/ErrorToast';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { BoardCard } from '../components/BoardCard';
import { CreateBoardModal } from '../components/CreateBoardModal';
import { ImportModal } from '../components/ImportModal';
import { ImportConflictConfirm } from '../components/ImportModal';
import { TemplateNameModal } from '../components/TemplateNameModal';
import { TemplateList } from '../components/TemplateList';

import type { Board, User } from '../types/kanban';

interface Template {
  id: string;
  name: string;
  boardId?: string;
  columnsConfig: string;
  includeTasks: boolean;
  createdAt: string;
}

type BoardSortKey = 'lastActive' | 'createdAt' | 'taskCount' | 'owner' | 'name';

export function BoardsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  useSetupGuard();
  const [boards, setBoards] = useState<Board[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [presetCount, setPresetCount] = useState(0);
  const [showModal, setShowModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [editingBoard, setEditingBoard] = useState<Board | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [showImportConflictConfirm, setShowImportConflictConfirm] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingImportData, setPendingImportData] = useState<{ data: unknown; boardId?: string } | null>(null);
  const [currentUser, setCurrentUser] = useState<User | null>(null);

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

  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<BoardSortKey>('lastActive');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  const fetchTemplates = useCallback(async () => {
    try {
      const data = await templatesApi.getAll();
      setTemplates(data || []);
    } catch (error) {
      console.error('Failed to fetch templates:', error);
    }
  }, []);

  const fetchPresetCount = useCallback(async () => {
    try {
      const data = await presetTemplatesApi.getAll();
      setPresetCount((data || []).length);
    } catch (error) {
      console.error('Failed to fetch preset count:', error);
    }
  }, []);

  const fetchBoards = useCallback(async () => {
    try {
      setLoadError(null);
      const data = await boardsApi.getAll();
      setBoards(data || []);
    } catch (error) {
      console.error('Failed to fetch boards:', error);
      setLoadError(error instanceof Error ? error.message : t('app.error.loadFailed'));
    }
  }, [t]);

  useEffect(() => {
    fetchBoards();
    fetchTemplates();
    fetchPresetCount();
    authApi
      .me()
      .then((data) => {
        if (data.user) setCurrentUser(data.user);
      })
      .catch(console.error);
  }, [fetchBoards, fetchTemplates, fetchPresetCount]);

  const showToastMessage = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 2000);
  };

  const handleContactAdmin = () => {
    if (currentUser?.role === 'ADMIN') {
      navigate('/settings?tab=users');
      return;
    }

    showToastMessage(t('board.contactOwner'));
    navigate('/boards');
  };

  const handleBoardSubmit = async (data: {
    name: string;
    description?: string;
    boardId?: string;
    templateId?: string;
    isPublic?: boolean;
  }) => {
    try {
      if (editingBoard) {
        await boardsApi.update(editingBoard.id, {
          name: data.name,
          description: data.description,
          isPublic: data.isPublic,
        });
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
            isPublic: data.isPublic,
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

  const accessibleBoards = boards.filter(
    (b) => b.effectiveAccess !== '' && b.effectiveAccess !== undefined,
  );
  const canCreateBoard = currentUser?.role !== 'VIEWER';

  const filteredSortedBoards = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const matched = query
      ? accessibleBoards.filter((b) => {
          const haystack = [b.name, b.id, b.description ?? '', b.ownerNickname ?? '']
            .join(' ')
            .toLowerCase();
          return haystack.includes(query);
        })
      : accessibleBoards;

    const getTime = (b: Board, key: 'lastActive' | 'createdAt'): number => {
      const raw = key === 'lastActive' ? b.lastActiveAt : b.createdAt;
      const t = raw ? new Date(raw).getTime() : 0;
      return Number.isNaN(t) ? 0 : t;
    };

    const ownerKey = (b: Board): string => {
      if (b.ownerNickname && b.ownerNickname.trim()) return b.ownerNickname.trim().toLowerCase();
      if (b.isOwner) return '\x00';
      return '\xff';
    };

    return [...matched].sort((a, b) => {
      let cmp = 0;
      switch (sortBy) {
        case 'lastActive':
          cmp = getTime(a, 'lastActive') - getTime(b, 'lastActive');
          break;
        case 'createdAt':
          cmp = getTime(a, 'createdAt') - getTime(b, 'createdAt');
          break;
        case 'taskCount':
          cmp = (a.taskCount ?? 0) - (b.taskCount ?? 0);
          break;
        case 'owner':
          cmp = ownerKey(a).localeCompare(ownerKey(b));
          break;
        case 'name':
          cmp = (a.name || '').localeCompare(b.name || '');
          break;
      }
      if (cmp === 0) {
        cmp = getTime(a, 'createdAt') - getTime(b, 'createdAt');
      }
      return sortOrder === 'asc' ? cmp : -cmp;
    });
  }, [accessibleBoards, searchQuery, sortBy, sortOrder]);

  const isFiltering = searchQuery.trim().length > 0;

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
    } catch (error) {
      console.error('Import failed:', error);
      if ((error as { response?: { status?: number } })?.response?.status === 409) {
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
      } catch {
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
    <div className="min-h-screen bg-gradient-to-br from-zinc-100 to-zinc-50 dark:from-zinc-800 dark:to-zinc-900 p-6">
      <div className="mx-auto max-w-7xl">
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-blue-600 text-white shadow-lg shadow-blue-500/30">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
              </svg>
            </div>
            <div>
              <h1 className="text-2xl font-bold text-zinc-800 dark:text-zinc-100">{t('nav.boardManagement')}</h1>
              <p className="text-sm text-zinc-500 dark:text-zinc-500">{t('board.count_other', { count: accessibleBoards.length })}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div
              className="relative"
              data-testid="boards-search-wrapper"
            >
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
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400"
                aria-hidden="true"
              >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('board.searchPlaceholder')}
                aria-label={t('board.searchPlaceholder')}
                data-testid="boards-search-input"
                className="w-56 rounded-xl border border-zinc-100 dark:border-zinc-700 bg-white dark:bg-zinc-800 pl-9 pr-9 py-2 text-sm text-zinc-700 dark:text-zinc-200 placeholder-zinc-400 shadow-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-400/40"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  aria-label={t('board.clearSearch')}
                  data-testid="boards-search-clear"
                  className="absolute right-2 top-1/2 -translate-y-1/2 flex h-6 w-6 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              )}
            </div>
            <div className="flex items-center gap-1" data-testid="boards-sort-wrapper">
              <label
                htmlFor="boards-sort-select"
                className="text-xs font-medium text-zinc-500 dark:text-zinc-400"
              >
                {t('board.sortBy')}:
              </label>
              <select
                id="boards-sort-select"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as BoardSortKey)}
                data-testid="boards-sort-select"
                className="rounded-xl border border-zinc-100 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm text-zinc-700 dark:text-zinc-200 shadow-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-400/40"
              >
                <option value="lastActive">{t('board.sortLastActive')}</option>
                <option value="createdAt">{t('board.sortCreatedAt')}</option>
                <option value="taskCount">{t('board.sortTaskCount')}</option>
                <option value="owner">{t('board.sortOwner')}</option>
                <option value="name">{t('board.sortName')}</option>
              </select>
              <button
                type="button"
                onClick={() => setSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'))}
                aria-label={sortOrder === 'asc' ? t('common.sortAsc') : t('common.sortDesc')}
                title={sortOrder === 'asc' ? t('common.sortAsc') : t('common.sortDesc')}
                data-testid="boards-sort-order"
                className="flex h-9 w-9 items-center justify-center rounded-xl border border-zinc-100 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 shadow-sm hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-all"
              >
                {sortOrder === 'asc' ? '↑' : '↓'}
              </button>
            </div>
            <Link
              to="/dashboard"
              className="flex items-center gap-2 rounded-xl bg-white dark:bg-zinc-800 px-4 py-2.5 text-sm font-medium text-zinc-600 dark:text-zinc-500 shadow-sm border border-zinc-100 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-700 hover:border-zinc-200 dark:hover:border-zinc-600 transition-all"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="9" /><rect x="14" y="3" width="7" height="5" /><rect x="14" y="12" width="7" height="9" /><rect x="3" y="16" width="7" height="5" />
              </svg>
              {t('nav.dashboard')}
            </Link>
            <Link
              to="/columns"
              className="flex items-center gap-2 rounded-xl bg-white dark:bg-zinc-800 px-4 py-2.5 text-sm font-medium text-zinc-600 dark:text-zinc-500 shadow-sm border border-zinc-100 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-700 hover:border-zinc-200 dark:hover:border-zinc-600 transition-all"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="5" height="18"/><rect x="10" y="3" width="5" height="18"/><rect x="17" y="3" width="5" height="18"/>
              </svg>
              {t('nav.columnManagement')}
            </Link>
            {presetCount > 0 && canCreateBoard && (
              <Link
                to="/templates/marketplace"
                className="flex items-center gap-2 rounded-xl bg-white dark:bg-zinc-800 px-4 py-2.5 text-sm font-medium text-purple-600 dark:text-purple-300 shadow-sm border border-purple-200 dark:border-purple-700 hover:bg-purple-50 dark:hover:bg-zinc-700 transition-all"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="7" height="7" rx="1" />
                  <rect x="14" y="3" width="7" height="7" rx="1" />
                  <rect x="3" y="14" width="7" height="7" rx="1" />
                  <rect x="14" y="14" width="7" height="7" rx="1" />
                </svg>
                {t('nav.templateMarketplace')}
              </Link>
            )}
            {canCreateBoard && (
              <button
                onClick={openAddModal}
                className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-blue-500 to-blue-600 px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-blue-500/30 hover:from-blue-600 hover:to-blue-700 transition-all"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 5v14M5 12h14"/>
                </svg>
                {t('modal.newBoard')}
              </button>
            )}
          </div>
        </div>

        {loadError ? (
          <div className="rounded-2xl bg-white dark:bg-zinc-800 p-8 text-center shadow-sm border border-zinc-100 dark:border-zinc-700">
            <div className="mb-6 flex h-20 w-20 mx-auto items-center justify-center rounded-full bg-red-50 dark:bg-red-900/30 text-red-500">
              <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
            </div>
            <p className="text-lg font-semibold text-zinc-800 dark:text-zinc-100">{t('app.error.loadFailed')}</p>
            <div className="flex flex-col gap-3 items-center">
              <p className="text-sm text-zinc-500 dark:text-zinc-500">{t('board.loadFailedHint')}</p>
              <div className="flex gap-3">
                {canCreateBoard && (
                  <button
                    onClick={() => setShowModal(true)}
                    className="rounded-xl bg-gradient-to-r from-blue-500 to-blue-600 px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-blue-500/30 hover:from-blue-600 hover:to-blue-700 transition-all"
                  >
                    {t('board.createNew')}
                  </button>
                )}
                <button
                  onClick={handleContactAdmin}
                  className="rounded-xl bg-zinc-100 dark:bg-zinc-700 px-5 py-2.5 text-sm font-medium text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-600 transition-colors"
                >
                  {t('board.contactAdmin')}
                </button>
              </div>
              <button
                onClick={fetchBoards}
                className="flex items-center gap-1 text-sm text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300 transition-colors"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
                </svg>
                {t('app.error.retry')}
              </button>
            </div>
          </div>
        ) : accessibleBoards.length === 0 ? (
          <div className="rounded-2xl bg-white dark:bg-zinc-800 p-12 text-center shadow-sm border border-zinc-100 dark:border-zinc-700">
            <div className="mb-4 flex h-20 w-20 mx-auto items-center justify-center rounded-full bg-zinc-50 dark:bg-zinc-700 text-zinc-400 dark:text-zinc-400">
              <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
              </svg>
            </div>
            <p className="text-lg font-medium text-zinc-500 dark:text-zinc-500">
              {canCreateBoard ? t('board.noBoardsYet') : t('board.noAccessibleBoards')}
            </p>
            <p className="mt-2 text-sm text-zinc-400 dark:text-zinc-500">
              {t('board.emptyStateHint')}
            </p>
            {canCreateBoard && (
              <div className="mt-6 flex flex-col gap-3 items-center sm:flex-row sm:justify-center">
                {presetCount > 0 && (
                  <button
                    onClick={() => navigate('/onboarding')}
                    className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-purple-500 to-purple-600 px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-purple-500/30 hover:from-purple-600 hover:to-purple-700 transition-all"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
                    </svg>
                    {t('board.importFromTemplate')}
                  </button>
                )}
                <button
                  onClick={openAddModal}
                  className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-blue-500 to-blue-600 px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-blue-500/30 hover:from-blue-600 hover:to-blue-700 transition-all"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 5v14M5 12h14"/>
                  </svg>
                  {t('modal.newBoard')}
                </button>
                {presetCount > 1 && (
                  <Link
                    to="/templates/marketplace"
                    className="inline-flex items-center gap-2 rounded-xl bg-white dark:bg-zinc-800 px-5 py-2.5 text-sm font-medium text-zinc-700 dark:text-zinc-200 border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-all"
                  >
                    {t('board.browseMarketplace')}
                  </Link>
                )}
              </div>
            )}
          </div>
        ) : isFiltering && filteredSortedBoards.length === 0 ? (
          <div
            className="rounded-2xl bg-white dark:bg-zinc-800 p-12 text-center shadow-sm border border-zinc-100 dark:border-zinc-700"
            data-testid="boards-empty-filter"
          >
            <div className="mb-4 flex h-20 w-20 mx-auto items-center justify-center rounded-full bg-zinc-50 dark:bg-zinc-700 text-zinc-400 dark:text-zinc-400">
              <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </div>
            <p className="text-lg font-medium text-zinc-700 dark:text-zinc-200">
              {t('board.noResultsForFilter', { query: searchQuery })}
            </p>
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="mt-4 inline-flex items-center gap-2 rounded-xl bg-zinc-100 dark:bg-zinc-700 px-4 py-2 text-sm font-medium text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-600 transition-colors"
            >
              {t('board.clearSearch')}
            </button>
          </div>
        ) : (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {filteredSortedBoards.map((board) => (
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
          <TemplateList
            templates={templates}
            onDeleteTemplate={handleDeleteTemplate}
          />
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
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] rounded-lg bg-zinc-800 dark:bg-zinc-700 px-4 py-2 text-sm text-white shadow-lg">
          {toast}
        </div>
      )}
      <ErrorToastContainer />

      <footer className="fixed bottom-4 right-6 flex items-center gap-2 text-sm text-zinc-400 dark:text-zinc-400 hover:text-zinc-600 dark:text-zinc-300 dark:hover:text-zinc-300">
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
