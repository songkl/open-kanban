import { useEffect } from 'react';
import type { Task, Column as ColumnType } from '../types/kanban';

interface KeyboardNavigationProps {
  selectedTask: Task | null;
  selectedTasks: Set<string>;
  showAddTaskModal: boolean;
  columns: ColumnType[];
  focusedColumnIndex: number;
  focusedTaskIndex: number;
  onSetFocusedColumnIndex: (index: number) => void;
  onSetFocusedTaskIndex: (index: number) => void;
  onSetShowAddTaskModal: (show: boolean) => void;
  onSetDefaultColumnIdForNewTask: (id: string | undefined) => void;
  onSetEditTaskId: (id: string | null) => void;
  onSetSelectedTask: (task: Task | null) => void;
  onHandleTaskSelect: (id: string, task: Task) => void;
  onClearSelection: () => void;
  onArchiveTask: (id: string) => void;
  onDeleteTask: (id: string) => void;
}

export function KeyboardNavigation({
  selectedTask,
  selectedTasks,
  showAddTaskModal,
  columns,
  focusedColumnIndex,
  focusedTaskIndex,
  onSetFocusedColumnIndex,
  onSetFocusedTaskIndex,
  onSetShowAddTaskModal,
  onSetDefaultColumnIdForNewTask,
  onSetEditTaskId,
  onSetSelectedTask,
  onHandleTaskSelect,
  onClearSelection,
  onArchiveTask,
  onDeleteTask,
}: KeyboardNavigationProps) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'n') {
        e.preventDefault();
        onSetShowAddTaskModal(true);
        return;
      }

      const target = e.target as HTMLElement;
      const isInputFocused =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable;

      if (e.key === '/' && !isInputFocused) {
        e.preventDefault();
        return;
      }

      if (e.key === 'e' && !isInputFocused && selectedTask) {
        e.preventDefault();
        onSetEditTaskId(selectedTask.id);
        return;
      }

      if ((e.key === 'n' || e.key === 'N') && !isInputFocused) {
        e.preventDefault();
        onSetShowAddTaskModal(true);
        return;
      }

      if (e.key === 'Escape') {
        if (showAddTaskModal) {
          onSetShowAddTaskModal(false);
          onSetDefaultColumnIdForNewTask(undefined);
        } else if (selectedTask) {
          onSetSelectedTask(null);
          onSetEditTaskId(null);
        } else if (selectedTasks.size > 0) {
          onClearSelection();
        }
        return;
      }

      if (isInputFocused) return;

      const currentColumn = columns[focusedColumnIndex];
      const columnTasks = currentColumn?.tasks || [];

      if (e.key === 'j' || e.key === 'J') {
        e.preventDefault();
        if (columnTasks.length === 0) return;
        const newIndex = Math.min(focusedTaskIndex + 1, columnTasks.length - 1);
        onSetFocusedTaskIndex(newIndex);
        const task = columnTasks[newIndex];
        if (task) onHandleTaskSelect(task.id, task);
        return;
      }

      if (e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        if (columnTasks.length === 0) return;
        const newIndex = Math.max(focusedTaskIndex - 1, 0);
        onSetFocusedTaskIndex(newIndex);
        const task = columnTasks[newIndex];
        if (task) onHandleTaskSelect(task.id, task);
        return;
      }

      if (e.key === 'h' || e.key === 'H') {
        e.preventDefault();
        if (columns.length === 0) return;
        const newColIndex = Math.max(focusedColumnIndex - 1, 0);
        onSetFocusedColumnIndex(newColIndex);
        const col = columns[newColIndex];
        if (col.tasks && col.tasks.length > 0) {
          onSetFocusedTaskIndex(0);
          onHandleTaskSelect(col.tasks[0].id, col.tasks[0]);
        }
        return;
      }

      if (e.key === 'l' || e.key === 'L') {
        e.preventDefault();
        if (columns.length === 0) return;
        const newColIndex = Math.min(focusedColumnIndex + 1, columns.length - 1);
        onSetFocusedColumnIndex(newColIndex);
        const col = columns[newColIndex];
        if (col.tasks && col.tasks.length > 0) {
          onSetFocusedTaskIndex(0);
          onHandleTaskSelect(col.tasks[0].id, col.tasks[0]);
        }
        return;
      }

      if ((e.key === 'd' || e.key === 'D') && selectedTask) {
        e.preventDefault();
        onArchiveTask(selectedTask.id);
        return;
      }

      if (e.key === 'Delete' && selectedTask) {
        e.preventDefault();
        onDeleteTask(selectedTask.id);
        return;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [
    selectedTask,
    selectedTasks,
    showAddTaskModal,
    columns,
    focusedColumnIndex,
    focusedTaskIndex,
    onSetShowAddTaskModal,
    onSetDefaultColumnIdForNewTask,
    onSetEditTaskId,
    onSetSelectedTask,
    onHandleTaskSelect,
    onClearSelection,
    onArchiveTask,
    onDeleteTask,
    onSetFocusedColumnIndex,
    onSetFocusedTaskIndex,
  ]);

  return null;
}
