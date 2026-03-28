import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useState } from 'react';
import type { Task } from '@/types/kanban';

interface TaskCardProps {
  task: Task;
  columnName?: string;
  onClick: () => void;
  onCommentsClick?: () => void;
}

const priorityColors: Record<string, string> = {
  high: 'bg-red-100 text-red-700',
  medium: 'bg-yellow-100 text-yellow-700',
  low: 'bg-green-100 text-green-700',
};

export function TaskCard({ task, columnName, onClick, onCommentsClick }: TaskCardProps) {
  const taskId = task?.id ?? `temp-${Math.random().toString(36).slice(2)}`;
  const [isExpanded, setIsExpanded] = useState(false);

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
      className={`group relative cursor-grab rounded-lg bg-white p-3 shadow-sm transition-all hover:shadow-md active:cursor-grabbing ${
        isDragging ? 'opacity-60 ring-2 ring-blue-400 scale-105 z-50' : ''
      }`}
    >
      {/* Drag indicator */}
      <div
        className={`absolute left-1 top-1/2 -translate-y-1/2 flex flex-col gap-0.5 ${
          isDragging ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        }`}
        title="拖拽排序"
      >
        <span className="h-0.5 w-1 rounded-full bg-zinc-400" />
        <span className="h-0.5 w-1 rounded-full bg-zinc-400" />
        <span className="h-0.5 w-1 rounded-full bg-zinc-400" />
      </div>

      <div className="flex items-start justify-between gap-2 pl-3">
        <div className="flex-1">
          <span className="mb-1 block text-xs text-zinc-400 font-mono">#{String(task.id || '').slice(-6)}</span>
          <h3 className="font-medium text-zinc-800">{task.title || 'Untitled'}</h3>
        </div>
        <button
          type="button"
          onMouseDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onClick();
          }}
          className="flex-shrink-0 rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 z-10 relative"
          title="查看详情"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <path d="M12 16v-4"/>
            <path d="M12 8h.01"/>
          </svg>
        </button>
      </div>
      {task.description && typeof task.description === 'string' && (
        <div className="mb-2 pl-3">
          <p
            className={`text-sm text-zinc-500 cursor-pointer hover:text-zinc-600 transition-all ${
              isExpanded ? '' : 'line-clamp-2'
            }`}
            onClick={(e) => {
              e.stopPropagation();
              setIsExpanded(!isExpanded);
            }}
            title={isExpanded ? '点击收起' : '点击展开'}
          >
            {task.description}
          </p>
          {task.description.length > 50 && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setIsExpanded(!isExpanded);
              }}
              className="mt-1 text-xs text-blue-500 hover:text-blue-600"
            >
              {isExpanded ? '收起' : '展开'}
            </button>
          )}
        </div>
      )}
      {/* Subtasks preview */}
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
          {columnName === '已完成' && (
            <span className="text-green-500" title="已完成">✓</span>
          )}
          <span
            className={`rounded px-2 py-0.5 text-xs font-medium ${
              priorityColors[task.priority] || priorityColors.medium
            }`}
          >
            {task.priority === 'high' ? '高' : task.priority === 'medium' ? '中' : '低'}
          </span>
          {task.subtasks && task.subtasks.length > 0 && (
            <span className="text-xs text-zinc-400">
              ✓ {task.subtasks.filter((s) => s.completed).length}/{task.subtasks.length}
            </span>
          )}
        </div>
        {task.assignee && (
          <span className="text-xs text-zinc-400">{task.assignee}</span>
        )}
        {task.comments && task.comments.length > 0 && (
          <span
            className="cursor-pointer text-xs text-zinc-400 hover:text-blue-500"
            onClick={(e) => {
              e.stopPropagation();
              onCommentsClick ? onCommentsClick() : onClick();
            }}
          >
            💬 {task.comments.length}
          </span>
        )}
      </div>
    </div>
  );
}
