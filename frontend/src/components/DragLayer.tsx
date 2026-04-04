import { DragOverlay } from '@dnd-kit/core';
import { TaskCard } from './TaskCard';
import type { Task } from '@/types/kanban';

interface DragLayerProps {
  activeTask: Task | null;
}

export function DragLayer({ activeTask }: DragLayerProps) {
  return (
    <DragOverlay>
      {activeTask && <TaskCard task={activeTask} onClick={() => {}} />}
    </DragOverlay>
  );
}