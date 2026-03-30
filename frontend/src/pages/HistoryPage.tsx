import { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { Task, Board, User } from '@/types/kanban';
import { archivedApi, tasksApi, boardsApi, authApi } from '@/services/api';

const priorityColors: Record<string, string> = {
  high: 'bg-red-100 text-red-700',
  medium: 'bg-yellow-100 text-yellow-700',
  low: 'bg-green-100 text-green-700',
};

export function HistoryPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const boardIdFromUrl = searchParams.get('boardId');

  const [tasks, setTasks] = useState<Task[]>([]);
  const [boards, setBoards] = useState<Board[]>([]);
  const [selectedBoard, setSelectedBoard] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<User | null>(null);

  useEffect(() => {
    fetchBoards();
    fetchCurrentUser();
  }, []);

  useEffect(() => {
    if (boards.length > 0) {
      // If boardId is in URL, use it; otherwise use first board
      const targetBoardId = boardIdFromUrl && boards.find(b => b.id === boardIdFromUrl)
        ? boardIdFromUrl
        : boards[0].id;

      if (targetBoardId !== selectedBoard) {
        setSelectedBoard(targetBoardId);
        fetchTasks(targetBoardId);
      }
    }
  }, [boards, boardIdFromUrl]);

  const fetchBoards = async () => {
    try {
      const data = await boardsApi.getAll();
      setBoards(data || []);
    } catch (err) {
      console.error('Failed to fetch boards:', err);
      setError(err instanceof Error ? err.message : t('history.loadFailed'));
    }
  };

  const fetchCurrentUser = async () => {
    try {
      const meData = await authApi.me();
      if (meData.user) {
        setCurrentUser(meData.user);
      }
    } catch (err) {
      console.error('Failed to fetch current user:', err);
    }
  };

  const fetchTasks = async (boardId: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await archivedApi.getByBoard(boardId);
      setTasks(data || []);
    } catch (err) {
      console.error('Failed to fetch archived tasks:', err);
      setError(err instanceof Error ? err.message : t('history.loadFailed'));
    } finally {
      setLoading(false);
    }
  };

  const handleBoardChange = (boardId: string) => {
    setSearchParams({ boardId });
    setSelectedBoard(boardId);
    fetchTasks(boardId);
  };

  const handleRestore = async (taskId: string) => {
    try {
      await tasksApi.archive(taskId, false);
      setTasks((prev) => prev.filter((t) => t.id !== taskId));
    } catch (err) {
      console.error('Failed to restore task:', err);
    }
  };

  if (loading && boards.length === 0) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-zinc-500">{t('history.loading')}</div>
      </div>
    );
  }

  if (!currentUser) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-zinc-500">{t('history.loading')}</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4">
        <div className="text-red-500">{t('history.loadFailed')}</div>
        <div className="text-sm text-zinc-400">{error}</div>
        <button
          onClick={() => selectedBoard && fetchTasks(selectedBoard)}
          className="rounded-md bg-blue-500 px-4 py-2 text-sm text-white hover:bg-blue-600"
        >
          {t('history.retry')}
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-100 p-6">
      <header className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link
            to="/"
            className="rounded-md bg-zinc-200 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-300"
          >
            {t('history.backToBoard')}
          </Link>
          <h1 className="text-2xl font-bold text-zinc-800">{t('history.title')}</h1>
          {boards.length > 0 && (
            <select
              value={selectedBoard}
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
          {currentUser.role === 'ADMIN' && (
            <Link
              to="/activities"
              className="rounded-md bg-blue-50 px-4 py-2 text-sm text-blue-700 hover:bg-blue-100"
            >
              {t('nav.activityLog')}
            </Link>
          )}
        </div>
        <span className="text-sm text-zinc-500">{t('history.archivedCount', { count: tasks.length })}</span>
      </header>

      {loading ? (
<div className="flex h-64 items-center justify-center">
          <div className="text-zinc-500">{t('history.loading')}</div>
        </div>
      ) : tasks.length === 0 ? (
        <div className="rounded-lg bg-white p-8 text-center text-zinc-500">
          {t('history.empty')}
        </div>
      ) : (
        <div className="flex flex-wrap gap-4">
          {tasks.map((task) => (
            <div
              key={task.id}
              className="group relative w-80 cursor-grab rounded-lg bg-white p-3 shadow-sm transition-all hover:shadow-md"
            >
              <div className="absolute left-1 top-1/2 -translate-y-1/2 flex flex-col gap-0.5 opacity-0 group-hover:opacity-100">
                <span className="h-0.5 w-1 rounded-full bg-zinc-400" />
                <span className="h-0.5 w-1 rounded-full bg-zinc-400" />
                <span className="h-0.5 w-1 rounded-full bg-zinc-400" />
              </div>

              <div className="flex items-start justify-between gap-2 pl-3">
                <div className="flex-1">
                  <span className="mb-1 block text-xs text-zinc-400 font-mono">#{task.id.slice(-6)}</span>
                  <h3 className="font-medium text-zinc-800">{task.title}</h3>
                </div>
              </div>

              {task.description && (
                <p className="mb-2 text-sm text-zinc-500 line-clamp-2 pl-3">
                  {task.description}
                </p>
              )}

              {task.subtasks && task.subtasks.length > 0 && (
                <div className="mb-2 space-y-1 pl-3">
                  {task.subtasks.slice(0, 3).map((subtask) => (
                    <div key={subtask.id} className="flex items-center gap-1.5 text-xs">
                      <span className={`h-1.5 w-1.5 rounded-full ${subtask.completed ? 'bg-green-500' : 'bg-zinc-300'}`} />
                      <span className={subtask.completed ? 'text-zinc-400 line-through' : 'text-zinc-600'}>
                        {subtask.title}
                      </span>
                    </div>
                  ))}
                  {task.subtasks.length > 3 && (
                    <span className="text-xs text-zinc-400">{t('history.moreSubtasks', { count: task.subtasks.length - 3 })}</span>
                  )}
                </div>
              )}

              <div className="flex items-center justify-between pl-3">
                <div className="flex items-center gap-2">
                  <span className={`rounded px-2 py-0.5 text-xs font-medium ${priorityColors[task.priority] || priorityColors.medium}`}>
                    {t(`task.priority.${task.priority}`)}
                  </span>
                  {task.subtasks && task.subtasks.length > 0 && (
                    <span className="text-xs text-zinc-400">
                      ✓ {task.subtasks.filter((s) => s.completed).length}/{task.subtasks.length}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {task.comments && task.comments.length > 0 && (
                    <span className="text-xs text-zinc-400">💬 {task.comments.length}</span>
                  )}
                </div>
              </div>

              <div className="mt-2 border-t pt-2 pl-3">
                <div className="flex items-center justify-between text-xs text-zinc-400">
                  <span>{t('history.archivedAt')} {task.archivedAt ? new Date(task.archivedAt).toLocaleString() : '-'}</span>
                  <button
                    onClick={() => handleRestore(task.id)}
                    className="text-blue-500 hover:text-blue-600"
                  >
                    {t('history.recover')}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
