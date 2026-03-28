import { useDroppable } from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { TaskCard } from './TaskCard';
import type { Column as ColumnType, Task } from '@/types/kanban';

interface ColumnProps {
  column: ColumnType;
  currentBoardId?: string;
  boards?: Board[];
  onAddTask: (columnId: string, title: string, description: string, published: boolean) => void;
  onTaskClick: (task: Task) => void;
  onTaskCommentsClick?: (task: Task) => void;
  onOpenAddTask?: () => void;
}

interface Board {
  id: string;
  name: string;
}

export function Column({ column, onTaskClick, onTaskCommentsClick, onOpenAddTask }: ColumnProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: column?.id ?? 'null',
  });

  const tasks = column?.tasks ?? [];

  const handleOpenAddTask = () => {
    if (onOpenAddTask) {
      onOpenAddTask();
    }
  };

  if (!column) {
    return null;
  }

  return (
    <>
      <div
        ref={setNodeRef}
        className={`relative flex w-80 flex-shrink-0 flex-col rounded-lg bg-zinc-200/50 ${
          isOver ? 'ring-2 ring-blue-400 z-10' : ''
        }`}
      >
        <div
          className="flex items-center gap-2 rounded-t-lg px-4 py-3"
          style={{ backgroundColor: column.color + '20' }}
        >
          <div
            className="h-3 w-3 rounded-full"
            style={{ backgroundColor: column.color }}
          />
          <h2 className="font-semibold text-zinc-700">{column.name}</h2>
          <span className="ml-auto text-sm text-zinc-500">
            {tasks.length}
          </span>
        </div>

        <div className="flex-1 space-y-2 overflow-y-auto p-2">
          <SortableContext
            items={tasks.map((t) => t.id)}
            strategy={verticalListSortingStrategy}
          >
            {tasks.length === 0 ? (
              <div className="py-8 text-center text-sm text-zinc-400">
                暂无任务
              </div>
            ) : (
              tasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  columnName={column.name}
                  onClick={() => onTaskClick(task)}
                  onCommentsClick={() => onTaskCommentsClick ? onTaskCommentsClick(task) : onTaskClick(task)}
                />
              ))
            )}
          </SortableContext>
        </div>

        <div className="p-2">
          <button
            onClick={handleOpenAddTask}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-zinc-500 hover:bg-zinc-200/50"
          >
            <span>+</span> 添加任务
          </button>
        </div>
      </div>
    </>
  );
}
