import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import type { Task } from '@/types/kanban';
import { boardsApi, columnsApi, tasksApi } from '@/services/api';

const priorityColors: Record<string, string> = {
  high: 'bg-red-100 text-red-700',
  medium: 'bg-yellow-100 text-yellow-700',
  low: 'bg-green-100 text-green-700',
};

export function CompletedPage() {
  const { t } = useTranslation();
  const [tasks, setTasks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTasks, setSelectedTasks] = useState<Set<string>>(new Set());
  const [boardFilter, setBoardFilter] = useState<string>('all');
  const [boards, setBoards] = useState<{ id: string; name: string }[]>([]);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    fetchBoards();
  }, []);

  useEffect(() => {
    fetchTasks();
  }, [boardFilter]);

  const fetchBoards = async () => {
    try {
      const data = await boardsApi.getAll();
      setBoards(data || []);
    } catch (err) {
      console.error('Failed to fetch boards:', err);
    }
  };

  const fetchTasks = async () => {
    setLoading(true);
    try {
      const allColumns: any[] = [];

      if (boardFilter === 'all') {
        for (const board of boards.length > 0 ? boards : [{ id: '' }]) {
          if (!board.id) continue;
          const cols = await columnsApi.getByBoard(board.id);
          allColumns.push(...cols);
        }
      } else {
        const cols = await columnsApi.getByBoard(boardFilter);
        allColumns.push(...cols);
      }

      const completedTasks = allColumns
        .filter((c) => c.name === t('task.status.done'))
        .flatMap((c) => c.tasks || [])
        .map((task: Task) => {
          const boardId = task.columnId?.split('_')[0] || '';
          const board = boards.find((b) => b.id === boardId);
          return {
            ...task,
            columnName: t('task.status.done'),
            boardName: board?.name || boardId,
          };
        });

      setTasks(completedTasks);
    } catch (err) {
      console.error('Failed to fetch tasks:', err);
    } finally {
      setLoading(false);
    }
  };

  const toggleSelect = (taskId: string) => {
    const newSelected = new Set(selectedTasks);
    if (newSelected.has(taskId)) {
      newSelected.delete(taskId);
    } else {
      newSelected.add(taskId);
    }
    setSelectedTasks(newSelected);
  };

  const toggleSelectAll = () => {
    if (selectedTasks.size === tasks.length) {
      setSelectedTasks(new Set());
    } else {
      setSelectedTasks(new Set(tasks.map((t) => t.id)));
    }
  };

  const batchArchive = async () => {
    if (selectedTasks.size === 0) {
      setToast(t('completed.selectTaskFirst'));
      setTimeout(() => setToast(null), 2000);
      return;
    }

    try {
      await Promise.all(
        Array.from(selectedTasks).map((taskId) =>
          tasksApi.archive(taskId, true)
        )
      );
      setToast(t('completed.archivedCount', { count: selectedTasks.size }));
      setSelectedTasks(new Set());
      fetchTasks();
      setTimeout(() => setToast(null), 2000);
    } catch (err) {
      console.error('Failed to batch archive:', err);
      setToast(t('completed.archiveFailed'));
      setTimeout(() => setToast(null), 2000);
    }
  };

  const batchDelete = async () => {
    if (selectedTasks.size === 0) {
      setToast(t('completed.selectTaskFirst'));
      setTimeout(() => setToast(null), 2000);
      return;
    }

    if (!confirm(t('completed.confirmDelete', { count: selectedTasks.size }))) {
      return;
    }

    try {
      await Promise.all(
        Array.from(selectedTasks).map((taskId) => tasksApi.delete(taskId))
      );
      setToast(t('completed.deletedCount', { count: selectedTasks.size }));
      setSelectedTasks(new Set());
      fetchTasks();
      setTimeout(() => setToast(null), 2000);
    } catch (err) {
      console.error('Failed to batch delete:', err);
      setToast(t('completed.deleteFailed'));
      setTimeout(() => setToast(null), 2000);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-100 p-6">
      <header className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-bold text-zinc-800">{t('completed.title')}</h1>
        </div>
        <Link
          to="/"
          className="rounded-md bg-zinc-200 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-300"
        >
          {t('completed.backToBoard')}
        </Link>
      </header>

      <div className="mb-4 flex items-center gap-4">
        <select
          value={boardFilter}
          onChange={(e) => setBoardFilter(e.target.value)}
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm"
        >
          <option value="all">{t('filter.all')}</option>
          {boards.map((board) => (
            <option key={board.id} value={board.id}>{board.name}</option>
          ))}
        </select>

        <div className="flex-1" />

        <span className="text-sm text-zinc-500">
          {t('completed.selectedCount', { selected: selectedTasks.size, total: tasks.length })}
        </span>

        <button
          onClick={toggleSelectAll}
          className="rounded-md bg-zinc-200 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-300"
        >
          {selectedTasks.size === tasks.length ? t('completed.deselectAll') : t('completed.selectAll')}
        </button>

        <button
          onClick={batchArchive}
          className="rounded-md bg-orange-500 px-3 py-2 text-sm text-white hover:bg-orange-600"
        >
          {t('completed.batchArchive')}
        </button>

        <button
          onClick={batchDelete}
          className="rounded-md bg-red-500 px-3 py-2 text-sm text-white hover:bg-red-600"
        >
          {t('completed.batchDelete')}
        </button>
      </div>

      {loading ? (
        <div className="text-center text-zinc-500">{t('completed.loading')}</div>
      ) : tasks.length === 0 ? (
        <div className="text-center text-zinc-500">{t('completed.empty')}</div>
      ) : (
        <div className="space-y-2">
          {tasks.map((task) => (
            <div
              key={task.id}
              className={`flex items-center gap-4 rounded-lg bg-white p-4 shadow ${
                selectedTasks.has(task.id) ? 'ring-2 ring-blue-500' : ''
              }`}
            >
              <input
                type="checkbox"
                checked={selectedTasks.has(task.id)}
                onChange={() => toggleSelect(task.id)}
                className="h-5 w-5 rounded border-zinc-300"
              />

              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-zinc-800">{task.title}</span>
                  <span className={`rounded px-2 py-0.5 text-xs font-medium ${
                    priorityColors[task.priority] || 'bg-zinc-100 text-zinc-700'
                  }`}>
                    {t(`task.priority.${task.priority}`)}
                  </span>
                  <span className="rounded bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600">
                    {task.boardName}
                  </span>
                </div>
                {task.description && (
                  <div className="mt-1 text-sm text-zinc-500 line-clamp-2">
                    <ReactMarkdown>{task.description}</ReactMarkdown>
                  </div>
                )}
                <div className="mt-1 text-xs text-zinc-400">
                  ID: {task.id}
                </div>
              </div>

              <Link
                to="/"
                className="rounded-md bg-zinc-100 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-200"
              >
                {t('task.enter')}
              </Link>
            </div>
          ))}
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
