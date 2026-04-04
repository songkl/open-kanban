import { useState, useCallback } from 'react';

export interface DragState {
  isDragging: boolean;
  draggedTaskId: string | null;
  sourceColumnId: string | null;
}

interface UseDragDropReturn {
  dragState: DragState;
  startDrag: (taskId: string, columnId: string) => void;
  endDrag: () => void;
}

export function useDragDrop(): UseDragDropReturn {
  const [dragState, setDragState] = useState<DragState>({
    isDragging: false,
    draggedTaskId: null,
    sourceColumnId: null,
  });

  const startDrag = useCallback((taskId: string, columnId: string) => {
    setDragState({
      isDragging: true,
      draggedTaskId: taskId,
      sourceColumnId: columnId,
    });
  }, []);

  const endDrag = useCallback(() => {
    setDragState({
      isDragging: false,
      draggedTaskId: null,
      sourceColumnId: null,
    });
  }, []);

  return {
    dragState,
    startDrag,
    endDrag,
  };
}