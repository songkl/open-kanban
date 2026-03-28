import { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
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
import { boardsApi, columnsApi } from '@/services/api';

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
  boardId: string;
}

function SortableColumn({
  column,
  onEdit,
  onDelete,
}: {
  column: ColumnData;
  onEdit: (column: ColumnData) => void;
  onDelete: (columnId: string) => void;
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
      className="flex items-center gap-4 rounded-lg bg-white p-4 shadow"
    >
      <button
        {...attributes}
        {...listeners}
        className="cursor-grab text-zinc-400 hover:text-zinc-600 active:cursor-grabbing"
        title="拖动排序"
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
        className="h-4 w-4 rounded-full"
        style={{ backgroundColor: column.color }}
      />
      <span className="flex-1 font-medium text-zinc-800">{column.name}</span>
      <span className="rounded bg-zinc-100 px-2 py-0.5 text-xs text-zinc-500">状态: {column.status || '无'}</span>
      <span className="text-sm text-zinc-400">位置: {column.position}</span>
      <button
        onClick={() => onEdit(column)}
        className="rounded-md bg-zinc-100 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-200"
      >
        编辑
      </button>
      <button
        onClick={() => onDelete(column.id)}
        className="rounded-md bg-red-100 px-3 py-1.5 text-sm text-red-600 hover:bg-red-200"
      >
        删除
      </button>
    </div>
  );
}

