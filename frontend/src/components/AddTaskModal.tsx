import { useState, useEffect } from 'react';
import { columnsApi } from '@/services/api';

interface Board {
  id: string;
  name: string;
}

interface AddTaskModalProps {
  isOpen: boolean;
  columnName?: string;
  currentBoardId?: string;
  boards?: Board[];
  onClose: () => void;
  onSubmit: (title: string, description: string, published: boolean, columnId?: string) => void;
}

export function AddTaskModal({
  isOpen,
  currentBoardId,
  boards = [],
  onClose,
  onSubmit,
}: AddTaskModalProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [isPublished, setIsPublished] = useState(true);
  const [selectedBoardId, setSelectedBoardId] = useState(currentBoardId || '');
  const [columns, setColumns] = useState<{ id: string; name: string }[]>([]);
  const [selectedColumnId, setSelectedColumnId] = useState('');

  useEffect(() => {
    if (selectedBoardId && isOpen) {
      columnsApi.getByBoard(selectedBoardId).then((data) => {
        setColumns(data);
        const todoCol = data.find((c) => c.name === '待办');
        setSelectedColumnId(todoCol?.id || data[0]?.id || '');
      });
    }
  }, [selectedBoardId, isOpen]);

  useEffect(() => {
    if (isOpen) {
      setTitle('');
      setDescription('');
      setIsPublished(true);
      setSelectedBoardId(currentBoardId || '');
    }
  }, [isOpen, currentBoardId]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (title.trim()) {
      onSubmit(title.trim(), description.trim(), isPublished, selectedColumnId);
      setTitle('');
      setDescription('');
      setIsPublished(false);
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" />

      <div className="relative z-10 w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
        <h2 className="mb-4 text-lg font-semibold text-zinc-800">添加任务</h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="输入任务标题"
              className="w-full rounded-md border border-zinc-200 px-4 py-3 text-base focus:border-blue-500 focus:outline-none"
            />
          </div>

          <div>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="输入任务描述（可选，支持 Markdown）"
              rows={4}
              className="w-full rounded-md border border-zinc-200 px-4 py-3 text-base focus:border-blue-500 focus:outline-none resize-none"
            />
          </div>

          {boards.length > 0 && (
            <div>
              <label className="mb-1 block text-sm font-medium text-zinc-700">选择看板</label>
              <select
                value={selectedBoardId}
                onChange={(e) => setSelectedBoardId(e.target.value)}
                className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
              >
                {boards.map((board) => (
                  <option key={board.id} value={board.id}>
                    {board.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {columns.length > 0 && (
            <div>
              <label className="mb-1 block text-sm font-medium text-zinc-700">选择列</label>
              <select
                value={selectedColumnId}
                onChange={(e) => setSelectedColumnId(e.target.value)}
                className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm"
              >
                {columns.map((col) => (
                  <option key={col.id} value={col.id}>
                    {col.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <label className="flex cursor-pointer items-center gap-2 text-sm text-zinc-600">
            <input
              type="checkbox"
              checked={isPublished}
              onChange={(e) => setIsPublished(e.target.checked)}
              className="h-4 w-4 rounded border-zinc-200"
            />
            发布到看板（不勾选则保存为草稿）
          </label>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-md bg-zinc-100 px-4 py-2.5 text-base font-medium text-zinc-700 hover:bg-zinc-200"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={!title.trim()}
              className="flex-1 rounded-md bg-blue-500 px-4 py-2.5 text-base font-medium text-white hover:bg-blue-600 disabled:bg-zinc-300"
            >
              添加
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
