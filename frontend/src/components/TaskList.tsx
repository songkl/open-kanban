import { useRef, useEffect } from 'react';
import { useDroppable } from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { useTranslation } from 'react-i18next';
import { TaskCard } from './TaskCard';
import type { Column as ColumnType, Task } from '@/types/kanban';

interface TaskListProps {
  column: ColumnType;
  searchQuery?: string;
  selectedTasks?: Set<string>;
  onSelectTask?: (taskId: string, task: Task, e?: React.MouseEvent) => void;
  onLoadMore?: (columnId: string) => void;
  hasMore?: boolean;
  isLoadingMore?: boolean;
  onTaskClick: (task: Task) => void;
  onTaskCommentsClick?: (task: Task) => void;
  onTaskArchive?: (taskId: string) => void;
  onTaskDelete?: (taskId: string) => void;
  onOpenAddTask?: (columnId: string) => void;
}

export function TaskList({
  column,
  searchQuery,
  selectedTasks,
  onSelectTask,
  onLoadMore,
  hasMore,
  isLoadingMore,
  onTaskClick,
  onTaskCommentsClick,
  onTaskArchive,
  onTaskDelete,
  onOpenAddTask,
}: TaskListProps) {
  const { t } = useTranslation();
  const { setNodeRef, isOver } = useDroppable({
    id: column?.id ?? 'null',
  });
  const scrollRef = useRef<HTMLDivElement>(null);
  const tasks = column?.tasks ?? [];

  useEffect(() => {
    if (!column) return;
    const scrollContainer = scrollRef.current;
    if (!scrollContainer || !onLoadMore || !hasMore || isLoadingMore) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
      if (scrollHeight - scrollTop - clientHeight < 100 && !isLoadingMore) {
        onLoadMore(column.id);
      }
    };

    scrollContainer.addEventListener('scroll', handleScroll);
    return () => scrollContainer.removeEventListener('scroll', handleScroll);
  }, [column?.id, onLoadMore, hasMore, isLoadingMore]);

  const handleOpenAddTask = () => {
    if (onOpenAddTask && column.id) {
      onOpenAddTask(column.id);
    }
  };

  if (!column) {
    return null;
  }

  return (
    <div
      ref={setNodeRef}
      className={`flex-1 space-y-2 overflow-y-auto p-2 rounded-b-lg ${
        isOver ? 'bg-blue-50/50 dark:bg-blue-900/20' : ''
      }`}
    >
      <SortableContext
        items={tasks.map((t) => t.id)}
        strategy={verticalListSortingStrategy}
      >
        {tasks.length === 0 ? (
          <div
            onClick={handleOpenAddTask}
            className="py-12 flex flex-col items-center justify-center text-center cursor-pointer hover:bg-zinc-100/50 dark:hover:bg-zinc-700/30 rounded-lg transition-colors"
          >
            <div className="mb-3 rounded-full bg-zinc-100 p-4">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-400">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                <line x1="12" y1="8" x2="12" y2="16"/>
                <line x1="8" y1="12" x2="16" y2="12"/>
              </svg>
            </div>
            <p className="text-sm font-medium text-zinc-500">{t('column.noTasks')}</p>
            <p className="mt-1 text-xs text-zinc-400">{t('column.clickToAddTask')}</p>
          </div>
        ) : (
          tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              columnName={column.name}
              onClick={() => onTaskClick(task)}
              onCommentsClick={() => onTaskCommentsClick ? onTaskCommentsClick(task) : onTaskClick(task)}
              onArchive={onTaskArchive}
              onDelete={onTaskDelete}
              searchQuery={searchQuery}
              isSelected={selectedTasks?.has(task.id)}
              onSelect={onSelectTask ? (id, e) => onSelectTask(id, task, e as unknown as React.MouseEvent) : undefined}
            />
          ))
        )}
        {isLoadingMore && (
          <div className="py-3 flex items-center justify-center">
            <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
          </div>
        )}
        {!isLoadingMore && hasMore && tasks.length > 0 && (
          <div className="py-3 flex items-center justify-center">
            <div className="w-5 h-5"></div>
          </div>
        )}
      </SortableContext>
    </div>
  );
}