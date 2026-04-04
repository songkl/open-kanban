import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { columnsApi, tasksApi } from '../services/api';
import type { Column as ColumnType } from '../types/kanban';

export interface ColumnPagination {
  page: number;
  hasMore: boolean;
  isLoadingMore: boolean;
}

interface UseColumnsReturn {
  columns: ColumnType[];
  columnPagination: Record<string, ColumnPagination>;
  fetchColumns: (boardId: string, silent?: boolean) => Promise<void>;
  handleLoadMoreTasks: (columnId: string) => Promise<void>;
  handleColumnRename: (columnId: string, newName: string) => Promise<void>;
  setColumns: React.Dispatch<React.SetStateAction<ColumnType[]>>;
  setColumnPagination: React.Dispatch<React.SetStateAction<Record<string, ColumnPagination>>>;
}

export function useColumns(): UseColumnsReturn {
  const { t } = useTranslation();

  const [columns, setColumns] = useState<ColumnType[]>([]);
  const [columnPagination, setColumnPagination] = useState<Record<string, ColumnPagination>>({});

  const fetchColumns = useCallback(async (boardId: string, _silent = false) => {
    try {
      const data = await columnsApi.getByBoard(boardId);
      setColumns(data.map(col => ({
        ...col,
        tasks: col.tasks?.map(t => ({
          ...t,
          comments: t.comments ?? [],
          subtasks: t.subtasks ?? [],
        })) ?? [],
      })));
      setColumnPagination({});
    } catch (error) {
      console.error('Failed to fetch columns:', error);
    }
  }, [t]);

  const handleLoadMoreTasks = useCallback(async (columnId: string) => {
    const currentPagination = columnPagination[columnId] || { page: 1, hasMore: true, isLoadingMore: false };
    if (currentPagination.isLoadingMore || !currentPagination.hasMore) return;

    setColumnPagination(prev => ({
      ...prev,
      [columnId]: { ...currentPagination, isLoadingMore: true }
    }));

    try {
      const nextPage = currentPagination.page + 1;
      const response = await tasksApi.getByColumn(columnId, nextPage, 20);
      const newTasks = response.data.map(t => ({
        ...t,
        comments: t.comments ?? [],
        subtasks: t.subtasks ?? [],
      }));

      setColumns(prev => prev.map(col => {
        if (col.id === columnId) {
          const existingTaskIds = new Set(col.tasks.map(t => t.id));
          const uniqueNewTasks = newTasks.filter(t => !existingTaskIds.has(t.id));
          return { ...col, tasks: [...col.tasks, ...uniqueNewTasks] };
        }
        return col;
      }));

      setColumnPagination(prev => ({
        ...prev,
        [columnId]: {
          page: nextPage,
          hasMore: nextPage < response.pageCount,
          isLoadingMore: false
        }
      }));
    } catch (error) {
      console.error('Failed to load more tasks:', error);
      setColumnPagination(prev => ({
        ...prev,
        [columnId]: { ...currentPagination, isLoadingMore: false }
      }));
    }
  }, [columnPagination]);

  const handleColumnRename = useCallback(async (columnId: string, newName: string) => {
    try {
      await columnsApi.update(columnId, { name: newName });
      setColumns((cols) =>
        cols.map((col) =>
          col.id === columnId ? { ...col, name: newName } : col
        )
      );
    } catch (error) {
      console.error('Failed to rename column:', error);
    }
  }, []);

  return {
    columns,
    columnPagination,
    fetchColumns,
    handleLoadMoreTasks,
    handleColumnRename,
    setColumns,
    setColumnPagination,
  };
}