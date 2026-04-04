import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useState, useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { Task } from '@/types/kanban';
import { ConfirmDialog } from './ConfirmDialog';

interface TaskCardProps {
  task: Task;
  columnName?: string;
  onClick: () => void;
  onCommentsClick?: () => void;
  onArchive?: (taskId: string) => void;
  onDelete?: (taskId: string) => void;
  searchQuery?: string;
  isSelected?: boolean;
  onSelect?: (taskId: string, e?: React.ChangeEvent<HTMLInputElement>) => void;
}

  const priorityColors: Record<string, string> = {
  high: 'bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-400',
  medium: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/50 dark:text-yellow-400',
  low: 'bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-400',
};

const priorityBorderColors: Record<string, string> = {
  high: 'border-l-4 border-red-500',
  medium: 'border-l-4 border-yellow-500',
  low: 'border-l-4 border-green-500',
};

function highlightText(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const parts = text.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));
  return parts.map((part, i) =>
    part.toLowerCase() === query.toLowerCase()
      ? <mark key={i} className="bg-yellow-200 dark:bg-yellow-500 rounded px-0.5">{part}</mark>
      : part
  );
}

export function TaskCard({ task, columnName, onClick, onCommentsClick, onArchive, onDelete, searchQuery, isSelected, onSelect }: TaskCardProps) {
  const { t } = useTranslation();
  const randomId = useId();
  const taskId = task?.id ?? `temp-${randomId}`;
  const [isExpanded, setIsExpanded] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
    variant?: 'danger' | 'warning' | 'default';
  }>({ isOpen: false, title: '', message: '', onConfirm: () => {} });

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: taskId,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`group relative cursor-grab rounded-lg bg-white dark:bg-zinc-800 p-3 shadow-sm transition-all hover:shadow-md active:cursor-grabbing max-w-full ${
        isDragging ? 'opacity-60 ring-2 ring-blue-400 scale-105 z-50' : ''
      } ${priorityBorderColors[task.priority] || priorityBorderColors.medium} ${isSelected ? 'ring-2 ring-blue-500 bg-blue-50/50 dark:bg-blue-900/20' : ''}`}
    >
      {/* Selection checkbox */}
      {onSelect && (
        <div
          className={`absolute left-1 top-1/2 -translate-y-1/2 z-10 ${
            isDragging ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          }`}
          onMouseDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={isSelected || false}
            onChange={(e) => onSelect && onSelect(task.id, e)}
            className="h-4 w-4 rounded border-zinc-300 text-blue-500 focus:ring-blue-400 cursor-pointer"
          />
        </div>
      )}

      {/* Drag indicator */}
      <div
        className={`absolute left-1 top-1/2 -translate-y-1/2 flex flex-col gap-0.5 ${
          isDragging ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        } ${onSelect ? 'left-5' : ''}`}
        title={t('taskCard.dragToSort')}
      >
        <span className="h-0.5 w-1 rounded-full bg-zinc-400" />
        <span className="h-0.5 w-1 rounded-full bg-zinc-400" />
        <span className="h-0.5 w-1 rounded-full bg-zinc-400" />
      </div>

        <div className={`flex items-start justify-between gap-2 ${onSelect ? 'pl-6' : 'pl-3'}`}>
        <div className="flex-1">
          <span className="mb-1 flex items-center gap-1.5 text-xs text-zinc-400 dark:text-zinc-500 font-mono">
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                task.priority === 'high' ? 'bg-red-500 shadow-sm shadow-red-500/50' :
                task.priority === 'medium' ? 'bg-yellow-500 shadow-sm shadow-yellow-500/50' :
                'bg-green-500 shadow-sm shadow-green-500/50'
              }`}
            />
            #{String(task.id || '').slice(-6)}
          </span>
          <h3 className="font-medium text-zinc-800 dark:text-zinc-100 break-words">
            {searchQuery ? highlightText(task.title || 'Untitled', searchQuery) : task.title || 'Untitled'}
          </h3>
        </div>
        <div className="flex items-center gap-1 relative">
          {(onArchive || onDelete) && (
            <button
              type="button"
              onMouseDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                setShowMoreMenu(!showMoreMenu);
              }}
              className="flex-shrink-0 rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-700 dark:hover:text-zinc-300 z-10 relative"
              title={t('taskCard.moreActions')}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="1"/>
                <circle cx="12" cy="5" r="1"/>
                <circle cx="12" cy="19" r="1"/>
              </svg>
            </button>
          )}
          {showMoreMenu && (
            <div
              className="absolute right-0 top-full mt-1 w-28 rounded-md bg-white dark:bg-zinc-700 shadow-lg ring-1 ring-zinc-200 dark:ring-zinc-600 z-20"
              onMouseDown={(e) => e.stopPropagation()}
            >
              {onArchive && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onArchive(task.id);
                    setShowMoreMenu(false);
                  }}
                  className="w-full text-left px-3 py-2 text-sm text-orange-500 hover:bg-zinc-100 dark:hover:bg-zinc-600 rounded-t-md"
                >
                  {t('taskCard.archiveTask')}
                </button>
              )}
              {onDelete && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmDialog({
                      isOpen: true,
                      title: t('task.confirmDeleteTitle') || t('modal.deleteConfirmTitle'),
                      message: t('task.confirmDelete'),
                      variant: 'danger',
                      onConfirm: () => {
                        onDelete(task.id);
                        setConfirmDialog(prev => ({ ...prev, isOpen: false }));
                      },
                    });
                    setShowMoreMenu(false);
                  }}
                  className="w-full text-left px-3 py-2 text-sm text-red-500 hover:bg-zinc-100 dark:hover:bg-zinc-600 rounded-b-md"
                >
                  {t('taskCard.deleteTask')}
                </button>
              )}
            </div>
          )}
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onClick();
            }}
            className="flex-shrink-0 rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-700 dark:hover:text-zinc-300 z-10 relative"
            title={t('taskCard.viewDetails')}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <path d="M12 16v-4"/>
              <path d="M12 8h.01"/>
            </svg>
          </button>
        </div>
      </div>
      {task.description && typeof task.description === 'string' && (
        <div className="mb-2 pl-3">
          <p
            className={`text-sm text-zinc-500 dark:text-zinc-400 cursor-pointer hover:text-zinc-600 dark:hover:text-zinc-300 transition-all ${
              isExpanded ? '' : 'line-clamp-2'
            }`}
            onClick={(e) => {
              e.stopPropagation();
              setIsExpanded(!isExpanded);
            }}
            title={isExpanded ? t('taskCard.clickToCollapse') : t('taskCard.clickToExpand')}
          >
            {searchQuery ? highlightText(task.description, searchQuery) : task.description}
          </p>
          {task.description.length > 50 && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setIsExpanded(!isExpanded);
              }}
              className="mt-1 text-xs text-blue-500 hover:text-blue-600"
            >
              {isExpanded ? t('taskCard.collapse') : t('taskCard.expand')}
            </button>
          )}
        </div>
      )}
      {/* Subtasks preview */}
      {task.subtasks && task.subtasks.length > 0 && (
        <div className="mb-2 space-y-1 pl-3">
          {task.subtasks.slice(0, 3).map((subtask) => (
            <div key={subtask.id} className="flex items-center gap-1.5 text-xs">
              <span className={`h-1.5 w-1.5 rounded-full ${subtask.completed ? 'bg-green-500' : 'bg-zinc-300 dark:bg-zinc-600'}`} />
<span className={subtask.completed ? 'text-zinc-400 dark:text-zinc-500 line-through truncate' : 'text-zinc-600 dark:text-zinc-300 truncate'}>
                    {subtask.title}
                  </span>
            </div>
          ))}
          {task.subtasks.length > 3 && (
            <span className="text-xs text-zinc-400">{t('taskCard.moreSubtasks', { count: task.subtasks.length - 3 })}</span>
          )}
        </div>
      )}
      <div className="flex items-center justify-between pl-3">
        <div className="flex items-center gap-2">
          {columnName === t('task.status.done') && (
            <span className="text-green-500" title={t('taskCard.completed')}>✓</span>
          )}
          <span
            className={`rounded px-2 py-0.5 text-xs font-medium ${
              priorityColors[task.priority] || priorityColors.medium
            }`}
          >
            {task.priority === 'high' ? t('task.priority.high') : task.priority === 'medium' ? t('task.priority.medium') : t('task.priority.low')}
          </span>
          {task.subtasks && task.subtasks.length > 0 && (
            <span className="text-xs text-zinc-400">
              ✓ {task.subtasks.filter((s) => s.completed).length}/{task.subtasks.length}
            </span>
          )}
        </div>
        {task.assignee && (
          <span className="text-xs text-zinc-400 dark:text-zinc-500">{task.assignee}</span>
        )}
        {task.comments && task.comments.length > 0 && (
          <span
            className="flex items-center gap-1 cursor-pointer text-xs text-zinc-400 hover:text-blue-500"
            onClick={(e) => {
              e.stopPropagation();
              if (onCommentsClick) {
                onCommentsClick();
              } else {
                onClick();
              }
            }}
            title={t('taskCard.viewComments')}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
            {task.comments.length}
          </span>
        )}
      </div>
      {confirmDialog.isOpen && (
        <ConfirmDialog
          isOpen={confirmDialog.isOpen}
          title={confirmDialog.title}
          message={confirmDialog.message}
          variant={confirmDialog.variant}
          onConfirm={confirmDialog.onConfirm}
          onCancel={() => setConfirmDialog(prev => ({ ...prev, isOpen: false }))}
        />
      )}
    </div>
  );
}
