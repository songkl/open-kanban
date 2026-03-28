import { useState, useEffect, useRef } from 'react';
import { Routes, Route, Link, useParams, useNavigate } from 'react-router-dom';

declare global {
  interface ImportMetaEnv {
    readonly VITE_WS_URL?: string;
    readonly DEV: boolean;
  }
}

import {
  DndContext,
  DragOverlay,
  closestCorners,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragStartEvent,
  DragEndEvent,
} from '@dnd-kit/core';
import { arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { Column } from './components/Column';
import { TaskCard } from './components/TaskCard';
import { TaskModal } from './components/TaskModal';
import { AddTaskModal } from './components/AddTaskModal';
import { boardsApi, columnsApi, tasksApi, commentsApi, setGlobalErrorHandler } from './services/api';
import { DraftsPage } from './pages/DraftsPage';
import { HistoryPage } from './pages/HistoryPage';
import { ColumnsPage } from './pages/ColumnsPage';
import { CompletedPage } from './pages/CompletedPage';
import { BoardSkeleton } from './components/Skeleton';
import { ErrorToastContainer, showErrorToast } from './components/ErrorToast';
import type { Board, Column as ColumnType, Task } from './types/kanban';

const LAST_BOARD_KEY = 'lastSelectedBoardId';

// Board Page Component
function BoardPage() {
  const navigate = useNavigate();
  const params = useParams();
  const boardIdFromUrl = params.boardId as string;

  const [boards, setBoards] = useState<Board[]>([]);
  const [currentBoard, setCurrentBoard] = useState<Board | null>(null);
  const [columns, setColumns] = useState<ColumnType[]>([]);
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [loading, setLoading] = useState(true);
  const [boardSwitching, setBoardSwitching] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [wsStatus, setWsStatus] = useState<'connected' | 'disconnected'>('disconnected');
  const [reconnectCount, setReconnectCount] = useState(0);
  const [showAddTaskModal, setShowAddTaskModal] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const currentBoardRef = useRef<Board | null>(null);

  const showToastMessage = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 2000);
  };

  // Setup global API error handler
  useEffect(() => {
    setGlobalErrorHandler((error) => {
      showErrorToast(error.message, 'error');
    });
    return () => setGlobalErrorHandler(null);
  }, []);

  useEffect(() => {
    currentBoardRef.current = currentBoard;
  }, [currentBoard]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // 并行加载初始数据
  useEffect(() => {
    const loadInitialData = async () => {
      try {
        // 并行获取 boards 和连接 WebSocket
        await Promise.all([
          fetchBoards(),
          new Promise<void>((resolve) => {
            connectWebSocket();
            resolve();
          }),
        ]);
      } catch (error) {
        console.error('Failed to load initial data:', error);
      }
    };

    loadInitialData();

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'n') {
        e.preventDefault();
        setShowAddTaskModal(true);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  const fetchBoards = async () => {
    try {
      const data = await boardsApi.getAll();
      setBoards(data);
    } catch (error) {
      console.error('Failed to fetch boards:', error);
    }
  };

  useEffect(() => {
    if (!boardIdFromUrl && boards.length > 0) {
      const lastBoardId = localStorage.getItem(LAST_BOARD_KEY);
      const lastBoard = lastBoardId ? boards.find((b: Board) => b.id === lastBoardId) : null;
      const targetBoard = lastBoard || boards[0];
      navigate(`/board/${targetBoard.id}`);
    }
  }, [boardIdFromUrl, boards, navigate]);

  useEffect(() => {
    if (!boardIdFromUrl || boards.length === 0) return;
    
    const board = boards.find((b) => b.id === boardIdFromUrl);
    if (board) {
      if (currentBoard?.id !== board.id) {
        setBoardSwitching(true);
        setCurrentBoard(board);
      }
    } else {
      console.warn(`Board ${boardIdFromUrl} not found in boards list, redirecting to ${boards[0].id}`);
      navigate(`/board/${boards[0].id}`);
    }
  }, [boardIdFromUrl, boards, navigate, currentBoard?.id]);

  useEffect(() => {
    if (currentBoard) {
      fetchColumns(currentBoard.id);
    }
  }, [currentBoard?.id]);

  const connectWebSocket = () => {
    const getWsUrl = () => {
      if (import.meta.env.VITE_WS_URL) return import.meta.env.VITE_WS_URL;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = import.meta.env.DEV ? 'localhost:3000' : window.location.host;
      return `${protocol}//${host}/ws`;
    };
    const wsUrl = getWsUrl();
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('WebSocket connected');
      setWsStatus('connected');
      setReconnectCount(0);
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'refresh') {
          if (currentBoardRef.current) {
            fetchColumns(currentBoardRef.current.id, true);
          }
        }
      } catch (e) {
        console.error('Failed to parse WebSocket message:', e);
      }
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected, reconnecting...');
      setWsStatus('disconnected');
      setReconnectCount((prev) => prev + 1);
      setTimeout(connectWebSocket, 3000);
    };

    ws.onerror = () => {};

    wsRef.current = ws;
  };

  const fetchColumns = async (boardId: string, silent = false) => {
    if (!silent) {
      setLoading(true);
      setLoadError(null);
    }
    try {
      const data = await columnsApi.getByBoard(boardId);
      setColumns(data.map(col => ({
        ...col,
        tasks: col.tasks?.map(t => ({
          ...t,
          comments: t.comments ?? [],
          subtasks: t.subtasks ?? [],
        })) ?? [],
      })));
    } catch (error) {
      console.error('Failed to fetch columns:', error);
      if (!silent) {
        setLoadError(error instanceof Error ? error.message : '加载看板数据失败');
      }
    } finally {
      if (!silent) {
        setLoading(false);
        setBoardSwitching(false);
      }
    }
  };

  const handleDragStart = (event: DragStartEvent) => {
    const { active } = event;
    const task = columns.flatMap((col) => col.tasks).find((t) => t.id === active.id);
    if (task) setActiveTask(task);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveTask(null);

    if (!over) return;

    const activeId = active.id as string;
    const overId = over.id as string;

    const activeColumn = columns.find((col) => col.tasks?.some((t) => t.id === activeId));
    const overColumn = columns.find(
      (col) => col.id === overId || col.tasks?.some((t) => t.id === overId)
    );

    if (!activeColumn || !overColumn) return;

    if (activeColumn.id === overColumn.id) {
      const tasks = activeColumn.tasks ?? [];
      const oldIndex = tasks.findIndex((t) => t.id === activeId);
      const newIndex = tasks.findIndex((t) => t.id === overId);

      if (oldIndex !== newIndex) {
        const newTasks = arrayMove(tasks, oldIndex, newIndex).map((t, i) => ({
          ...t,
          position: i,
        }));

        setColumns((cols) =>
          cols.map((col) => (col.id === activeColumn.id ? { ...col, tasks: newTasks } : col))
        );

        await tasksApi.update(activeId, { position: newTasks[newIndex].position });
      }
    } else {
      const tasks = (activeColumn.tasks ?? []).filter((t) => t.id !== activeId);
      const overTasks = [...(overColumn.tasks ?? [])];
      const newIndex = overTasks.findIndex((t) => t.id === overId);

      if (newIndex >= 0) {
        overTasks.splice(newIndex, 0, { ...activeTask!, columnId: overColumn.id });
      } else {
        overTasks.push({ ...activeTask!, columnId: overColumn.id });
      }

      const updatedTasks = overTasks.map((t, i) => ({ ...t, position: i }));
      const movedTask = updatedTasks.find((t) => t.id === activeId);
      const movedTaskNewIndex = updatedTasks.findIndex((t) => t.id === activeId);

      setColumns((cols) =>
        cols.map((col) => {
          if (col.id === activeColumn.id) return { ...col, tasks: tasks ?? [] };
          if (col.id === overColumn.id) return { ...col, tasks: updatedTasks ?? [] };
          return col;
        })
      );

      if (movedTask) {
        await tasksApi.update(activeId, {
          position: movedTaskNewIndex,
          columnId: movedTask.columnId
        });
      }
    }
  };

  const updateTask = async (task: Task) => {
    const currentBoardId = currentBoard?.id || '';
    const targetColumnId = task.columnId;
    const targetBoardId = targetColumnId?.split('_')[0] || '';
    const isSameBoard = targetBoardId === currentBoardId;

    try {
      const updated = await tasksApi.update(task.id, {
        title: task.title,
        description: task.description,
        priority: task.priority,
        assignee: task.assignee,
        columnId: task.columnId,
        position: task.position ?? 0,
        published: task.published,
        meta: task.meta,
      });

      const parsedUpdated = {
        ...updated,
        meta: typeof updated.meta === 'string' ? JSON.parse(updated.meta || '{}') : updated.meta || null,
      };

      if (isSameBoard) {
        setColumns((cols) =>
          cols.map((col) => ({
            ...col,
            tasks: col.tasks.map((t) => (t.id === task.id ? parsedUpdated : t)),
          }))
        );
        setSelectedTask(parsedUpdated);
      } else {
        showToastMessage(`任务已发布到 "${targetBoardId}" 看板`);
        setSelectedTask(null);
      }
    } catch (error) {
      console.error('Failed to update task:', error);
    }
  };

  const deleteTask = async (taskId: string) => {
    await tasksApi.delete(taskId);
    setColumns((cols) =>
      cols.map((col) => ({
        ...col,
        tasks: col.tasks.filter((t) => t.id !== taskId),
      }))
    );
    setSelectedTask(null);
  };

  const archiveTask = async (taskId: string) => {
    await tasksApi.archive(taskId, true);
    setColumns((cols) =>
      cols.map((col) => ({
        ...col,
        tasks: col.tasks.filter((t) => t.id !== taskId),
      }))
    );
    setSelectedTask(null);
  };

  const addTask = async (columnId?: string, title?: string, description?: string, published?: boolean) => {
    const taskTitle = title || prompt('请输入任务标题：');
    if (!taskTitle?.trim()) return;

    const targetColumnId = columnId || currentBoard?.id + '_todo';
    const columnBoardPrefix = targetColumnId?.split('_')[0] || '';
    const currentBoardId = currentBoard?.id || '';
    const isSameBoard = columnBoardPrefix === currentBoardId;

    try {
      const task = await tasksApi.create({
        title: taskTitle.trim(),
        description: description || '',
        columnId: targetColumnId,
        position: 9999,
        published: published ?? true,
      });

      if (isSameBoard) {
        setColumns((cols) => {
          const targetCol = cols.find((c) => c.id === targetColumnId);
          if (targetCol) {
            return cols.map((col) =>
              col.id === targetCol.id ? { ...col, tasks: [...col.tasks, task] } : col
            );
          }
          return cols;
        });
      } else {
        const boardName = boards.find(b => b.id === columnBoardPrefix)?.name || columnBoardPrefix;
        showToastMessage(`任务已创建到 "${boardName}" 看板`);
      }
    } catch (error) {
      console.error('Failed to create task:', error);
    }
  };

  const addComment = async (taskId: string, content: string, author: string) => {
    try {
      const comment = await commentsApi.create({ taskId, content, author });
      setColumns((cols) =>
        cols.map((col) => ({
          ...col,
          tasks: col.tasks.map((t) =>
            t.id === taskId ? { ...t, comments: [...(t.comments ?? []), comment] } : t
          ),
        }))
      );
      if (selectedTask?.id === taskId) {
        setSelectedTask({ ...selectedTask, comments: [...(selectedTask.comments ?? []), comment] });
      }
    } catch (error) {
      console.error('Failed to add comment:', error);
    }
  };

  if (loading || boardSwitching) {
    return <BoardSkeleton />;
  }

  if (loadError) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4">
        <div className="text-red-500">加载失败</div>
        <div className="text-sm text-zinc-400">{loadError}</div>
        <button
          onClick={() => currentBoard && fetchColumns(currentBoard.id)}
          className="rounded-md bg-blue-500 px-4 py-2 text-sm text-white hover:bg-blue-600"
        >
          重试
        </button>
      </div>
    );
  }

  return (
    <div className="h-screen bg-zinc-100 p-6">
      <header className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-bold text-zinc-800">协作看板</h1>
          <select
            value={currentBoard?.id || boardIdFromUrl || ''}
            onChange={(e) => {
              const selectedBoardId = e.target.value;
              if (selectedBoardId) {
                localStorage.setItem(LAST_BOARD_KEY, selectedBoardId);
              }
              if (selectedBoardId && selectedBoardId !== boardIdFromUrl) {
                navigate(`/board/${selectedBoardId}`);
              }
            }}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm"
          >
            {boards.map((board) => (
              <option key={board.id} value={board.id}>
                {board.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-4">
          <Link to="/boards" className="rounded-md bg-zinc-200 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-300">
            管理看板
          </Link>
          <Link to="/drafts" className="rounded-md bg-zinc-200 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-300">
            草稿箱
          </Link>
          <Link to="/history" className="rounded-md bg-zinc-200 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-300">
            历史归档
          </Link>
          <Link to="/completed" className="rounded-md bg-zinc-200 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-300">
            已完成管理
          </Link>
          <div className={`flex items-center gap-2 rounded-lg px-3 py-2 ${wsStatus === 'connected' ? 'bg-green-100' : 'bg-red-100 animate-pulse'}`}>
            <span className={`text-base font-bold ${wsStatus === 'connected' ? 'text-green-700' : 'text-red-600'}`}>
              {wsStatus === 'connected' ? '🟢 实时同步已连接' : `🔴 离线 - 重连中${reconnectCount > 0 ? ` (第${reconnectCount}次)` : ''}...`}
            </span>
          </div>
        </div>
      </header>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div className="flex h-[calc(100vh-120px)] gap-4 overflow-x-auto pb-4">
          {columns.filter(Boolean).map((column) => (
            <Column
              key={column.id}
              column={column}
              currentBoardId={currentBoard?.id}
              boards={boards}
              onAddTask={addTask}
              onTaskClick={setSelectedTask}
              onTaskCommentsClick={setSelectedTask}
              onOpenAddTask={() => setShowAddTaskModal(true)}
            />
          ))}
        </div>

        <button
          onClick={() => setShowAddTaskModal(true)}
          className="fixed bottom-8 left-1/2 -translate-x-1/2 flex h-14 w-14 items-center justify-center rounded-full bg-blue-500 text-3xl text-white shadow-lg hover:bg-blue-600"
        >
          +
        </button>

        <AddTaskModal
          isOpen={showAddTaskModal}
          currentBoardId={currentBoard?.id}
          boards={boards}
          onClose={() => setShowAddTaskModal(false)}
          onSubmit={(title, description, published, columnId) => {
            addTask(columnId, title, description, published);
            setShowAddTaskModal(false);
          }}
        />

        <DragOverlay>
          {activeTask && <TaskCard task={activeTask} onClick={() => {}} />}
        </DragOverlay>
      </DndContext>

      {selectedTask && (
        <TaskModal
          task={selectedTask}
          columnName={columns.find((col) => col.tasks.some((t) => t.id === selectedTask.id))?.name}
          columns={columns.map((c) => ({ id: c.id, name: c.name }))}
          boards={boards}
          canEdit={true}
          onClose={() => setSelectedTask(null)}
          onUpdate={updateTask}
          onDelete={deleteTask}
          onArchive={archiveTask}
          onAddComment={addComment}
        />
      )}

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 rounded-lg bg-zinc-800 px-4 py-2 text-sm text-white">
          {toast}
        </div>
      )}
      <ErrorToastContainer />
    </div>
  );
}

// Boards Management Page
function BoardsPage() {
  const [boards, setBoards] = useState<Board[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [editingBoard, setEditingBoard] = useState<Board | null>(null);
  const [boardName, setBoardName] = useState('');
  const [boardId, setBoardId] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    fetchBoards();
  }, []);

  const fetchBoards = async () => {
    const data = await boardsApi.getAll();
    setBoards(data);
  };

  const showToastMessage = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 2000);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!boardName.trim()) return;

    try {
      if (editingBoard) {
        await boardsApi.update(editingBoard.id, { name: boardName });
        showToastMessage('看板已更新');
      } else {
        await boardsApi.create({ 
          name: boardName.trim(),
          id: boardId || boardName.toLowerCase().replace(/\s+/g, '-'),
        });
        showToastMessage('看板已创建');
      }
      fetchBoards();
      closeModal();
    } catch (error) {
      console.error('Failed to save board:', error);
      showToastMessage('保存失败');
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`确定要删除看板 "${name}" 吗？\n删除后所有列和任务都将被删除！`)) return;
    
    try {
      await boardsApi.delete(id);
      showToastMessage('看板已删除');
      fetchBoards();
    } catch (error) {
      console.error('Failed to delete board:', error);
      showToastMessage('删除失败');
    }
  };

  const openAddModal = () => {
    setEditingBoard(null);
    setBoardName('');
    setBoardId('');
    setShowModal(true);
  };

  const openEditModal = (board: Board) => {
    setEditingBoard(board);
    setBoardName(board.name);
    setBoardId(board.id);
    setShowModal(true);
  };

  const closeModal = () => {
    setShowModal(false);
    setEditingBoard(null);
    setBoardName('');
    setBoardId('');
  };

  return (
    <div className="min-h-screen bg-zinc-100 p-6">
      <div className="mx-auto">
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2 sm:gap-4">
            <Link to={boards.length > 0 ? `/board/${boards[0].id}` : '/'} className="rounded-md bg-zinc-200 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-300">
              ← 返回
            </Link>
            <h1 className="text-xl font-bold text-zinc-800 sm:text-2xl">看板管理</h1>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link to="/columns" className="rounded-md bg-zinc-200 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-300">
              列管理
            </Link>
            <button
              onClick={openAddModal}
              className="rounded-md bg-blue-500 px-4 py-2 text-sm text-white hover:bg-blue-600"
            >
              + 新建看板
            </button>
          </div>
        </div>

        {boards.length === 0 ? (
          <div className="rounded-lg bg-white p-8 text-center text-zinc-500">
            暂无看板，点击上方按钮创建
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {boards.map((board) => (
              <div
                key={board.id}
                className="rounded-lg bg-white p-4 shadow-sm"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-medium text-zinc-800">{board.name}</h3>
                    <p className="text-xs text-zinc-400 mt-1">ID: {board.id}</p>
                    <p className="text-xs text-zinc-400">
                      创建于：{new Date(board.createdAt).toLocaleDateString('zh-CN')}
                    </p>
                  </div>
                  <div className="flex flex-col gap-2">
                    <button
                      onClick={() => navigate(`/board/${board.id}`)}
                      className="rounded bg-blue-500 px-3 py-1 text-sm text-white hover:bg-blue-600"
                    >
                      进入
                    </button>
                    <Link
                      to={`/columns?boardId=${board.id}`}
                      className="rounded bg-zinc-100 px-3 py-1 text-sm text-zinc-600 hover:bg-zinc-200 text-center"
                    >
                      列管理
                    </Link>
                    <button
                      onClick={() => openEditModal(board)}
                      className="rounded bg-zinc-100 px-3 py-1 text-sm text-zinc-600 hover:bg-zinc-200"
                    >
                      编辑
                    </button>
                    <button
                      onClick={() => handleDelete(board.id, board.name)}
                      className="rounded bg-red-500 px-3 py-1 text-sm text-white hover:bg-red-600"
                    >
                      删除
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {showModal && (
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
              {editingBoard ? '编辑看板' : '新建看板'}
            </h2>
            
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-zinc-700 mb-1">
                  看板名称
                </label>
                <input
                  type="text"
                  value={boardName}
                  onChange={(e) => setBoardName(e.target.value)}
                  placeholder="输入看板名称"
                  className="w-full rounded-md border border-zinc-300 px-4 py-2 text-base focus:border-blue-500 focus:outline-none"
                  autoFocus
                />
              </div>

              {!editingBoard && (
                <div>
                  <label className="block text-sm font-medium text-zinc-700 mb-1">
                    看板 ID（可选）
                  </label>
                  <input
                    type="text"
                    value={boardId}
                    onChange={(e) => setBoardId(e.target.value)}
                    placeholder="留空则自动生成"
                    className="w-full rounded-md border border-zinc-300 px-4 py-2 text-base focus:border-blue-500 focus:outline-none"
                  />
                  <p className="text-xs text-zinc-500 mt-1">
                    用于 URL 访问，如 shuxi
                  </p>
                </div>
              )}
              
              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={closeModal}
                  className="flex-1 rounded-md bg-zinc-100 px-4 py-2.5 text-base font-medium text-zinc-700 hover:bg-zinc-200"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={!boardName.trim()}
                  className="flex-1 rounded-md bg-blue-500 px-4 py-2.5 text-base font-medium text-white hover:bg-blue-600 disabled:cursor-not-allowed disabled:bg-zinc-300"
                >
                  {editingBoard ? '保存' : '创建'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 rounded-lg bg-zinc-800 px-4 py-2 text-sm text-white">
          {toast}
        </div>
      )}
      <ErrorToastContainer />
    </div>
  );
}

// Home Page - Redirect to first board
function HomePage() {
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasBoards, setHasBoards] = useState(false);

  useEffect(() => {
    boardsApi.getAll()
      .then((data) => {
        setHasBoards(data.length > 0);
        if (data.length > 0) {
          navigate(`/board/${data[0].id}`);
        }
      })
      .catch((err) => {
        console.error('Failed to fetch boards:', err);
        setError(err instanceof Error ? err.message : '无法连接到服务器');
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [navigate]);

  if (isLoading) {
    return <BoardSkeleton />;
  }

  if (error) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4">
        <div className="text-red-500">连接失败</div>
        <div className="text-sm text-zinc-400">{error}</div>
        <button
          onClick={() => window.location.reload()}
          className="rounded-md bg-blue-500 px-4 py-2 text-sm text-white hover:bg-blue-600"
        >
          重试
        </button>
      </div>
    );
  }

  if (!hasBoards) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4">
        <div className="text-zinc-500">暂无看板</div>
        <button
          onClick={() => navigate('/boards')}
          className="rounded-md bg-blue-500 px-4 py-2 text-sm text-white hover:bg-blue-600"
        >
          创建看板
        </button>
      </div>
    );
  }

  return null;
}

// Main App
function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/board/:boardId" element={<BoardPage />} />
      <Route path="/boards" element={<BoardsPage />} />
      <Route path="/drafts" element={<DraftsPage />} />
      <Route path="/history" element={<HistoryPage />} />
      <Route path="/columns" element={<ColumnsPage />} />
      <Route path="/completed" element={<CompletedPage />} />
    </Routes>
  );
}

export default App;
