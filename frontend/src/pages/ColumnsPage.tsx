import { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { boardsApi, columnsApi, authApi } from '@/services/api';
import { AddColumnPermissionForm } from '@/components/AddColumnPermissionForm';
import type { Agent } from '@/types/kanban';

interface Board {
  id: string;
  name: string;
}

interface ColumnData {
  id: string;
  name: string;
  status: string | null;
  position: number;
  color: string;
  description?: string;
  boardId: string;
  ownerAgentId?: string;
}

function SortableColumn({
  column,
  onEdit,
  onDelete,
  onPermission,
  t,
  canEdit,
  canDelete,
  canManagePermission,
}: {
  column: ColumnData;
  onEdit: (column: ColumnData) => void;
  onDelete: (columnId: string) => void;
  onPermission: (column: ColumnData) => void;
  t: ReturnType<typeof useTranslation>[0];
  canEdit?: boolean;
  canDelete?: boolean;
  canManagePermission?: boolean;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: column.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="group flex items-center gap-4 rounded-xl bg-white p-4 shadow-sm border border-zinc-100 hover:shadow-md hover:border-zinc-200 transition-all duration-200"
    >
      <button
        {...attributes}
        {...listeners}
        className="cursor-grab text-zinc-300 hover:text-zinc-500 active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity"
        title={t('column.dragToSort')}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-5 w-5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 8h16M4 16h16"
          />
        </svg>
      </button>
      <div
        className="h-6 w-6 rounded-full shadow-sm"
        style={{ backgroundColor: column.color }}
      />
      <span className="flex-1 font-semibold text-zinc-800">{column.name}</span>
      {column.status && (
        <span className="rounded-full bg-zinc-50 px-3 py-1 text-xs font-medium text-zinc-500 border border-zinc-100">
          {column.status}
        </span>
      )}
      <span className="text-xs text-zinc-400 font-mono">#{column.position + 1}</span>
      <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
        {canManagePermission && (
          <button
            onClick={() => onPermission(column)}
            className="rounded-lg bg-violet-50 px-3 py-1.5 text-sm font-medium text-violet-600 hover:bg-violet-100 transition-colors"
          >
            {t('column.permissions')}
          </button>
        )}
        {canEdit && (
          <button
            onClick={() => onEdit(column)}
            className="rounded-lg bg-blue-50 px-3 py-1.5 text-sm font-medium text-blue-600 hover:bg-blue-100 transition-colors"
          >
            {t('column.edit')}
          </button>
        )}
        {canDelete && (
          <button
            onClick={() => onDelete(column.id)}
            className="rounded-lg bg-red-50 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-100 transition-colors"
          >
            {t('column.delete')}
          </button>
        )}
      </div>
    </div>
  );
}

export function ColumnsPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const boardIdFromUrl = searchParams.get('boardId');

  const [boards, setBoards] = useState<Board[]>([]);
  const [selectedBoard, setSelectedBoard] = useState<Board | null>(null);
  const [columns, setColumns] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newColumnName, setNewColumnName] = useState('');
  const [newColumnColor, setNewColumnColor] = useState('#6b7280');
  const [editingColumn, setEditingColumn] = useState<any>(null);
  const [editColumnColor, setEditColumnColor] = useState('#6b7280');
  const [editColumnStatus, setEditColumnStatus] = useState('');
  const [editColumnDescription, setEditColumnDescription] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [currentUser, setCurrentUser] = useState<{ id: string; role: string } | null>(null);
  const [userBoardAccess, setUserBoardAccess] = useState<string | null>(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [columnToDelete, setColumnToDelete] = useState<{ id: string; name: string; taskCount: number } | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [editColumnOwnerAgent, setEditColumnOwnerAgent] = useState<string>('');
  const [showPermissionModal, setShowPermissionModal] = useState(false);
  const [permissionColumn, setPermissionColumn] = useState<ColumnData | null>(null);
  const [columnPermissions, setColumnPermissions] = useState<Array<{ id: string; columnId: string; columnName: string; access: string }>>([]);
  const [permissionLoading, setPermissionLoading] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  useEffect(() => {
    fetchBoards();
    fetchCurrentUser();
  }, []);

  useEffect(() => {
    if (boards.length > 0) {
      // If boardId is in URL and exists in boards, use it
      const targetBoard = boardIdFromUrl
        ? boards.find(b => b.id === boardIdFromUrl)
        : null;

      if (targetBoard) {
        // URL has valid boardId, use it (sync selectedBoard if different)
        if (targetBoard.id !== selectedBoard?.id) {
          setSelectedBoard(targetBoard);
        }
      } else if (!selectedBoard) {
        // No valid URL param and no current selection, default to first board
        setSelectedBoard(boards[0]);
      }
    }
  }, [boards, boardIdFromUrl, selectedBoard?.id]);

  useEffect(() => {
    if (selectedBoard) {
      fetchColumns(selectedBoard.id);
      if (boardIdFromUrl !== selectedBoard.id) {
        setSearchParams({ boardId: selectedBoard.id });
      }
    }
  }, [selectedBoard?.id]);

  useEffect(() => {
    if (selectedBoard && currentUser) {
      fetchUserPermissions(selectedBoard.id);
    }
  }, [selectedBoard?.id, currentUser?.id]);

  useEffect(() => {
    const loadAgents = async () => {
      try {
        const data = await authApi.getAgents();
        setAgents(data || []);
      } catch (err) {
        console.error('Failed to fetch agents:', err);
      }
    };
    loadAgents();
  }, []);

  const fetchBoards = async () => {
    try {
      const data = await boardsApi.getAll();
      setBoards(data || []);
    } catch (err) {
      console.error('Failed to fetch boards:', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchCurrentUser = async () => {
    try {
      const data = await authApi.me();
      if (data.user) {
        setCurrentUser(data.user);
      }
    } catch (err) {
      console.error('Failed to fetch current user:', err);
    }
  };

  const fetchUserPermissions = async (boardId: string) => {
    if (!currentUser) return;
    try {
      const data = await authApi.getPermissions(currentUser.id);
      const boardPerm = data.permissions?.find((p: { boardId: string }) => p.boardId === boardId);
      setUserBoardAccess(boardPerm?.access || null);
    } catch (err) {
      console.error('Failed to fetch permissions:', err);
      setUserBoardAccess(null);
    }
  };

  const fetchColumns = async (boardId: string) => {
    setLoading(true);
    try {
      const data = await columnsApi.getByBoard(boardId);
      setColumns(data);
    } catch (err) {
      console.error('Failed to fetch columns:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleBoardChange = (boardId: string) => {
    const board = boards.find(b => b.id === boardId);
    if (board) {
      setSelectedBoard(board);
    }
  };

  const showToastMessage = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 2000);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      const oldIndex = columns.findIndex((col) => col.id === active.id);
      const newIndex = columns.findIndex((col) => col.id === over.id);

      const newColumns = arrayMove(columns, oldIndex, newIndex).map(
        (col, index) => ({ ...col, position: index })
      );

      setColumns(newColumns);

      try {
        await columnsApi.reorder(
          selectedBoard!.id,
          newColumns.map((col) => ({ id: col.id, position: col.position }))
        );
        showToastMessage(t('column.sortSaved'));
      } catch (err) {
        console.error('Failed to save reorder:', err);
        showToastMessage(t('column.sortSaveFailed'));
        if (selectedBoard) fetchColumns(selectedBoard.id);
      }
    }
  };

  const handleAddColumn = async () => {
    if (!newColumnName.trim() || !selectedBoard) return;

    try {
      await columnsApi.create({
        name: newColumnName.trim(),
        boardId: selectedBoard.id,
        color: newColumnColor,
        ownerAgentId: editColumnOwnerAgent || undefined,
      });

      showToastMessage(t('column.addSuccess'));
      setNewColumnName('');
      setShowAddModal(false);
      setEditColumnOwnerAgent('');
      fetchColumns(selectedBoard.id);
    } catch (err) {
      console.error('Failed to add column:', err);
      showToastMessage(t('column.addFailed'));
    }
  };

  const handleUpdateColumn = async () => {
    if (!editingColumn || !newColumnName.trim()) return;

    try {
      await columnsApi.update(editingColumn.id, {
        name: newColumnName.trim(),
        color: editColumnColor,
        status: editColumnStatus,
        description: editColumnDescription,
        ownerAgentId: editColumnOwnerAgent || undefined,
      });

      showToastMessage(t('column.updateSuccess'));
      setEditingColumn(null);
      setNewColumnName('');
      setEditColumnColor('#6b7280');
      setEditColumnStatus('');
      setEditColumnDescription('');
      setEditColumnOwnerAgent('');
      fetchColumns(selectedBoard!.id);
    } catch (err) {
      console.error('Failed to update column:', err);
      showToastMessage(t('column.updateFailed'));
    }
  };

  const handleDeleteColumn = async (columnId: string) => {
    const column = columns.find(c => c.id === columnId);
    if (!column) return;
    setColumnToDelete({ id: columnId, name: column.name, taskCount: column.tasks?.length || 0 });
    setShowDeleteModal(true);
  };

  const confirmDeleteColumn = async () => {
    if (!columnToDelete) return;

    try {
      await columnsApi.delete(columnToDelete.id);
      showToastMessage(t('column.deleted'));
      setShowDeleteModal(false);
      setColumnToDelete(null);
      fetchColumns(selectedBoard!.id);
    } catch (err) {
      console.error('Failed to delete column:', err);
      showToastMessage(t('column.deleteFailed'));
    }
  };

  const handleOpenPermissionModal = async (column: ColumnData) => {
    setPermissionColumn(column);
    setShowPermissionModal(true);
    setPermissionLoading(true);
    try {
      const data = await authApi.getColumnPermissions(undefined, column.id);
      setColumnPermissions(data.permissions || []);
    } catch (err) {
      console.error('Failed to fetch column permissions:', err);
    } finally {
      setPermissionLoading(false);
    }
  };

  const handleDeleteColumnPermission = async (permissionId: string) => {
    try {
      await authApi.deleteColumnPermission(permissionId);
      if (permissionColumn) {
        const data = await authApi.getColumnPermissions(undefined, permissionColumn.id);
        setColumnPermissions(data.permissions || []);
      }
    } catch (err) {
      console.error('Failed to delete column permission:', err);
    }
  };

  const handleExport = async (format: 'json' | 'csv') => {
    if (!selectedBoard) return;
    setExporting(true);
    try {
      const response = await boardsApi.export(selectedBoard.id, format);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${selectedBoard.name}_${new Date().toISOString().split('T')[0]}.${format}`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      showToastMessage(t('column.exportSuccess', { format: format.toUpperCase() }));
    } catch (err) {
      console.error('Failed to export:', err);
      showToastMessage(t('column.exportFailed'));
    } finally {
      setExporting(false);
    }
  };

  const sortedColumns = [...columns].sort((a, b) => a.position - b.position);

  if (loading && columns.length === 0) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-zinc-500">{t('column.loading')}</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-zinc-100 to-zinc-50 p-6">
      <div className="mx-auto max-w-7xl">
        <header className="mb-8 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-blue-600 text-white shadow-lg shadow-blue-500/30">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="5" height="18"/><rect x="10" y="3" width="5" height="18"/><rect x="17" y="3" width="5" height="18"/>
            </svg>
          </div>
          <div>
            <h1 className="text-2xl font-bold text-zinc-800">{t('nav.columnManagement')}</h1>
            {selectedBoard && (
              <p className="text-sm text-zinc-500">{selectedBoard.name}</p>
            )}
          </div>
          {boards.length > 1 && (
            <select
              value={selectedBoard?.id || boardIdFromUrl || ''}
              onChange={(e) => handleBoardChange(e.target.value)}
              className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm shadow-sm hover:border-zinc-300 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            >
              {boards.map((board) => (
                <option key={board.id} value={board.id}>
                  {board.name}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="flex items-center gap-3">
          {selectedBoard && (
            <div className="flex items-center gap-1 rounded-xl bg-white px-3 py-1.5 shadow-sm border border-zinc-100">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" className="text-green-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>
              </svg>
              <span className="text-xs font-medium text-zinc-600">{t('column.export')}:</span>
              <button
                onClick={() => handleExport('json')}
                disabled={exporting}
                className="rounded-lg px-2 py-1 text-xs font-medium text-green-600 hover:bg-green-50 disabled:opacity-50 transition-colors"
              >
                JSON
              </button>
              <button
                onClick={() => handleExport('csv')}
                disabled={exporting}
                className="rounded-lg px-2 py-1 text-xs font-medium text-green-600 hover:bg-green-50 disabled:opacity-50 transition-colors"
              >
                CSV
              </button>
            </div>
          )}
          <Link
            to={selectedBoard ? `/board/${selectedBoard.id}` : '/boards'}
            className="flex items-center gap-2 rounded-xl bg-white px-4 py-2 text-sm font-medium text-zinc-600 shadow-sm border border-zinc-100 hover:bg-zinc-50 hover:border-zinc-200 transition-all"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 12H5M12 19l-7-7 7-7"/>
            </svg>
            {t('column.backToBoard')}
          </Link>
        </div>
      </header>

      <div className="mb-6 flex items-center gap-4">
        {(userBoardAccess === 'ADMIN' || currentUser?.role === 'ADMIN') && (
          <button
            type="button"
            onClick={() => setShowAddModal(true)}
            className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-blue-500 to-blue-600 px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-blue-500/30 hover:from-blue-600 hover:to-blue-700 transition-all"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14M5 12h14"/>
            </svg>
            {t('column.addColumn')}
          </button>
        )}
        <span className="flex items-center gap-2 text-sm text-zinc-500">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>
          </svg>
          {t('column.dragHint')}
        </span>
      </div>

      {loading ? (
        <div className="text-center text-zinc-500">{t('column.loading')}</div>
      ) : columns.length === 0 ? (
        <div className="text-center text-zinc-500">{t('column.noColumns')}</div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={sortedColumns.map((c) => c.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className="space-y-2">
              {sortedColumns.map((column) => (
                <SortableColumn
                  key={column.id}
                  column={column}
                  onEdit={(col) => {
                    setEditingColumn(col);
                    setNewColumnName(col.name);
                    setEditColumnColor(col.color || '#6b7280');
                    setEditColumnStatus(col.status || '');
                    setEditColumnDescription(col.description || '');
                    setEditColumnOwnerAgent(col.ownerAgentId || '');
                  }}
                  onDelete={handleDeleteColumn}
                  onPermission={handleOpenPermissionModal}
                  t={t}
                  canEdit={userBoardAccess === 'WRITE' || userBoardAccess === 'ADMIN' || currentUser?.role === 'ADMIN'}
                  canDelete={userBoardAccess === 'ADMIN' || currentUser?.role === 'ADMIN'}
                  canManagePermission={currentUser?.role === 'ADMIN'}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {showAddModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={() => setShowAddModal(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl border border-zinc-100"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-5 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-blue-600 text-white">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 5v14M5 12h14"/>
                </svg>
              </div>
              <h2 className="text-xl font-bold text-zinc-800">{t('modal.addColumn')}</h2>
            </div>

            <div className="space-y-5">
              <div>
                <label className="mb-2 block text-sm font-semibold text-zinc-700">
                  {t('column.columnName')}
                </label>
                <input
                  type="text"
                  value={newColumnName}
                  onChange={(e) => setNewColumnName(e.target.value)}
                  placeholder={t('column.namePlaceholder')}
                  className="w-full rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-zinc-800 placeholder-zinc-400 transition-all focus:border-blue-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                  autoFocus
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-semibold text-zinc-700">
                  {t('column.color')}
                </label>
                <div className="flex gap-3">
                  {[
                    { color: '#ef4444', name: t('column.colorRed') },
                    { color: '#f59e0b', name: t('column.colorOrange') },
                    { color: '#3b82f6', name: t('column.colorBlue') },
                    { color: '#22c55e', name: t('column.colorGreen') },
                    { color: '#8b5cf6', name: t('column.colorPurple') },
                    { color: '#6b7280', name: t('column.colorGray') },
                  ].map(({ color, name }) => (
                    <button
                      key={color}
                      type="button"
                      onClick={() => setNewColumnColor(color)}
                      className={`group relative h-10 w-10 rounded-xl transition-all hover:scale-110 ${
                        newColumnColor === color
                          ? 'ring-2 ring-offset-2 ring-blue-500 scale-110'
                          : 'hover:ring-2 hover:ring-zinc-300 hover:ring-offset-1'
                      }`}
                      style={{ backgroundColor: color }}
                      title={name}
                    />
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-8 flex gap-3">
              <button
                onClick={() => setShowAddModal(false)}
                className="flex-1 rounded-xl bg-zinc-100 px-4 py-3 font-medium text-zinc-600 hover:bg-zinc-200 transition-colors"
              >
                {t('column.cancel')}
              </button>
              <button
                onClick={handleAddColumn}
                disabled={!newColumnName.trim()}
                className="flex-1 rounded-xl bg-gradient-to-r from-blue-500 to-blue-600 px-4 py-3 font-medium text-white hover:from-blue-600 hover:to-blue-700 disabled:from-zinc-300 disabled:to-zinc-300 transition-all shadow-sm hover:shadow"
              >
                {t('column.addColumn')}
              </button>
            </div>
          </div>
        </div>
      )}

      {editingColumn && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={() => setEditingColumn(null)}
        >
          <div
            className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl border border-zinc-100"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-5 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-amber-500 to-orange-500 text-white">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
                </svg>
              </div>
              <h2 className="text-xl font-bold text-zinc-800">{t('modal.editColumn')}</h2>
            </div>

            <div className="space-y-5">
              <div>
                <label className="mb-2 block text-sm font-semibold text-zinc-700">
                  {t('column.columnName')}
                </label>
                <input
                  type="text"
                  value={newColumnName}
                  onChange={(e) => setNewColumnName(e.target.value)}
                  className="w-full rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-zinc-800 placeholder-zinc-400 transition-all focus:border-blue-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                  autoFocus
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-semibold text-zinc-700">
                  {t('column.statusCode')}
                </label>
                <input
                  type="text"
                  value={editColumnStatus}
                  onChange={(e) => setEditColumnStatus(e.target.value)}
                  placeholder={t('column.statusPlaceholder')}
                  className="w-full rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-zinc-800 placeholder-zinc-400 transition-all focus:border-blue-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                />
                <p className="mt-1.5 text-xs text-zinc-400">{t('column.statusCodeHint')}</p>
              </div>

              <div>
                <label className="mb-2 block text-sm font-semibold text-zinc-700">
                  {t('column.color')}
                </label>
                <div className="flex gap-3">
                  {[
                    { color: '#ef4444', name: t('column.colorRed') },
                    { color: '#f59e0b', name: t('column.colorOrange') },
                    { color: '#3b82f6', name: t('column.colorBlue') },
                    { color: '#22c55e', name: t('column.colorGreen') },
                    { color: '#8b5cf6', name: t('column.colorPurple') },
                    { color: '#6b7280', name: t('column.colorGray') },
                  ].map(({ color, name }) => (
                    <button
                      key={color}
                      type="button"
                      onClick={() => setEditColumnColor(color)}
                      className={`group relative h-10 w-10 rounded-xl transition-all hover:scale-110 ${
                        editColumnColor === color
                          ? 'ring-2 ring-offset-2 ring-blue-500 scale-110'
                          : 'hover:ring-2 hover:ring-zinc-300 hover:ring-offset-1'
                      }`}
                      style={{ backgroundColor: color }}
                      title={name}
                    />
                  ))}
                </div>
              </div>

              <div>
                <label className="mb-2 block text-sm font-semibold text-zinc-700">
                  {t('column.description')}
                </label>
                <textarea
                  value={editColumnDescription}
                  onChange={(e) => setEditColumnDescription(e.target.value)}
                  placeholder={t('column.descriptionPlaceholder')}
                  rows={3}
                  className="w-full rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-zinc-800 placeholder-zinc-400 transition-all focus:border-blue-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 resize-none"
                />
                <p className="mt-1.5 text-xs text-zinc-400">{t('column.descriptionHint')}</p>
              </div>

              <div>
                <label className="mb-2 block text-sm font-semibold text-zinc-700">
                  {t('column.ownerAgent')}
                </label>
                <select
                  value={editColumnOwnerAgent}
                  onChange={(e) => setEditColumnOwnerAgent(e.target.value)}
                  className="w-full rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-zinc-800 transition-all focus:border-blue-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                >
                  <option value="">{t('column.noOwnerAgent')}</option>
                  {agents.filter(a => a.type === 'AGENT').map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.nickname}
                    </option>
                  ))}
                </select>
                <p className="mt-1.5 text-xs text-zinc-400">{t('column.ownerAgentHint')}</p>
              </div>
            </div>

            <div className="mt-8 flex gap-3">
              <button
                onClick={() => setEditingColumn(null)}
                className="flex-1 rounded-xl bg-zinc-100 px-4 py-3 font-medium text-zinc-600 hover:bg-zinc-200 transition-colors"
              >
                {t('column.cancel')}
              </button>
              <button
                onClick={handleUpdateColumn}
                disabled={!newColumnName.trim()}
                className="flex-1 rounded-xl bg-gradient-to-r from-blue-500 to-blue-600 px-4 py-3 font-medium text-white hover:from-blue-600 hover:to-blue-700 disabled:from-zinc-300 disabled:to-zinc-300 transition-all shadow-sm hover:shadow"
              >
                {t('column.save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showDeleteModal && columnToDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={() => setShowDeleteModal(false)}
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
                {t('column.confirmDeleteMessage', { columnName: columnToDelete.name })}
              </p>
              {columnToDelete.taskCount > 0 && (
                <div className="p-3 bg-red-50 border border-red-100 rounded-xl">
                  <p className="text-sm text-red-600">
                    <span className="font-semibold">{columnToDelete.taskCount}</span> {t('column.tasksWillBeDeleted')}
                  </p>
                </div>
              )}
            </div>

            <div className="mt-8 flex gap-3">
              <button
                onClick={() => setShowDeleteModal(false)}
                className="flex-1 rounded-xl bg-zinc-100 px-4 py-3 font-medium text-zinc-600 hover:bg-zinc-200 transition-colors"
              >
                {t('column.cancel')}
              </button>
              <button
                onClick={confirmDeleteColumn}
                className="flex-1 rounded-xl bg-gradient-to-r from-red-500 to-red-600 px-4 py-3 font-medium text-white hover:from-red-600 hover:to-red-700 transition-all shadow-sm hover:shadow"
              >
                {t('column.delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showPermissionModal && permissionColumn && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={() => setShowPermissionModal(false)}
        >
          <div
            className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl border border-zinc-100 max-h-[80vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-5 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 text-white">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                </svg>
              </div>
              <div>
                <h2 className="text-xl font-bold text-zinc-800">{t('column.columnPermissions')}</h2>
                <p className="text-sm text-zinc-500">{permissionColumn.name}</p>
              </div>
            </div>

              {permissionLoading ? (
              <div className="py-8 text-center text-zinc-500">{t('common.loading')}</div>
            ) : (
              <>
                <div className="mb-4">
                  <h3 className="text-sm font-semibold text-zinc-700 mb-3">{t('column.currentPermissions')}</h3>
                  {columnPermissions.length === 0 ? (
                    <p className="text-sm text-zinc-400 py-4 text-center">{t('column.noPermissions')}</p>
                  ) : (
                    <div className="space-y-2">
                      {columnPermissions.map((perm) => (
                        <div key={perm.id} className="flex items-center justify-between p-3 bg-zinc-50 rounded-xl border border-zinc-100">
                          <div className="flex items-center gap-3">
                            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-violet-100 text-violet-600 text-xs font-bold">
                              {perm.access.charAt(0)}
                            </div>
                            <div>
                              <div className="text-sm font-medium text-zinc-800">{perm.columnName}</div>
                              <div className="text-xs text-zinc-400">{perm.access} - {t('column.permission.' + perm.access)}</div>
                            </div>
                          </div>
                          <button
                            onClick={() => handleDeleteColumnPermission(perm.id)}
                            className="rounded-lg px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                          >
                            {t('column.remove')}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="border-t border-zinc-100 pt-4">
                  <h3 className="text-sm font-semibold text-zinc-700 mb-3">{t('column.addPermission')}</h3>
                  <AddColumnPermissionForm
                    columnId={permissionColumn.id}
                    onPermissionAdded={() => {
                      if (permissionColumn) {
                        handleOpenPermissionModal(permissionColumn);
                      }
                    }}
                  />
                </div>
              </>
            )}

            <div className="mt-6 flex justify-end">
              <button
                onClick={() => setShowPermissionModal(false)}
                className="rounded-xl bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-200 transition-colors"
              >
                {t('common.close')}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 rounded-lg bg-zinc-800 px-4 py-2 text-sm text-white">
          {toast}
        </div>
      )}
      </div>
    </div>
  );
}
