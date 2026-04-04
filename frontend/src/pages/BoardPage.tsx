import { useState, useEffect, useRef, useCallback } from 'react';
import { Link, useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { arrayMove } from '@dnd-kit/sortable';
import { ColumnBoard } from '../components/ColumnBoard';
import { FilterPanelContent } from '../components/FilterPanelContent';
import { HeaderRightMenu } from '../components/HeaderRightMenu';
import { BatchOperationBar } from '../components/BatchOperationBar';
import { WsWarning } from '../components/WsWarning';
import { SearchBar } from '../components/SearchBar';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { boardsApi } from '../services/api';
import { BoardSkeleton } from '../components/Skeleton';
import { useBoardState } from '../hooks/useBoardState';
import type { Task, Column as ColumnType, Board } from '../types/kanban';

const LAST_BOARD_KEY = 'lastSelectedBoardId';
const DARK_MODE_KEY = 'darkMode';

interface ConfirmDialogState {
  isOpen: boolean;
  title: string;
  message: string;
  onConfirm: () => void;
  variant?: 'danger' | 'warning' | 'default';
}

export function BoardPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const params = useParams();
  const [searchParams] = useSearchParams();
  const boardIdFromUrl = params.boardId as string;
  const taskIdFromUrl = searchParams.get('taskId');

  const [darkMode, setDarkMode] = useState(() => {
    const saved = localStorage.getItem(DARK_MODE_KEY);
    return saved === 'true' || window.matchMedia('(prefers-color-scheme: dark)').matches;
  });
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);
  const [showFilterPanel, setShowFilterPanel] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [showBoardDropdown, setShowBoardDropdown] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [showPreferencesMenu, setShowPreferencesMenu] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showPresetDropdown, setShowPresetDropdown] = useState(false);
  const [focusedColumnIndex, setFocusedColumnIndex] = useState(0);
  const [focusedTaskIndex, setFocusedTaskIndex] = useState(0);
  const [editTaskId, setEditTaskId] = useState<string | null>(null);
  const [showAddTaskModal, setShowAddTaskModal] = useState(false);
  const [defaultColumnIdForNewTask, setDefaultColumnIdForNewTask] = useState<string | undefined>();
  const [toast, setToast] = useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState>({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: () => {},
  });

  const filterPanelRef = useRef<HTMLDivElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const preferencesMenuRef = useRef<HTMLDivElement>(null);
  const boardDropdownRef = useRef<HTMLDivElement>(null);
  const reconnectAttemptRef = useRef(0);

  const {
    boards,
    currentBoard,
    columns,
    activeTask,
    selectedTask,
    selectedTasks,
    loading,
    boardSwitching,
    loadError,
    wsStatus,
    reconnectCount,
    currentUser,
    filters,
    filterPresets,
    columnPagination,
    searchQuery,
    uniqueAssignees,
    uniqueTags,
    getFilteredColumns,
    updateTask,
    deleteTask,
    archiveTask,
    addTask,
    addComment,
    handleTaskSelect,
    clearSelection,
    batchDelete,
    batchArchive,
    batchMove,
    batchUpdatePriority,
    batchUpdateAssignee,
    handleColumnRename,
    setSelectedTask,
    setActiveTask,
    setFilters,
    setSearchQuery,
    saveCurrentAsPreset,
    applyPreset,
    deletePreset,
    clearFilters,
    hasActiveFilters,
    lastLocalUpdateRef,
  } = useBoardState({ boardIdFromUrl, taskIdFromUrl });

  const showToastMessage = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 2000);
  };

  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    localStorage.setItem(DARK_MODE_KEY, String(darkMode));
  }, [darkMode]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (showFilterPanel && filterPanelRef.current && !filterPanelRef.current.contains(e.target as Node)) {
        setShowFilterPanel(false);
      }
      if (showMoreMenu && moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setShowMoreMenu(false);
        setShowExportMenu(false);
        setShowPreferencesMenu(false);
      }
      if (showUserMenu && userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setShowUserMenu(false);
      }
      if (showExportMenu && exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setShowExportMenu(false);
      }
      if (showPreferencesMenu && preferencesMenuRef.current && !preferencesMenuRef.current.contains(e.target as Node)) {
        setShowPreferencesMenu(false);
      }
      if (showBoardDropdown && boardDropdownRef.current && !boardDropdownRef.current.contains(e.target as Node)) {
        setShowBoardDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showFilterPanel, showMoreMenu, showUserMenu, showExportMenu, showPreferencesMenu, showBoardDropdown]);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const updateTaskPosition = useCallback(async (
    activeId: string,
    overId: string,
    activeColumn: ColumnType,
    overColumn: ColumnType,
    activeTaskLocal: Task | null
  ) => {
    const tasksApi = (await import('../services/api')).tasksApi;

    if (activeColumn.id === overColumn.id) {
      const tasks = activeColumn.tasks ?? [];
      const oldIndex = tasks.findIndex((t) => t.id === activeId);
      const newIndex = tasks.findIndex((t) => t.id === overId);

      if (oldIndex !== newIndex) {
        const newTasks = arrayMove(tasks, oldIndex, newIndex).map((t, i) => ({
          ...t,
          position: i,
        }));

        lastLocalUpdateRef.current = Date.now();
        await tasksApi.update(activeId, { position: newTasks[newIndex].position });
      }
    } else {
      const overTasks = [...(overColumn.tasks ?? [])];
      const newIndex = overTasks.findIndex((t) => t.id === overId);

      if (newIndex >= 0) {
        overTasks.splice(newIndex, 0, { ...activeTaskLocal!, columnId: overColumn.id });
      } else {
        overTasks.push({ ...activeTaskLocal!, columnId: overColumn.id });
      }

      const updatedTasks = overTasks.map((t, i) => ({ ...t, position: i }));
      const movedTaskNewIndex = updatedTasks.findIndex((t) => t.id === activeId);

      lastLocalUpdateRef.current = Date.now();
      await tasksApi.update(activeId, {
        position: movedTaskNewIndex,
        columnId: overColumn.id,
      });
    }
  }, [lastLocalUpdateRef]);

  const connectWebSocket = useCallback(() => {
    reconnectAttemptRef.current = 0;
  }, []);

  const handleExport = useCallback(async (format: 'json' | 'csv') => {
    if (!currentBoard) return;
    try {
      const response = await boardsApi.export(currentBoard.id, format);
      if (!response.ok) throw new Error('Export failed');
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      a.download = `${currentBoard.name}_${timestamp}.${format}`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      setShowExportMenu(false);
      setShowMoreMenu(false);
    } catch (error) {
      console.error('Export failed:', error);
      showToastMessage(t('export.failed'));
    }
  }, [currentBoard, t]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'n') {
        e.preventDefault();
        setShowAddTaskModal(true);
        return;
      }

      const target = e.target as HTMLElement;
      const isInputFocused =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable;

      if (e.key === '/' && !isInputFocused) {
        e.preventDefault();
        return;
      }

      if (e.key === 'e' && !isInputFocused && selectedTask) {
        e.preventDefault();
        setEditTaskId(selectedTask.id);
        return;
      }

      if ((e.key === 'n' || e.key === 'N') && !isInputFocused) {
        e.preventDefault();
        setShowAddTaskModal(true);
        return;
      }

      if (e.key === 'Escape') {
        if (showAddTaskModal) {
          setShowAddTaskModal(false);
          setDefaultColumnIdForNewTask(undefined);
        } else if (selectedTask) {
          setSelectedTask(null);
          setEditTaskId(null);
        } else if (selectedTasks.size > 0) {
          clearSelection();
        }
        return;
      }

      if (isInputFocused) return;

      const currentColumn = columns[focusedColumnIndex];
      const columnTasks = currentColumn?.tasks || [];

      if (e.key === 'j' || e.key === 'J') {
        e.preventDefault();
        if (columnTasks.length === 0) return;
        const newIndex = Math.min(focusedTaskIndex + 1, columnTasks.length - 1);
        setFocusedTaskIndex(newIndex);
        const task = columnTasks[newIndex];
        if (task) handleTaskSelect(task.id, task);
        return;
      }

      if (e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        if (columnTasks.length === 0) return;
        const newIndex = Math.max(focusedTaskIndex - 1, 0);
        setFocusedTaskIndex(newIndex);
        const task = columnTasks[newIndex];
        if (task) handleTaskSelect(task.id, task);
        return;
      }

      if (e.key === 'h' || e.key === 'H') {
        e.preventDefault();
        if (columns.length === 0) return;
        const newColIndex = Math.max(focusedColumnIndex - 1, 0);
        setFocusedColumnIndex(newColIndex);
        const col = columns[newColIndex];
        if (col.tasks && col.tasks.length > 0) {
          setFocusedTaskIndex(0);
          handleTaskSelect(col.tasks[0].id, col.tasks[0]);
        }
        return;
      }

      if (e.key === 'l' || e.key === 'L') {
        e.preventDefault();
        if (columns.length === 0) return;
        const newColIndex = Math.min(focusedColumnIndex + 1, columns.length - 1);
        setFocusedColumnIndex(newColIndex);
        const col = columns[newColIndex];
        if (col.tasks && col.tasks.length > 0) {
          setFocusedTaskIndex(0);
          handleTaskSelect(col.tasks[0].id, col.tasks[0]);
        }
        return;
      }

      if ((e.key === 'd' || e.key === 'D') && selectedTask) {
        e.preventDefault();
        archiveTask(selectedTask.id);
        return;
      }

      if (e.key === 'Delete' && selectedTask) {
        e.preventDefault();
        setConfirmDialog({
          isOpen: true,
          title: t('task.confirmDeleteTitle') || t('modal.deleteConfirmTitle'),
          message: t('task.confirmDelete'),
          variant: 'danger',
          onConfirm: () => {
            deleteTask(selectedTask.id);
            setConfirmDialog((prev) => ({ ...prev, isOpen: false }));
          },
        });
        return;
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [
    selectedTask,
    selectedTasks,
    showAddTaskModal,
    columns,
    focusedColumnIndex,
    focusedTaskIndex,
    t,
    handleTaskSelect,
    clearSelection,
    archiveTask,
    deleteTask,
    setSelectedTask,
  ]);

  if (loading || boardSwitching) return <BoardSkeleton />;

  if (loadError) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4">
        <div className="text-red-500">{t('app.error.loadFailed')}</div>
        <div className="text-sm text-zinc-400">{loadError}</div>
        <button className="rounded-md bg-blue-500 px-4 py-2 text-sm text-white hover:bg-blue-600">
          {t('app.error.retry')}
        </button>
      </div>
    );
  }

  return (
    <div className="h-screen bg-zinc-100 dark:bg-zinc-900">
      <WsWarning
        wsStatus={wsStatus}
        reconnectCount={reconnectCount}
        onConnectWebSocket={connectWebSocket}
      />

      <header className="p-6 pb-0 mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <BoardSelector
            ref={boardDropdownRef}
            boards={boards}
            currentBoard={currentBoard}
            boardIdFromUrl={boardIdFromUrl}
            showDropdown={showBoardDropdown}
            onToggleDropdown={() => setShowBoardDropdown(!showBoardDropdown)}
            onSelectBoard={(id) => {
              localStorage.setItem(LAST_BOARD_KEY, id);
              setShowBoardDropdown(false);
              if (id !== boardIdFromUrl) navigate(`/board/${id}`);
            }}
          />
          <Link
            to={`/columns?boardId=${boardIdFromUrl}`}
            className="flex items-center rounded-md border border-zinc-200 bg-white p-1.5 text-zinc-600 hover:bg-zinc-50"
            title={t('column.manageColumns')}
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
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" />
            </svg>
          </Link>
        </div>

        <div className="flex items-center gap-3">
          <SearchBar
            value={searchQuery}
            onChange={(value) => {
              setSearchQuery(value);
              setFilters((prev) => ({ ...prev, searchQuery: value }));
            }}
            onClear={() => {
              setSearchQuery('');
              setFilters((prev) => ({ ...prev, searchQuery: '' }));
            }}
          />

          <div className="relative">
            <button
              onClick={() => setShowFilterPanel(!showFilterPanel)}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm ${
                hasActiveFilters
                  ? 'bg-blue-100 text-blue-700 border border-blue-300'
                  : 'bg-zinc-200 text-zinc-700 border border-transparent'
              } hover:bg-zinc-300`}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
              </svg>
              {t('filter.filter')}
              {hasActiveFilters && (
                <span className="ml-1 rounded-full bg-blue-500 text-white text-xs w-4 h-4 flex items-center justify-center">
                  {[filters.searchQuery, filters.priority, filters.assignee, filters.dateRange, filters.tag].filter(Boolean).length}
                </span>
              )}
            </button>
            {showFilterPanel && (
              <div
                ref={filterPanelRef}
                className="absolute right-0 top-full mt-2 w-64 rounded-lg border border-zinc-200 bg-white p-3 shadow-lg z-50"
              >
                <FilterPanelContent
                  filters={filters}
                  uniqueAssignees={uniqueAssignees}
                  uniqueTags={uniqueTags}
                  filterPresets={filterPresets}
                  showPresetDropdown={showPresetDropdown}
                  onSetFilters={setFilters}
                  onClearFilters={clearFilters}
                  onSaveCurrentAsPreset={saveCurrentAsPreset}
                  onApplyPreset={applyPreset}
                  onDeletePreset={deletePreset}
                  onSetShowPresetDropdown={setShowPresetDropdown}
                />
              </div>
            )}
          </div>

          <button
            onClick={() => {
              setDefaultColumnIdForNewTask(undefined);
              setShowAddTaskModal(true);
            }}
            className="flex items-center gap-1.5 rounded-md bg-blue-500 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-600"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            {t('task.create')}
          </button>
        </div>

        <HeaderRightMenu
          showMoreMenu={showMoreMenu}
          showUserMenu={showUserMenu}
          showExportMenu={showExportMenu}
          showPreferencesMenu={showPreferencesMenu}
          currentUser={currentUser}
          wsStatus={wsStatus}
          reconnectCount={reconnectCount}
          reconnectAttemptRef={reconnectAttemptRef}
          onSetShowMoreMenu={setShowMoreMenu}
          onSetShowUserMenu={setShowUserMenu}
          onSetShowExportMenu={setShowExportMenu}
          onSetShowPreferencesMenu={setShowPreferencesMenu}
          onConnectWebSocket={connectWebSocket}
          moreMenuRef={moreMenuRef}
          userMenuRef={userMenuRef}
          exportMenuRef={exportMenuRef}
          preferencesMenuRef={preferencesMenuRef}
          onExport={handleExport}
          onSetDarkMode={setDarkMode}
          darkMode={darkMode}
          i18n={i18n}
          navigate={navigate}
        />
      </header>

      <ColumnBoard
        columns={columns}
        currentBoard={currentBoard}
        boards={boards}
        boardIdFromUrl={boardIdFromUrl}
        activeTask={activeTask}
        selectedTask={selectedTask}
        selectedTasks={selectedTasks}
        columnPagination={columnPagination}
        filters={filters}
        isMobile={isMobile}
        showAddTaskModal={showAddTaskModal}
        defaultColumnIdForNewTask={defaultColumnIdForNewTask}
        editTaskId={editTaskId}
        onAddTask={addTask}
        onUpdateTask={updateTask}
        onDeleteTask={deleteTask}
        onArchiveTask={archiveTask}
        onAddComment={addComment}
        onTaskSelect={handleTaskSelect}
        onLoadMoreTasks={() => {}}
        onColumnRename={handleColumnRename}
        onSetSelectedTask={setSelectedTask}
        onSetActiveTask={setActiveTask}
        onSetShowAddTaskModal={setShowAddTaskModal}
        onSetDefaultColumnIdForNewTask={setDefaultColumnIdForNewTask}
        onSetEditTaskId={setEditTaskId}
        getFilteredColumns={getFilteredColumns}
        updateTaskPosition={updateTaskPosition}
      />

      {selectedTasks.size > 0 && (
        <BatchOperationBar
          selectedTasks={selectedTasks}
          columns={columns}
          uniqueAssignees={uniqueAssignees}
          onBatchMove={batchMove}
          onBatchUpdatePriority={batchUpdatePriority}
          onBatchUpdateAssignee={batchUpdateAssignee}
          onBatchArchive={batchArchive}
          onBatchDelete={batchDelete}
          onClearSelection={clearSelection}
        />
      )}

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 rounded-lg bg-zinc-800 px-4 py-2 text-sm text-white">
          {toast}
        </div>
      )}

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
    </div>
  );
}

interface BoardSelectorProps {
  boards: Board[];
  currentBoard: Board | null;
  boardIdFromUrl: string;
  showDropdown: boolean;
  onToggleDropdown: () => void;
  onSelectBoard: (id: string) => void;
}

import { forwardRef } from 'react';

const BoardSelector = forwardRef<HTMLDivElement, BoardSelectorProps>(
  ({ boards, currentBoard, boardIdFromUrl, showDropdown, onToggleDropdown, onSelectBoard }, ref) => {
    const { t } = useTranslation();

    return (
      <div ref={ref} className="relative">
        <button
          onClick={onToggleDropdown}
          className="flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 py-1 text-sm hover:bg-zinc-50 max-w-36"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="3" width="7" height="7" />
            <rect x="14" y="3" width="7" height="7" />
            <rect x="14" y="14" width="7" height="7" />
            <rect x="3" y="14" width="7" height="7" />
          </svg>
          <span className="truncate max-w-24">
            {currentBoard?.name || boards.find((b) => b.id === boardIdFromUrl)?.name || t('board.selectBoard')}
          </span>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
        {showDropdown && (
          <div className="absolute left-0 top-full mt-1 w-48 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg z-50">
            {boards.map((board) => (
              <button
                key={board.id}
                onClick={() => onSelectBoard(board.id)}
                className={`w-full px-3 py-2 text-left text-sm hover:bg-zinc-100 ${
                  board.id === boardIdFromUrl ? 'bg-blue-50 text-blue-700 font-medium' : 'text-zinc-700'
                }`}
              >
                {board.name}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }
);

BoardSelector.displayName = 'BoardSelector';