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
} from '@dnd-kit/sortable';
import { boardsApi, columnsApi, authApi } from '@/services/api';
import { ColumnCard } from '@/components/ColumnCard';
import { AddColumnModal } from '@/components/AddColumnModal';
import { EditColumnModal } from '@/components/EditColumnModal';
import { DeleteColumnModal } from '@/components/DeleteColumnModal';
import { ColumnPermissionsModal } from '@/components/ColumnPermissionsModal';
import type { Agent, Column } from '@/types/kanban';

interface Board {
  id: string;
  name: string;
}

export function ColumnsPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const boardIdFromUrl = searchParams.get('boardId');

  const [boards, setBoards] = useState<Board[]>([]);
  const [selectedBoard, setSelectedBoard] = useState<Board | null>(null);
  const [columns, setColumns] = useState<Column[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newColumnName, setNewColumnName] = useState('');
  const [newColumnColor, setNewColumnColor] = useState('#6b7280');
  const [editingColumn, setEditingColumn] = useState<Column | null>(null);
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
  const [permissionColumn, setPermissionColumn] = useState<Column | null>(null);
  const [columnPermissions, setColumnPermissions] = useState<Array<{ id: string; columnId: string; columnName: string; access: string; userId: string; userNickname: string }>>([]);
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
      const targetBoard = boardIdFromUrl
        ? boards.find(b => b.id === boardIdFromUrl)
        : null;

      if (targetBoard) {
        if (targetBoard.id !== selectedBoard?.id) {
          setSelectedBoard(targetBoard);
        }
      } else if (!selectedBoard) {
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

  const handleOpenPermissionModal = async (column: Column) => {
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
                <ColumnCard
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
                  canEdit={userBoardAccess === 'WRITE' || userBoardAccess === 'ADMIN' || currentUser?.role === 'ADMIN'}
                  canDelete={userBoardAccess === 'ADMIN' || currentUser?.role === 'ADMIN'}
                  canManagePermission={currentUser?.role === 'ADMIN'}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      <AddColumnModal
        isOpen={showAddModal}
        newColumnName={newColumnName}
        newColumnColor={newColumnColor}
        onClose={() => setShowAddModal(false)}
        onAdd={handleAddColumn}
        onNameChange={setNewColumnName}
        onColorChange={setNewColumnColor}
      />

      <EditColumnModal
        isOpen={!!editingColumn}
        column={editingColumn}
        name={newColumnName}
        color={editColumnColor}
        status={editColumnStatus}
        description={editColumnDescription}
        ownerAgent={editColumnOwnerAgent}
        agents={agents}
        onClose={() => {
          setEditingColumn(null);
          setNewColumnName('');
          setEditColumnColor('#6b7280');
          setEditColumnStatus('');
          setEditColumnDescription('');
          setEditColumnOwnerAgent('');
        }}
        onSave={handleUpdateColumn}
        onNameChange={setNewColumnName}
        onColorChange={setEditColumnColor}
        onStatusChange={setEditColumnStatus}
        onDescriptionChange={setEditColumnDescription}
        onOwnerAgentChange={setEditColumnOwnerAgent}
      />

      <DeleteColumnModal
        isOpen={showDeleteModal}
        column={columnToDelete}
        onClose={() => {
          setShowDeleteModal(false);
          setColumnToDelete(null);
        }}
        onConfirm={confirmDeleteColumn}
      />

      <ColumnPermissionsModal
        isOpen={showPermissionModal}
        column={permissionColumn}
        permissions={columnPermissions}
        loading={permissionLoading}
        onClose={() => {
          setShowPermissionModal(false);
          setPermissionColumn(null);
        }}
        onDeletePermission={handleDeleteColumnPermission}
        onPermissionAdded={() => {
          if (permissionColumn) {
            handleOpenPermissionModal(permissionColumn);
          }
        }}
      />

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 rounded-lg bg-zinc-800 px-4 py-2 text-sm text-white">
          {toast}
        </div>
      )}
      </div>
    </div>
  );
}
