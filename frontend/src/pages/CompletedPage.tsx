import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import type { Task } from '@/types/kanban';
import { boardsApi, columnsApi, tasksApi } from '@/services/api';

const priorityColors: Record<string, string> = {
  high: 'bg-red-100 text-red-700',
  medium: 'bg-yellow-100 text-yellow-700',
  low: 'bg-green-100 text-green-700',
};

export function CompletedPage() {
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
      setBoards(data);
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
        .filter((c) => c.name === '已完成')
        .flatMap((c) => c.tasks || [])
        .map((t: Task) => {
          const boardId = t.columnId?.split('_')[0] || '';
          const board = boards.find((b) => b.id === boardId);
          return {
            ...t,
            columnName: '已完成',
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
      setToast('请先选择任务');
      setTimeout(() => setToast(null), 2000);
      return;
    }

    try {
      await Promise.all(
        Array.from(selectedTasks).map((taskId) =>
          tasksApi.archive(taskId, true)
        )
      );
      setToast(`已归档 ${selectedTasks.size} 个任务`);
      setSelectedTasks(new Set());
      fetchTasks();
      setTimeout(() => setToast(null), 2000);
    } catch (err) {
      console.error('Failed to batch archive:', err);
      setToast('归档失败');
      setTimeout(() => setToast(null), 2000);
    }
  };

  const batchDelete = async () => {
    if (selectedTasks.size === 0) {
      setToast('请先选择任务');
      setTimeout(() => setToast(null), 2000);
      return;
    }

    if (!confirm(`确定要删除选中的 ${selectedTasks.size} 个任务吗？此操作不可恢复。`)) {
      return;
    }

    try {
      await Promise.all(
        Array.from(selectedTasks).map((taskId) => tasksApi.delete(taskId))
      );
      setToast(`已删除 ${selectedTasks.size} 个任务`);
      setSelectedTasks(new Set());
      fetchTasks();
      setTimeout(() => setToast(null), 2000);
    } catch (err) {
      console.error('Failed to batch delete:', err);
      setToast('删除失败');
      setTimeout(() => setToast(null), 2000);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-100 p-6">
      <header className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-bold text-zinc-800">已完成任务管理</h1>
        </div>
        <Link
          to="/"
          className="rounded-md bg-zinc-200 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-300"
        >
          返回看板
        </Link>
      </header>

      <div className="mb-4 flex items-center gap-4">
        <select
          value={boardFilter}
          onChange={(e) => setBoardFilter(e.target.value)}
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm"
        >
          <option value="all">所有看板</option>
          {boards.map((board) => (
            <option key={board.id} value={board.id}>{board.name}</option>
          ))}
        </select>

        <div className="flex-1" />

        <span className="text-sm text-zinc-500">
          已选择 {selectedTasks.size} / {tasks.length} 个任务
        </span>

        <button
          onClick={toggleSelectAll}
          className="rounded-md bg-zinc-200 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-300"
        >
          {selectedTasks.size === tasks.length ? '取消全选' : '全选'}
        </button>

        <button
          onClick={batchArchive}
          className="rounded-md bg-orange-500 px-3 py-2 text-sm text-white hover:bg-orange-600"
        >
          批量归档
        </button>

        <button
          onClick={batchDelete}
          className="rounded-md bg-red-500 px-3 py-2 text-sm text-white hover:bg-red-600"
        >
          批量删除
        </button>
      </div>

      {loading ? (
        <div className="text-center text-zinc-500">加载中...</div>
      ) : tasks.length === 0 ? (
        <div className="text-center text-zinc-500">没有已完成的任务</div>
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
                    {task.priority === 'high' ? '高' : task.priority === 'medium' ? '中' : '低'}
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
                查看
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
