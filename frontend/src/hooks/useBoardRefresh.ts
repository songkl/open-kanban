import { useRef, useCallback, useEffect } from 'react';
import { tasksApi } from '../services/api';
import type { Column as ColumnType, Task } from '../types/kanban';

interface UseBoardRefreshOptions {
  columns: ColumnType[];
  onColumnsChange: React.Dispatch<React.SetStateAction<ColumnType[]>>;
}

interface OfflineQueueItem {
  action: string;
  data: unknown;
  timestamp: number;
}

interface UpdateTaskData { id: string; [key: string]: unknown }
interface DeleteTaskData { id: string }
interface ArchiveTaskData { id: string }
interface AddTaskData { title: string; description?: string; columnId: string; position?: number; priority?: string; published?: boolean; agentId?: string; agentPrompt?: string }

interface UseBoardRefreshReturn {
  lastLocalUpdateRef: React.MutableRefObject<number>;
  offlineQueueRef: React.MutableRefObject<OfflineQueueItem[]>;
  isProcessingQueueRef: React.MutableRefObject<boolean>;
  processOfflineQueue: () => Promise<void>;
  handleTaskNotificationUpdate: (taskId: string) => Promise<void>;
}

export function useBoardRefresh({ columns, onColumnsChange }: UseBoardRefreshOptions): UseBoardRefreshReturn {
  const lastLocalUpdateRef = useRef<number>(0);
  const offlineQueueRef = useRef<Array<{ action: string; data: unknown; timestamp: number }>>([]);
  const isProcessingQueueRef = useRef<boolean>(false);
  const columnsRef = useRef(columns);
  useEffect(() => {
    columnsRef.current = columns;
  }, [columns]);

  const handleTaskNotificationUpdate = useCallback(async (taskId: string) => {
    try {
      const updatedTask = await tasksApi.getById(taskId);
      if (!updatedTask) return;

      const parsedTask: Task = {
        ...updatedTask,
        meta: typeof updatedTask.meta === 'string' ? JSON.parse(updatedTask.meta || '{}') : updatedTask.meta || null,
        _count: {
          comments: (updatedTask as { commentCount?: number }).commentCount ?? updatedTask._count?.comments,
          subtasks: (updatedTask as { subtaskCount?: number }).subtaskCount ?? updatedTask._count?.subtasks,
        },
      };

      const currentColumns = columnsRef.current;
      const oldColumn = currentColumns.find(col => col.tasks.some(t => t.id === taskId));
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
      } else if (currentColumns.some(col => col.id === newColumnId)) {
        onColumnsChange(cols => cols.map(col => {
          if (col.id === newColumnId) {
            return { ...col, tasks: [...col.tasks, parsedTask] };
          }
          return col;
        }));
      }
    } catch (error) {
      console.error('Failed to handle task notification update:', error);
    }
  }, [onColumnsChange]);

  const processOfflineQueue = useCallback(async () => {
    if (isProcessingQueueRef.current || offlineQueueRef.current.length === 0) return;
    isProcessingQueueRef.current = true;
    const queue = [...offlineQueueRef.current];
    offlineQueueRef.current = [];
    console.log(`Processing ${queue.length} offline actions`);
    for (const item of queue) {
      try {
        switch (item.action) {
          case 'updateTask': {
            const data = item.data as UpdateTaskData;
            await tasksApi.update(data.id, data);
            break;
          }
          case 'deleteTask': {
            const data = item.data as DeleteTaskData;
            await tasksApi.delete(data.id);
            break;
          }
          case 'archiveTask': {
            const data = item.data as ArchiveTaskData;
            await tasksApi.archive(data.id, true);
            break;
          }
          case 'addTask': {
            const data = item.data as AddTaskData;
            await tasksApi.create(data);
            break;
          }
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