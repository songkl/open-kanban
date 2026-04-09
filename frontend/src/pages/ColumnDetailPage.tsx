import { useState, useEffect, useMemo } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { TaskCard } from '@/components/TaskCard';
import { LoadingScreen } from '@/components/LoadingScreen';
import { columnsApi, tasksApi } from '@/services/api';
import type { Column, Task } from '@/types/kanban';

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
    return tasks.filter(task => {
      if (filterAssignee && task.assignee !== filterAssignee) return false;
      if (filterPublisher && task.createdBy !== filterPublisher) return false;
      return true;
    });
  }, [tasks, filterAssignee, filterPublisher]);

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
                isSelected={false}
                onClick={() => {}}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}