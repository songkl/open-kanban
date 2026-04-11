import { useState, useEffect, useMemo, Suspense } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { TaskCard } from '@/components/TaskCard';
import { LoadingScreen } from '@/components/LoadingScreen';
import { TaskModal } from '@/components/TaskModal';
import { columnsApi, tasksApi, boardsApi, commentsApi } from '@/services/api';
import type { Column, Task, Board } from '@/types/kanban';

export function ColumnDetailPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const params = useParams();
  const { boardId, columnId } = params;

  const [columns, setColumns] = useState<Column[]>([]);
  const [column, setColumn] = useState<Column | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterAssignee, setFilterAssignee] = useState('');
  const [filterPublisher, setFilterPublisher] = useState('');
  const [sortBy, setSortBy] = useState<'position' | 'priority' | 'createdAt' | 'title' | 'assignee'>('position');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const [boards, setBoards] = useState<Board[]>([]);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);

  useEffect(() => {
    if (!boardId || !columnId) {
      setError('Invalid parameters');
      setLoading(false);
      return;
    }

    const fetchData = async () => {
      setLoading(true);
      setError(null);
      try {
        const columnsData = await columnsApi.getByBoard(boardId);
        setColumns(columnsData);

        const foundColumn = columnsData.find((c: Column) => c.id === columnId);
        if (!foundColumn) {
          setError('Column not found');
          setLoading(false);
          return;
        }
        setColumn(foundColumn);

        const tasksResponse = await tasksApi.getByColumn(columnId, 1, 100);
        setTasks(tasksResponse.data || []);

        const boardsData = await boardsApi.getAll();
        setBoards(boardsData);
      } catch (err) {
        console.error('Failed to fetch column data:', err);
        setError('Failed to load column data');
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [boardId, columnId]);

  const handleColumnChange = async (newColumnId: string) => {
    if (newColumnId === columnId) return;
    navigate(`/board/${boardId}/column/${newColumnId}`);
  };

  const uniqueAssignees = useMemo(() => {
    const assignees = new Set<string>();
    tasks.forEach(t => t.assignee && assignees.add(t.assignee));
    return Array.from(assignees);
  }, [tasks]);

  const uniquePublishers = useMemo(() => {
    const publishers = new Map<string, string>();
    tasks.forEach(t => {
      if (t.createdBy) {
        publishers.set(t.createdBy, t.createdByUsername || t.createdBy);
      }
    });
    return Array.from(publishers.entries()).map(([id, username]) => ({ id, username }));
  }, [tasks]);

  const filteredTasks = useMemo(() => {
    const filtered = tasks.filter(task => {
      if (filterAssignee && task.assignee !== filterAssignee) return false;
      if (filterPublisher && task.createdBy !== filterPublisher) return false;
      return true;
    });

    const priorityOrder = { high: 0, medium: 1, low: 2 };

    return [...filtered].sort((a, b) => {
      let cmp = 0;
      switch (sortBy) {
        case 'position':
          cmp = a.position - b.position;
          break;
        case 'priority':
          cmp = priorityOrder[a.priority as keyof typeof priorityOrder] - priorityOrder[b.priority as keyof typeof priorityOrder];
          break;
        case 'createdAt':
          cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
          break;
        case 'title':
          cmp = (a.title || '').localeCompare(b.title || '');
          break;
        case 'assignee':
          cmp = (a.assignee || '\xff').localeCompare(b.assignee || '\xff');
          break;
      }
      return sortOrder === 'asc' ? cmp : -cmp;
    });
  }, [tasks, filterAssignee, filterPublisher, sortBy, sortOrder]);

  const handleTaskClick = (task: Task) => {
    setSelectedTask(task);
  };

  const handleTaskCommentsClick = (task: Task) => {
    setSelectedTask(task);
  };

  const handleUpdateTask = async (task: Task) => {
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
      setTasks(prev => prev.map(t => t.id === task.id ? { ...t, ...updated } : t));
      if (selectedTask?.id === task.id) {
        setSelectedTask(prev => prev ? { ...prev, ...updated } : null);
      }
    } catch (err) {
      console.error('Failed to update task:', err);
    }
  };

  const handleDeleteTask = async (taskId: string) => {
    try {
      await tasksApi.delete(taskId);
      setTasks(prev => prev.filter(t => t.id !== taskId));
      setSelectedTask(null);
    } catch (err) {
      console.error('Failed to delete task:', err);
    }
  };

  const handleArchiveTask = async (taskId: string) => {
    try {
      await tasksApi.archive(taskId, true);
      setTasks(prev => prev.filter(t => t.id !== taskId));
      if (selectedTask?.id === taskId) {
        setSelectedTask(null);
      }
    } catch (err) {
      console.error('Failed to archive task:', err);
    }
  };

  const handleAddComment = async (taskId: string, content: string, author: string) => {
    try {
      await commentsApi.create({ taskId, content, author });
      const task = tasks.find(t => t.id === taskId);
      if (task) {
        setTasks(prev => prev.map(t => 
          t.id === taskId 
            ? { ...t, _count: { ...t._count, comments: (t._count?.comments || 0) + 1 } }
            : t
        ));
      }
    } catch (err) {
      console.error('Failed to add comment:', err);
    }
  };

  if (loading) {
    return <LoadingScreen />;
  }

  if (error || !column) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4">
        <div className="text-red-500">{error || 'Column not found'}</div>
        <button
          onClick={() => navigate(`/board/${boardId}`)}
          className="rounded-md bg-blue-500 px-4 py-2 text-sm text-white hover:bg-blue-600"
        >
          {t('common.back')}
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-100 dark:bg-zinc-900">
      <header className="border-b border-zinc-200 bg-white px-6 py-4 dark:border-zinc-700 dark:bg-zinc-800">
        <div className="flex items-center gap-4">
          <Link
            to={`/board/${boardId}`}
            className="flex items-center gap-2 text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="15 18 9 12 15 6" />
            </svg>
            {t('common.back')}
          </Link>
          <div className="h-6 w-px bg-zinc-300 dark:bg-zinc-600" />
          <div className="flex items-center gap-3">
            <div
              className="h-4 w-4 rounded-full"
              style={{ backgroundColor: column.color }}
            />
            <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
              {column.name}
            </h1>
            {column.status && (
              <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-500 dark:bg-zinc-700 dark:text-zinc-400">
                {column.status}
              </span>
            )}
          </div>
          <div className="ml-auto flex items-center gap-3">
            <div className="flex items-center gap-2">
              <label htmlFor="filter-assignee" className="text-sm text-zinc-500">{t('filter.assignee')}:</label>
              <select
                id="filter-assignee"
                name="filter-assignee"
                aria-label={t('filter.assignee')}
                value={filterAssignee}
                onChange={(e) => setFilterAssignee(e.target.value)}
                className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm dark:border-zinc-600 dark:bg-zinc-700"
              >
                <option value="">{t('filter.all')}</option>
                {uniqueAssignees.map(a => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <label htmlFor="filter-publisher" className="text-sm text-zinc-500">{t('userDetail.publisher')}:</label>
              <select
                id="filter-publisher"
                name="filter-publisher"
                aria-label={t('userDetail.publisher')}
                value={filterPublisher}
                onChange={(e) => setFilterPublisher(e.target.value)}
                className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm dark:border-zinc-600 dark:bg-zinc-700 dark:text-zinc-100"
              >
                <option value="">{t('filter.all')}</option>
                {uniquePublishers.map(p => (
                  <option key={p.id} value={p.id}>{p.username}</option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <label htmlFor="filter-column" className="text-sm text-zinc-500">{t('userDetail.columnName')}:</label>
              <select
                id="filter-column"
                name="filter-column"
                aria-label={t('userDetail.columnName')}
                value={columnId}
                onChange={(e) => handleColumnChange(e.target.value)}
                className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm dark:border-zinc-600 dark:bg-zinc-700"
              >
                {columns.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <label htmlFor="sort-by" className="text-sm text-zinc-500">{t('common.sortBy')}:</label>
              <select
                id="sort-by"
                name="sort-by"
                aria-label={t('common.sortBy')}
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
                className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm dark:border-zinc-600 dark:bg-zinc-700 dark:text-zinc-100"
              >
                <option value="position">{t('task.position')}</option>
                <option value="priority">{t('task.priority')}</option>
                <option value="createdAt">{t('task.createdAt')}</option>
                <option value="title">{t('task.title')}</option>
                <option value="assignee">{t('task.assignee')}</option>
              </select>
              <button
                onClick={() => setSortOrder(o => o === 'asc' ? 'desc' : 'asc')}
                className="rounded-md border border-zinc-300 px-2 py-1.5 text-sm dark:border-zinc-600 dark:bg-zinc-700 dark:text-zinc-100"
                title={sortOrder === 'asc' ? t('common.sortAsc') : t('common.sortDesc')}
              >
                {sortOrder === 'asc' ? '↑' : '↓'}
              </button>
            </div>
            <span className="text-sm text-zinc-500">
              {t('userDetail.taskCount', { count: filteredTasks.length })}
            </span>
          </div>
        </div>
      </header>

      <main className="p-6">
        {column.description && (
          <div className="mb-6 rounded-lg bg-white p-4 text-sm text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-700">
            <p>{column.description}</p>
          </div>
        )}

        {filteredTasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-zinc-500">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="48"
              height="48"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="mb-4 text-zinc-300 dark:text-zinc-600"
            >
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="9" y1="9" x2="15" y2="15" />
              <line x1="15" y1="9" x2="9" y2="15" />
            </svg>
            <p>{t('column.noTasks')}</p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {filteredTasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                columnName={column.name}
                isSelected={selectedTask?.id === task.id}
                onClick={() => handleTaskClick(task)}
                onCommentsClick={() => handleTaskCommentsClick(task)}
              />
            ))}
          </div>
        )}
      </main>

      {selectedTask && (
        <Suspense fallback={
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <div className="h-8 w-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </div>
        }>
          <TaskModal
            task={selectedTask}
            columnName={column.name}
            columns={columns.map((c) => ({ id: c.id, name: c.name }))}
            boardId={boardId}
            boards={boards}
            canEdit={true}
            startEditing={false}
            onClose={() => setSelectedTask(null)}
            onUpdate={handleUpdateTask}
            onDelete={handleDeleteTask}
            onArchive={handleArchiveTask}
            onAddComment={handleAddComment}
            onEditingStarted={() => {}}
          />
        </Suspense>
      )}
    </div>
  );
}