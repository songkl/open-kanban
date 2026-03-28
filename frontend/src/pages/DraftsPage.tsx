import { useState, useEffect, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { Task, Board } from '@/types/kanban';
import { draftsApi, columnsApi, boardsApi, tasksApi } from '@/services/api';

export function DraftsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const boardIdFromUrl = searchParams.get('boardId');

  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [publishTaskId, setPublishTaskId] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [targetColumn, setTargetColumn] = useState('');
  const [columns, setColumns] = useState<{ id: string; name: string }[]>([]);
  const [boards, setBoards] = useState<Board[]>([]);
  const [selectedBoard, setSelectedBoard] = useState<string>('');
  const [publishTargetColumn, setPublishTargetColumn] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchBoards();
  }, []);

  useEffect(() => {
    if (boards.length > 0) {
      // If boardId is in URL, use it; otherwise use first board
      const targetBoardId = boardIdFromUrl && boards.find(b => b.id === boardIdFromUrl)
        ? boardIdFromUrl
        : boards[0].id;

      if (targetBoardId !== selectedBoard) {
        setSelectedBoard(targetBoardId);
        fetchColumnsByBoard(targetBoardId, true);
        fetchTasks(targetBoardId);
      }
    }
  }, [boards, boardIdFromUrl]);

  const fetchTasks = async (boardId: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await draftsApi.getByBoard(boardId);
      setTasks(data);
    } catch (err) {
      console.error('Failed to fetch drafts:', err);
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  };

  const fetchBoards = async () => {
    setLoading(true);
    try {
      const data = await boardsApi.getAll();
      setBoards(data);
    } catch (err) {
      console.error('Failed to fetch boards:', err);
      setError(err instanceof Error ? err.message : '加载看板失败');
      setLoading(false);
    }
  };

  const handleBoardChange = (boardId: string) => {
    setSearchParams({ boardId });
    setSelectedBoard(boardId);
    fetchColumnsByBoard(boardId, true);
    fetchTasks(boardId);
  };

  const fetchColumnsByBoard = async (boardId: string, setTarget = false) => {
    try {
      const data = await columnsApi.getByBoard(boardId);
      setColumns(data);
      if (data.length > 0) {
        setPublishTargetColumn(data[0].id);
        if (setTarget) setTargetColumn(data[0].id);
      } else {
        setPublishTargetColumn('');
        if (setTarget) setTargetColumn('');
      }
    } catch (err) {
      console.error('Failed to fetch columns:', err);
    }
  };

  useEffect(() => {
    if (showAddModal && inputRef.current) {
      setNewTitle('');
      setNewDescription('');
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [showAddModal]);

  const handleAddTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) return;

    try {
      const newTask = await tasksApi.create({
        title: newTitle.trim(),
        description: newDescription.trim(),
        columnId: targetColumn,
        position: 9999,
        published: false,
      });
      setTasks((prev) => [newTask, ...prev]);
      setShowAddModal(false);
      setNewTitle('');
      setNewDescription('');
    } catch (err) {
      console.error('Failed to create draft:', err);
    }
  };

  const handlePublishClick = (taskId: string) => {
    setPublishTaskId(taskId);
  };

  const handlePublish = async () => {
    if (!publishTaskId || !publishTargetColumn) {
      alert('请选择目标看板和列');
      return;
    }
    try {
      await tasksApi.update(publishTaskId, { columnId: publishTargetColumn });
      await tasksApi.update(publishTaskId, { published: true });
      setTasks((prev) => prev.filter((t) => t.id !== publishTaskId));
      setPublishTaskId(null);
    } catch (err) {
      console.error('Failed to publish task:', err);
    }
  };

  const handleDelete = async (taskId: string) => {
    if (!confirm('确定要删除这个草稿吗？')) return;
    try {
      await tasksApi.delete(taskId);
      setTasks((prev) => prev.filter((t) => t.id !== taskId));
    } catch (err) {
      console.error('Failed to delete draft:', err);
    }
  };

  const handleEdit = (task: Task) => {
    setEditingTask(task);
    setNewTitle(task.title);
    setNewDescription(task.description || '');
    setTargetColumn(task.columnId);
    setTimeout(() => editInputRef.current?.focus(), 100);
  };

  const handleUpdateTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingTask || !newTitle.trim()) return;

    try {
      const updated = await tasksApi.update(editingTask.id, {
        title: newTitle.trim(),
        description: newDescription.trim(),
        columnId: targetColumn,
      });
      setTasks((prev) =>
        prev.map((t) => t.id === editingTask.id ? { ...t, ...updated } : t)
      );
      setEditingTask(null);
      setNewTitle('');
      setNewDescription('');
    } catch (err) {
      console.error('Failed to update draft:', err);
    }
  };

  if (loading && boards.length === 0) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-zinc-500">加载中...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4">
        <div className="text-red-500">加载失败</div>
        <div className="text-sm text-zinc-400">{error}</div>
        <button
          onClick={() => selectedBoard && fetchTasks(selectedBoard)}
          className="rounded-md bg-blue-500 px-4 py-2 text-sm text-white hover:bg-blue-600"
        >
          重试
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
            ← 返回看板
          </Link>
          <h1 className="text-2xl font-bold text-zinc-800">草稿箱</h1>
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
        </div>
        <div className="flex items-center gap-4">
          <button
            onClick={() => setShowAddModal(true)}
            className="rounded-md bg-blue-500 px-4 py-2 text-sm text-white hover:bg-blue-600"
          >
            + 新建任务
          </button>
          <span className="text-sm text-zinc-500">{tasks.length} 个草稿</span>
        </div>
      </header>

      {loading ? (
        <div className="flex h-64 items-center justify-center">
          <div className="text-zinc-500">加载中...</div>
        </div>
      ) : tasks.length === 0 ? (
        <div className="rounded-lg bg-white p-8 text-center text-zinc-500">
          暂无草稿
        </div>
      ) : (
        <div className="flex flex-wrap gap-4">
          {tasks.map((task) => (
            <div
              key={task.id}
              className="group relative w-80 rounded-lg bg-white p-3 shadow-sm transition-all hover:shadow-md"
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
                    <span className="text-xs text-zinc-400">+{task.subtasks.length - 3} 更多</span>
                  )}
                </div>
              )}

              <div className="flex items-center justify-between pl-3">
                <div className="flex items-center gap-2">
                  <span className={`rounded px-2 py-0.5 text-xs font-medium ${
                    task.priority === 'high' ? 'bg-red-100 text-red-700' : task.priority === 'medium' ? 'bg-yellow-100 text-yellow-700' : 'bg-green-100 text-green-700'
                  }`}>
                    {task.priority === 'high' ? '高' : task.priority === 'medium' ? '中' : '低'}
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
                  <span>创建：{new Date(task.createdAt).toLocaleString('zh-CN')}</span>
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleEdit(task)}
                      className="text-blue-500 hover:text-blue-600"
                    >
                      编辑
                    </button>
                    <button
                      onClick={() => handlePublishClick(task.id)}
                      className="text-green-500 hover:text-green-600"
                    >
                      发布
                    </button>
                    <button
                      onClick={() => handleDelete(task.id)}
                      className="text-red-500 hover:text-red-600"
                    >
                      删除
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {showAddModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="absolute inset-0 bg-black/50" />
          <div
            className="relative z-10 w-full max-w-md rounded-xl bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="mb-4 text-lg font-semibold text-zinc-800">
              新建任务（草稿）
            </h2>

            <form onSubmit={handleAddTask} className="space-y-4">
              <div>
                <input
                  ref={inputRef}
                  type="text"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="输入任务标题"
                  className="w-full rounded-md border border-zinc-300 px-4 py-3 text-base focus:border-blue-500 focus:outline-none"
                />
              </div>

              <div>
                <textarea
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                  placeholder="输入任务描述（可选，支持 Markdown）"
                  rows={4}
                  className="w-full rounded-md border border-zinc-300 px-4 py-3 text-base focus:border-blue-500 focus:outline-none resize-none"
                />
              </div>

              <div>
                <label className="block text-sm text-zinc-600 mb-1">目标列</label>
                <select
                  value={targetColumn}
                  onChange={(e) => setTargetColumn(e.target.value)}
                  className="w-full rounded-md border border-zinc-300 px-4 py-2 text-base focus:border-blue-500 focus:outline-none"
                >
                  {columns.map((col) => (
                    <option key={col.id} value={col.id}>{col.name}</option>
                  ))}
                </select>
              </div>

              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="flex-1 rounded-md bg-zinc-100 px-4 py-2.5 text-base font-medium text-zinc-700 hover:bg-zinc-200"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={!newTitle.trim()}
                  className="flex-1 rounded-md bg-blue-500 px-4 py-2.5 text-base font-medium text-white hover:bg-blue-600 disabled:cursor-not-allowed disabled:bg-zinc-300"
                >
                  保存草稿
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {editingTask && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="absolute inset-0 bg-black/50" />
          <div
            className="relative z-10 w-full max-w-md rounded-xl bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="mb-4 text-lg font-semibold text-zinc-800">
              编辑草稿
            </h2>

            <form onSubmit={handleUpdateTask} className="space-y-4">
              <div>
                <input
                  ref={editInputRef}
                  type="text"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="输入任务标题"
                  className="w-full rounded-md border border-zinc-300 px-4 py-3 text-base focus:border-blue-500 focus:outline-none"
                />
              </div>

              <div>
                <textarea
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                  placeholder="输入任务描述（可选，支持 Markdown）"
                  rows={4}
                  className="w-full rounded-md border border-zinc-300 px-4 py-3 text-base focus:border-blue-500 focus:outline-none resize-none"
                />
              </div>

              <div>
                <label className="block text-sm text-zinc-600 mb-1">目标列</label>
                <select
                  value={targetColumn}
                  onChange={(e) => setTargetColumn(e.target.value)}
                  className="w-full rounded-md border border-zinc-300 px-4 py-2 text-base focus:border-blue-500 focus:outline-none"
                >
                  {columns.map((col) => (
                    <option key={col.id} value={col.id}>{col.name}</option>
                  ))}
                </select>
              </div>

              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setEditingTask(null);
                    setNewTitle('');
                    setNewDescription('');
                  }}
                  className="flex-1 rounded-md bg-zinc-100 px-4 py-2.5 text-base font-medium text-zinc-700 hover:bg-zinc-200"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={!newTitle.trim()}
                  className="flex-1 rounded-md bg-blue-500 px-4 py-2.5 text-base font-medium text-white hover:bg-blue-600 disabled:cursor-not-allowed disabled:bg-zinc-300"
                >
                  保存修改
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {publishTaskId && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="absolute inset-0 bg-black/50" />
          <div
            className="relative z-10 w-full max-w-md rounded-xl bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="mb-4 text-lg font-semibold text-zinc-800">
              发布任务到看板
            </h2>

            <div className="space-y-4">
              <div>
                <label className="block text-sm text-zinc-600 mb-1">选择看板</label>
                <select
                  value={selectedBoard}
                  onChange={(e) => {
                    setSelectedBoard(e.target.value);
                    fetchColumnsByBoard(e.target.value);
                  }}
                  className="w-full rounded-md border border-zinc-300 px-4 py-2 text-base focus:border-blue-500 focus:outline-none"
                >
                  {boards.map((board) => (
                    <option key={board.id} value={board.id}>{board.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm text-zinc-600 mb-1">选择列</label>
                <select
                  value={publishTargetColumn}
                  onChange={(e) => setPublishTargetColumn(e.target.value)}
                  className="w-full rounded-md border border-zinc-300 px-4 py-2 text-base focus:border-blue-500 focus:outline-none"
                >
                  {columns.length === 0 ? (
                    <option value="">该看板暂无列</option>
                  ) : (
                    columns.map((col) => (
                      <option key={col.id} value={col.id}>{col.name}</option>
                    ))
                  )}
                </select>
              </div>

              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setPublishTaskId(null);
                  }}
                  className="flex-1 rounded-md bg-zinc-100 px-4 py-2.5 text-base font-medium text-zinc-700 hover:bg-zinc-200"
                >
                  取消
                </button>
                <button
                  onClick={handlePublish}
                  disabled={!publishTargetColumn}
                  className="flex-1 rounded-md bg-green-500 px-4 py-2.5 text-base font-medium text-white hover:bg-green-600 disabled:cursor-not-allowed disabled:bg-zinc-300"
                >
                  发布
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
