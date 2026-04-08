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
  onMoveToColumn?: (taskId: string, toColumnId: string) => void;
  columns?: Array<{ id: string; name: string }>;
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

export function TaskCard({ task, columnName, onClick, onCommentsClick, onArchive, onDelete, onMoveToColumn, columns, searchQuery, isSelected, onSelect }: TaskCardProps) {
  const { t } = useTranslation();
  const randomId = useId();
  const taskId = task?.id ?? `temp-${randomId}`;
  const [isExpanded, setIsExpanded] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [showMoveSubmenu, setShowMoveSubmenu] = useState(false);
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
      className={`group relative cursor-grab rounded-xl bg-white dark:bg-zinc-800/95 p-4 shadow-sm border border-zinc-100 dark:border-zinc-700/50 transition-all hover:shadow-lg hover:border-zinc-200 dark:hover:border-zinc-600 active:cursor-grabbing max-w-full ${
        isDragging ? 'opacity-60 ring-2 ring-blue-400 scale-105 z-50 shadow-blue-200 dark:shadow-blue-900/50' : ''
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
        className={`absolute left-1 top-1/2 -translate-y-1/2 flex flex-col gap-1 ${
          isDragging ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        } ${onSelect ? 'left-5' : ''}`}
        title={t('taskCard.dragToSort')}
      >
        <span className="h-0.5 w-1.5 rounded-full bg-zinc-400" />
        <span className="h-0.5 w-1.5 rounded-full bg-zinc-400" />
        <span className="h-0.5 w-1.5 rounded-full bg-zinc-400" />
      </div>

        <div className={`flex items-start justify-between gap-3 ${onSelect ? 'pl-6' : 'pl-3'}`}>
        <div className="flex-1 min-w-0">
          <div className="mb-1.5 flex items-center gap-2">
            <span
              className={`inline-block h-2 w-2 rounded-full flex-shrink-0 ${
                task.priority === 'high' ? 'bg-red-500 shadow-sm shadow-red-500/50' :
                task.priority === 'medium' ? 'bg-yellow-500 shadow-sm shadow-yellow-500/50' :
                'bg-green-500 shadow-sm shadow-green-500/50'
              }`}
            />
            <span className="text-xs text-zinc-400 dark:text-zinc-500 font-mono">
              #{String(task.id || '').slice(-6)}
            </span>
          </div>
          <h3 className="font-semibold text-zinc-800 dark:text-zinc-100 break-words leading-snug">
            {searchQuery ? highlightText(task.title || 'Untitled', searchQuery) : task.title || 'Untitled'}
          </h3>
        </div>
        <div className="flex items-center gap-1 relative">
          {(onArchive || onDelete || onMoveToColumn) && (
            <button
              type="button"
              onMouseDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                setShowMoreMenu(!showMoreMenu);
              }}
              className="flex-shrink-0 rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-700 dark:hover:text-zinc-300 z-10 relative transition-colors"
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
              className="absolute right-0 top-full mt-1 w-40 rounded-md bg-white dark:bg-zinc-700 shadow-lg ring-1 ring-zinc-200 dark:ring-zinc-600 z-20"
              onMouseDown={(e) => e.stopPropagation()}
            >
              {onMoveToColumn && columns && (
                <div className="relative">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowMoveSubmenu(!showMoveSubmenu);
                    }}
                    className="w-full text-left px-3 py-2 text-sm text-blue-500 hover:bg-zinc-100 dark:hover:bg-zinc-600 rounded-t-md flex items-center justify-between"
                  >
                    <span>{t('taskCard.moveToColumn')}</span>
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={showMoveSubmenu ? 'rotate-90' : ''}>
                      <polyline points="9 18 15 12 9 6"/>
                    </svg>
                  </button>
                  {showMoveSubmenu && (
                    <div className="absolute left-full top-0 ml-1 w-36 rounded-md bg-white dark:bg-zinc-700 shadow-lg ring-1 ring-zinc-200 dark:ring-zinc-600 z-30">
                      {columns.filter(col => col.id !== task.columnId).map(col => (
                        <button
                          key={col.id}
                          onClick={(e) => {
                            e.stopPropagation();
                            onMoveToColumn(task.id, col.id);
                            setShowMoreMenu(false);
                            setShowMoveSubmenu(false);
                          }}
                          className="w-full text-left px-3 py-2 text-sm text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-600 first:rounded-t-md last:rounded-b-md"
                        >
                          {col.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
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
                      title: t('taskModal.confirmDeleteTitle'),
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
            className="flex-shrink-0 rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-700 dark:hover:text-zinc-300 z-10 relative transition-colors"
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
        <div className="mb-3 pl-3">
          <p
            className={`text-sm text-zinc-500 dark:text-zinc-400 cursor-pointer hover:text-zinc-600 dark:hover:text-zinc-300 transition-all leading-relaxed ${
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
              className="mt-1 text-xs text-blue-500 hover:text-blue-600 font-medium"
            >
              {isExpanded ? t('taskCard.collapse') : t('taskCard.expand')}
            </button>
          )}
        </div>
      )}
      {/* Subtasks preview */}
      {task.subtasks && task.subtasks.length > 0 && (
        <div className="mb-3 pl-3 space-y-1.5">
          {task.subtasks.slice(0, 3).map((subtask) => (
            <div key={subtask.id} className="flex items-center gap-2 text-xs">
              <span className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${subtask.completed ? 'bg-green-500' : 'bg-zinc-300 dark:bg-zinc-600'}`} />
              <span className={subtask.completed ? 'text-zinc-400 dark:text-zinc-500 line-through truncate' : 'text-zinc-600 dark:text-zinc-300 truncate'}>
                {subtask.title}
              </span>
            </div>
          ))}
          {task.subtasks.length > 3 && (
            <span className="text-xs text-zinc-400 dark:text-zinc-500">{t('taskCard.moreSubtasks', { count: task.subtasks.length - 3 })}</span>
          )}
        </div>
      )}
      <div className="flex items-center justify-between pl-3 pt-1 border-t border-zinc-100 dark:border-zinc-700/50">
        <div className="flex items-center gap-2.5">
          {columnName === t('task.status.done') && (
            <span className="text-green-500" title={t('taskCard.completed')}>✓</span>
          )}
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
              priorityColors[task.priority] || priorityColors.medium
            }`}
          >
            {task.priority === 'high' ? t('task.priority.high') : task.priority === 'medium' ? t('task.priority.medium') : t('task.priority.low')}
          </span>
          {task.subtasks && task.subtasks.length > 0 && (
            <span className="text-xs text-zinc-400 dark:text-zinc-500">
              ✓ {task.subtasks.filter((s) => s.completed).length}/{task.subtasks.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {task.assignee && (
            <span className="text-xs text-zinc-400 dark:text-zinc-500">{task.assignee}</span>
          )}
          {((task._count?.comments ?? 0) > 0 || (task.comments && task.comments.length > 0)) && (
            <span
              className="flex items-center gap-1 cursor-pointer text-xs text-zinc-400 hover:text-blue-500 transition-colors"
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
              {task._count?.comments ?? task.comments?.length ?? 0}
            </span>
          )}
        </div>
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
