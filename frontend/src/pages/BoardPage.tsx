import { useState, useEffect, useRef, useCallback } from 'react';
import { Link, useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { arrayMove } from '@dnd-kit/sortable';
import { ColumnBoard } from '../components/ColumnBoard';
import { HeaderRightMenu } from '../components/HeaderRightMenu';
import { BatchOperationBar } from '../components/BatchOperationBar';
import { WsWarning } from '../components/WsWarning';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { BoardSelector } from '../components/BoardSelector';
import { boardsApi } from '../services/api';
import { BoardSkeleton } from '../components/Skeleton';
import { useBoardState } from '../hooks/useBoardState';
import { KeyboardNavigation } from '../components/KeyboardNavigation';
import { BoardToolbar } from '../components/BoardToolbar';
import { BoardActionsMenu } from '../components/BoardActionsMenu';
import type { Task, Column as ColumnType } from '../types/kanban';

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

  const userMenuRef = useRef<HTMLDivElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);
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
    setColumns,
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
      if (showUserMenu && userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setShowUserMenu(false);
      }
      if (showBoardDropdown && boardDropdownRef.current && !boardDropdownRef.current.contains(e.target as Node)) {
        setShowBoardDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showUserMenu, showBoardDropdown]);

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
        setColumns(prev => prev.map(col =>
          col.id === activeColumn.id
            ? { ...col, tasks: newTasks }
            : col
        ));
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

      const sourceTasks = (activeColumn.tasks ?? []).filter(t => t.id !== activeId).map((t, i) => ({ ...t, position: i }));

      lastLocalUpdateRef.current = Date.now();
      await tasksApi.update(activeId, {
        position: movedTaskNewIndex,
        columnId: overColumn.id,
      });
      setColumns(prev => prev.map(col => {
        if (col.id === activeColumn.id) {
          return { ...col, tasks: sourceTasks };
        }
        if (col.id === overColumn.id) {
          return { ...col, tasks: updatedTasks };
        }
        return col;
      }));
    }
  }, [lastLocalUpdateRef, setColumns]);

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

  const handleReset = useCallback(() => {
    if (!currentBoard) return;
    setConfirmDialog({
      isOpen: true,
      title: t('confirm.resetBoardTitle'),
      message: t('confirm.resetBoard', { name: currentBoard.name }),
      variant: 'danger',
      onConfirm: async () => {
        try {
          await boardsApi.reset(currentBoard.id);
          showToastMessage(t('toast.boardReset'));
          window.location.reload();
        } catch (error) {
          console.error('Reset failed:', error);
          showToastMessage(t('toast.resetFailed'));
        }
        setConfirmDialog((prev) => ({ ...prev, isOpen: false }));
      },
    });
  }, [currentBoard, t]);

  const handleDeleteTask = useCallback((taskId: string) => {
    setConfirmDialog({
      isOpen: true,
      title: t('task.confirmDeleteTitle') || t('modal.deleteConfirmTitle'),
      message: t('task.confirmDelete'),
      variant: 'danger',
      onConfirm: () => {
        deleteTask(taskId);
        setConfirmDialog((prev) => ({ ...prev, isOpen: false }));
      },
    });
  }, [t, deleteTask]);

  if (loading || boardSwitching) return <BoardSkeleton />;

  if (loadError) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4">
        <div className="text-red-500">{t('app.error.loadFailed')}</div>
        <div className="text-sm text-zinc-400">{loadError}</div>
        <button className="rounded-md bg-blue-500 px-4 py-2 text-sm text-white hover:bg-blue-600">
          {t('app.error.retry')}
        </button>
        <button
          onClick={() => {
            localStorage.removeItem('token');
            navigate('/login');
          }}
          className="rounded-md bg-red-500 px-4 py-2 text-sm text-white hover:bg-red-600"
        >
          {t('auth.logout')}
        </button>
      </div>
    );
  }

  return (
    <div className="h-screen bg-zinc-100 dark:bg-zinc-900">
      <KeyboardNavigation
        selectedTask={selectedTask}
        selectedTasks={selectedTasks}
        showAddTaskModal={showAddTaskModal}
        columns={columns}
        focusedColumnIndex={focusedColumnIndex}
        focusedTaskIndex={focusedTaskIndex}
        onSetFocusedColumnIndex={setFocusedColumnIndex}
        onSetFocusedTaskIndex={setFocusedTaskIndex}
        onSetShowAddTaskModal={setShowAddTaskModal}
        onSetDefaultColumnIdForNewTask={setDefaultColumnIdForNewTask}
        onSetEditTaskId={setEditTaskId}
        onSetSelectedTask={setSelectedTask}
        onHandleTaskSelect={handleTaskSelect}
        onClearSelection={clearSelection}
        onArchiveTask={archiveTask}
        onDeleteTask={handleDeleteTask}
      />
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

        <BoardToolbar
          searchQuery={searchQuery}
          filters={filters}
          filterPresets={filterPresets}
          uniqueAssignees={uniqueAssignees}
          uniqueTags={uniqueTags}
          hasActiveFilters={hasActiveFilters}
          showFilterPanel={showFilterPanel}
          showPresetDropdown={showPresetDropdown}
          onSetSearchQuery={setSearchQuery}
          onSetFilters={setFilters}
          onClearFilters={clearFilters}
          onSaveCurrentAsPreset={saveCurrentAsPreset}
          onApplyPreset={applyPreset}
          onDeletePreset={deletePreset}
          onSetShowPresetDropdown={setShowPresetDropdown}
          onToggleFilterPanel={() => setShowFilterPanel(!showFilterPanel)}
          onCloseFilterPanel={() => setShowFilterPanel(false)}
          onAddTask={() => {
            setDefaultColumnIdForNewTask(undefined);
            setShowAddTaskModal(true);
          }}
        />

        <div className="flex items-center gap-3">
          <BoardActionsMenu
            showMoreMenu={showMoreMenu}
            showExportMenu={showExportMenu}
            currentUser={currentUser}
            onSetShowMoreMenu={setShowMoreMenu}
            onSetShowExportMenu={setShowExportMenu}
            moreMenuRef={moreMenuRef}
            exportMenuRef={exportMenuRef}
            onExport={handleExport}
            onReset={handleReset}
          />
          <HeaderRightMenu
            showUserMenu={showUserMenu}
            currentUser={currentUser}
            wsStatus={wsStatus}
            reconnectAttemptRef={reconnectAttemptRef}
            onSetShowUserMenu={setShowUserMenu}
            onConnectWebSocket={connectWebSocket}
            userMenuRef={userMenuRef}
            navigate={navigate}
            darkMode={darkMode}
            onSetDarkMode={setDarkMode}
            i18n={i18n}
          />
        </div>
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