export function ColumnsPage() {
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
  const [toast, setToast] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  useEffect(() => {
    fetchBoards();
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
      // Only update URL if it doesn't match selected board
      if (boardIdFromUrl !== selectedBoard.id) {
        setSearchParams({ boardId: selectedBoard.id });
      }
    }
  }, [selectedBoard?.id]);

  const fetchBoards = async () => {
    try {
      const data = await boardsApi.getAll();
      setBoards(data);
    } catch (err) {
      console.error('Failed to fetch boards:', err);
    } finally {
      setLoading(false);
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
        await fetch('/api/columns/reorder', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            boardId: selectedBoard!.id,
            columns: newColumns.map((col) => ({ id: col.id, position: col.position })),
          }),
        });
        showToastMessage('排序已保存');
      } catch (err) {
        console.error('Failed to save reorder:', err);
        showToastMessage('保存排序失败');
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
      });

      showToastMessage('列添加成功');
      setNewColumnName('');
      setShowAddModal(false);
      fetchColumns(selectedBoard.id);
    } catch (err) {
      console.error('Failed to add column:', err);
      showToastMessage('添加失败');
    }
  };

  const handleUpdateColumn = async () => {
    if (!editingColumn || !newColumnName.trim()) return;

    try {
      await columnsApi.update(editingColumn.id, {
        name: newColumnName.trim(),
        color: editColumnColor,
      });

      showToastMessage('列更新成功');
      setEditingColumn(null);
      setNewColumnName('');
      setEditColumnColor('#6b7280');
      fetchColumns(selectedBoard!.id);
    } catch (err) {
      console.error('Failed to update column:', err);
      showToastMessage('更新失败');
    }
  };

  const handleDeleteColumn = async (columnId: string) => {
    if (!confirm('确定要删除这列吗？该列的任务也会被删除。')) return;

    try {
      await columnsApi.delete(columnId);
      showToastMessage('列已删除');
      fetchColumns(selectedBoard!.id);
    } catch (err) {
      console.error('Failed to delete column:', err);
      showToastMessage('删除失败');
    }
  };

  const sortedColumns = [...columns].sort((a, b) => a.position - b.position);

  if (loading && columns.length === 0) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-zinc-500">加载中...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-100 p-6">
      <header className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-bold text-zinc-800">列管理</h1>
          {boards.length > 1 && (
            <select
              value={selectedBoard?.id || boardIdFromUrl || ''}
              onChange={(e) => handleBoardChange(e.target.value)}
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm"
            >
              {boards.map((board) => (
                <option key={board.id} value={board.id}>
                  {board.name}
                </option>
              ))}
            </select>
          )}
          {selectedBoard && boards.length <= 1 && (
            <span className="text-sm text-zinc-500">{selectedBoard.name}</span>
          )}
        </div>
        <Link
          to="/"
          className="rounded-md bg-zinc-200 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-300"
        >
          返回看板
        </Link>
      </header>

      <div className="mb-4 flex items-center gap-4">
        <button
          type="button"
          onClick={() => setShowAddModal(true)}
          className="rounded-md bg-blue-500 px-4 py-2 text-sm text-white hover:bg-blue-600"
        >
          + 添加列
        </button>
        <span className="text-sm text-zinc-500">💡 拖动手柄可调整列顺序</span>
      </div>

      {loading ? (
        <div className="text-center text-zinc-500">加载中...</div>
      ) : columns.length === 0 ? (
        <div className="text-center text-zinc-500">该看板没有列</div>
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
                  }}
                  onDelete={handleDeleteColumn}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {showAddModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setShowAddModal(false)}
        >
          <div
            className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="mb-4 text-lg font-semibold text-zinc-800">添加列</h2>

            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-zinc-700">
                  列名称
                </label>
                <input
                  type="text"
                  value={newColumnName}
                  onChange={(e) => setNewColumnName(e.target.value)}
                  placeholder="例如：待测试"
                  className="w-full rounded-md border border-zinc-300 px-3 py-2"
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-zinc-700">
                  颜色
                </label>
                <div className="flex gap-2">
                  {[
                    '#ef4444',
                    '#f59e0b',
                    '#3b82f6',
                    '#22c55e',
                    '#8b5cf6',
                    '#6b7280',
                  ].map((color) => (
                    <button
                      key={color}
                      type="button"
                      onClick={() => setNewColumnColor(color)}
                      className={`h-8 w-8 rounded-full ${
                        newColumnColor === color
                          ? 'ring-2 ring-offset-2 ring-zinc-400'
                          : ''
                      }`}
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-6 flex gap-3">
              <button
                onClick={() => setShowAddModal(false)}
                className="flex-1 rounded-md bg-zinc-100 px-4 py-2 text-zinc-700 hover:bg-zinc-200"
              >
                取消
              </button>
              <button
                onClick={handleAddColumn}
                disabled={!newColumnName.trim()}
                className="flex-1 rounded-md bg-blue-500 px-4 py-2 text-white hover:bg-blue-600 disabled:bg-zinc-300"
              >
                添加
              </button>
            </div>
          </div>
        </div>
      )}

      {editingColumn && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setEditingColumn(null)}
        >
          <div
            className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="mb-4 text-lg font-semibold text-zinc-800">编辑列</h2>

            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-zinc-700">
                  列名称
                </label>
                <input
                  type="text"
                  value={newColumnName}
                  onChange={(e) => setNewColumnName(e.target.value)}
                  className="w-full rounded-md border border-zinc-300 px-3 py-2"
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-zinc-700">
                  状态码
                </label>
                <input
                  type="text"
                  value={editingColumn?.status || ''}
                  disabled
                  className="w-full cursor-not-allowed rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-zinc-500"
                />
                <p className="mt-1 text-xs text-zinc-400">状态码由系统生成，无法修改</p>
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-zinc-700">
                  颜色
                </label>
                <div className="flex gap-2">
                  {[
                    '#ef4444',
                    '#f59e0b',
                    '#3b82f6',
                    '#22c55e',
                    '#8b5cf6',
                    '#6b7280',
                  ].map((color) => (
                    <button
                      key={color}
                      type="button"
                      onClick={() => setEditColumnColor(color)}
                      className={`h-8 w-8 rounded-full ${
                        editColumnColor === color
                          ? 'ring-2 ring-offset-2 ring-zinc-400'
                          : ''
                      }`}
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-6 flex gap-3">
              <button
                onClick={() => setEditingColumn(null)}
                className="flex-1 rounded-md bg-zinc-100 px-4 py-2 text-zinc-700 hover:bg-zinc-200"
              >
                取消
              </button>
              <button
                onClick={handleUpdateColumn}
                disabled={!newColumnName.trim()}
                className="flex-1 rounded-md bg-blue-500 px-4 py-2 text-white hover:bg-blue-600 disabled:bg-zinc-300"
              >
                保存
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
  );
}
