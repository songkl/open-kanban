import { useState, useRef, useEffect } from 'react';
import { useDroppable } from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { useTranslation } from 'react-i18next';
import { SafeMarkdown } from './SafeMarkdown';
import { TaskCard } from './TaskCard';
import type { Column as ColumnType, Task } from '@/types/kanban';

const LARGE_COLUMN_THRESHOLD = 50;

interface ColumnProps {
  column: ColumnType;
  currentBoardId?: string;
  boards?: Board[];
  isMobileView?: boolean;
  onAddTask: (columnId: string, title: string, description: string, published: boolean) => void;
  onTaskClick: (task: Task) => void;
  onTaskCommentsClick?: (task: Task) => void;
  onTaskArchive?: (taskId: string) => void;
  onTaskDelete?: (taskId: string) => void;
  onTaskMoveToColumn?: (taskId: string, toColumnId: string) => void;
  allColumns?: Array<{ id: string; name: string }>;
  onOpenAddTask?: (columnId: string) => void;
  onColumnRename?: (columnId: string, newName: string) => void;
  searchQuery?: string;
  selectedTasks?: Set<string>;
  onSelectTask?: (taskId: string, task: Task, e?: React.MouseEvent) => void;
  onSelectAllTasks?: (columnId: string, taskIds: string[]) => void;
  onLoadMore?: (columnId: string) => void;
  hasMore?: boolean;
  isLoadingMore?: boolean;
}

interface Board {
  id: string;
  name: string;
}

export function Column({ column, onTaskClick, onTaskCommentsClick, onTaskArchive, onTaskDelete, onTaskMoveToColumn, allColumns, onOpenAddTask, onColumnRename, isMobileView, searchQuery, selectedTasks, onSelectTask, onSelectAllTasks, onLoadMore, hasMore, isLoadingMore }: ColumnProps) {
  const { t } = useTranslation();
  const { setNodeRef, isOver } = useDroppable({
    id: column?.id ?? 'null',
  });

  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(column.name);
  const [showDescription, setShowDescription] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const tasks = column?.tasks ?? [];
  const isLargeColumn = tasks.length > LARGE_COLUMN_THRESHOLD;

  useEffect(() => {
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
  }, [column.id, onLoadMore, hasMore, isLoadingMore]);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleOpenAddTask = () => {
    if (onOpenAddTask && column.id) {
      onOpenAddTask(column.id);
    }
  };

  const handleStartEdit = () => {
    if (onColumnRename) {
      setEditName(column.name);
      setIsEditing(true);
    }
  };

  const handleSaveEdit = () => {
    const trimmedName = editName.trim();
    if (trimmedName && trimmedName !== column.name && onColumnRename) {
      onColumnRename(column.id, trimmedName);
    }
    setIsEditing(false);
  };

  const handleCancelEdit = () => {
    setEditName(column.name);
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSaveEdit();
    } else if (e.key === 'Escape') {
      handleCancelEdit();
    }
  };

  if (!column) {
    return null;
  }

  return (
    <>
      <div
        ref={setNodeRef}
        className={`relative flex flex-col rounded-lg bg-zinc-200/50 dark:bg-zinc-800/50 h-full ${
          isOver ? 'ring-2 ring-blue-400 z-10' : ''
        } ${isMobileView ? 'w-72 min-h-0 flex-shrink-0' : 'w-80 flex-shrink-0'}`}
      >
        <div
          className="flex items-center gap-2 rounded-t-lg px-4 py-3"
          style={{ backgroundColor: column.color + '20' }}
        >
          <div
            className="h-3 w-3 rounded-full"
            style={{ backgroundColor: column.color }}
          />
          {isEditing ? (
            <input
              ref={inputRef}
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onBlur={handleSaveEdit}
              onKeyDown={handleKeyDown}
              className="flex-1 px-1 py-0.5 text-sm font-semibold bg-white dark:bg-zinc-700 border border-blue-400 rounded text-zinc-700 dark:text-zinc-200 outline-none"
            />
          ) : (
            <h2
              className="flex-1 font-semibold text-zinc-700 dark:text-zinc-200 cursor-pointer hover:text-blue-600 dark:hover:text-blue-400 transition-colors group flex items-center gap-1"
              onClick={handleStartEdit}
              title={onColumnRename ? t('column.clickToRename') : undefined}
            >
              <span>{column.name}</span>
              {onColumnRename && (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="opacity-0 group-hover:opacity-100 transition-opacity text-zinc-400 hover:text-blue-500"
                >
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                </svg>
              )}
            </h2>
          )}
          <span className="ml-auto text-sm text-zinc-500 flex items-center gap-2">
            {onSelectAllTasks && tasks.length > 0 && (
              <input
                type="checkbox"
                className="w-4 h-4 rounded border-zinc-300 dark:border-zinc-600 text-blue-500 focus:ring-blue-500 cursor-pointer"
                checked={selectedTasks && tasks.length > 0 && tasks.every(t => selectedTasks.has(t.id))}
                onChange={(e) => {
                  e.stopPropagation();
                  if (onSelectAllTasks) {
                    onSelectAllTasks(column.id, tasks.map(t => t.id));
                  }
                }}
                title={t('column.selectAll')}
              />
            )}
            <span>{tasks.length}</span>
          </span>
        </div>

        {column.description && (
          <div className="px-3 py-2 border-b border-zinc-200/50 dark:border-zinc-700/50">
            <button
              onClick={() => setShowDescription(!showDescription)}
              className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${showDescription ? 'rotate-90' : ''}`}>
                <polyline points="9 18 15 12 9 6"/>
              </svg>
              {t('column.description')}
            </button>
            {showDescription && (
              <div className="mt-2 text-xs text-zinc-600 dark:text-zinc-400 prose prose-sm dark:prose-invert max-w-none">
                <SafeMarkdown>{column.description}</SafeMarkdown>
              </div>
            )}
          </div>
        )}

        <div ref={scrollRef} className="flex-1 space-y-2 overflow-y-auto p-2" style={isLargeColumn ? { contentVisibility: 'auto', containIntrinsicSize: '0 500px' } : undefined}>
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
                  onMoveToColumn={onTaskMoveToColumn}
                  columns={allColumns}
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

      </div>
    </>
  );
}
