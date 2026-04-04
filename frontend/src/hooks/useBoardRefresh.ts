import { useRef, useCallback } from 'react';
import { tasksApi } from '../services/api';
import type { Column as ColumnType, Task } from '../types/kanban';

interface UseBoardRefreshOptions {
  columns: ColumnType[];
  onColumnsChange: React.Dispatch<React.SetStateAction<ColumnType[]>>;
}

interface UseBoardRefreshReturn {
  lastLocalUpdateRef: React.MutableRefObject<number>;
  offlineQueueRef: React.MutableRefObject<Array<{ action: string; data: any; timestamp: number }>>;
  isProcessingQueueRef: React.MutableRefObject<boolean>;
  processOfflineQueue: () => Promise<void>;
  handleTaskNotificationUpdate: (taskId: string) => Promise<void>;
}

export function useBoardRefresh({ columns, onColumnsChange }: UseBoardRefreshOptions): UseBoardRefreshReturn {
  const lastLocalUpdateRef = useRef<number>(0);
  const offlineQueueRef = useRef<Array<{ action: string; data: any; timestamp: number }>>([]);
  const isProcessingQueueRef = useRef<boolean>(false);

  const handleTaskNotificationUpdate = useCallback(async (taskId: string) => {
    try {
      const updatedTask = await tasksApi.getById(taskId);
      if (!updatedTask) return;

      const parsedTask: Task = {
        ...updatedTask,
        meta: typeof updatedTask.meta === 'string' ? JSON.parse(updatedTask.meta || '{}') : updatedTask.meta || null,
      };

      const oldColumn = columns.find(col => col.tasks.some(t => t.id === taskId));
      const newColumnId = parsedTask.columnId;

      if (oldColumn && oldColumn.id !== newColumnId) {
        onColumnsChange(cols => cols.map(col => {
          if (col.id === oldColumn.id) {
            return { ...col, tasks: col.tasks.filter(t => t.id !== taskId) };
          }
          if (col.id === newColumnId) {
            return { ...col, tasks: [...col.tasks, parsedTask] };
          }
          return col;
        }));
      } else if (oldColumn) {
        onColumnsChange(cols => cols.map(col => ({
          ...col,
          tasks: col.tasks.map(t => t.id === taskId ? parsedTask : t)
        })));
      }
    } catch (error) {
      console.error('Failed to handle task notification update:', error);
    }
  }, [columns, onColumnsChange]);

  const processOfflineQueue = useCallback(async () => {
    if (isProcessingQueueRef.current || offlineQueueRef.current.length === 0) return;
    isProcessingQueueRef.current = true;
    const queue = [...offlineQueueRef.current];
    offlineQueueRef.current = [];
    console.log(`Processing ${queue.length} offline actions`);
    for (const item of queue) {
      try {
        switch (item.action) {
          case 'updateTask':
            await tasksApi.update(item.data.id, item.data);
            break;
          case 'deleteTask':
            await tasksApi.delete(item.data.id);
            break;
          case 'archiveTask':
            await tasksApi.archive(item.data.id, true);
            break;
          case 'addTask':
            await tasksApi.create(item.data);
            break;
        }
      } catch (error) {
        console.error(`Failed to process offline action ${item.action}:`, error);
        offlineQueueRef.current.push(item);
      }
    }
    isProcessingQueueRef.current = false;
    if (offlineQueueRef.current.length > 0) {
      console.log(`${offlineQueueRef.current.length} actions failed, keeping in queue`);
    }
  }, []);

  return {
    lastLocalUpdateRef,
    offlineQueueRef,
    isProcessingQueueRef,
    processOfflineQueue,
    handleTaskNotificationUpdate,
  };
}