import { create } from 'zustand';
import type { Task, Comment } from '../types/kanban';
import { tasksApi, commentsApi } from '../services/api';

interface TaskState {
  activeTask: Task | null;
  selectedTask: Task | null;
  selectedTasks: Set<string>;
  lastSelectedTaskId: string | null;

  setActiveTask: (task: Task | null) => void;
  setSelectedTask: (task: Task | null) => void;
  setSelectedTasks: (tasks: Set<string>) => void;
  toggleTaskSelection: (taskId: string) => void;
  selectTasks: (taskIds: string[]) => void;
  clearSelection: () => void;
  setLastSelectedTaskId: (id: string | null) => void;

  updateTask: (task: Task) => Promise<Task>;
  deleteTask: (taskId: string) => Promise<void>;
  archiveTask: (taskId: string) => Promise<void>;
  addComment: (taskId: string, content: string, author: string) => Promise<Comment>;
}

export const useTaskStore = create<TaskState>((set) => ({
  activeTask: null,
  selectedTask: null,
  selectedTasks: new Set(),
  lastSelectedTaskId: null,

  setActiveTask: (task) => set({ activeTask: task }),
  setSelectedTask: (task) => set({ selectedTask: task }),
  setSelectedTasks: (tasks) => set({ selectedTasks: tasks }),
  toggleTaskSelection: (taskId) => set((state) => {
    const newSet = new Set(state.selectedTasks);
    if (newSet.has(taskId)) {
      newSet.delete(taskId);
    } else {
      newSet.add(taskId);
    }
    return { selectedTasks: newSet };
  }),
  selectTasks: (taskIds) => set({ selectedTasks: new Set(taskIds) }),
  clearSelection: () => set({ selectedTasks: new Set(), lastSelectedTaskId: null }),
  setLastSelectedTaskId: (id) => set({ lastSelectedTaskId: id }),

  updateTask: async (task) => {
    try {
      const updated = await tasksApi.update(task.id, {
        title: task.title,
        description: task.description,
        priority: task.priority,
        assignee: task.assignee,
        columnId: task.columnId,
        position: task.position ?? 0,
        published: task.published,
        meta: task.meta,
      });

      const parsedUpdated = {
        ...updated,
        meta: typeof updated.meta === 'string' ? JSON.parse(updated.meta || '{}') : updated.meta || null,
      };

      return parsedUpdated;
    } catch (error) {
      console.error('Failed to update task:', error);
      throw error;
    }
  },

  deleteTask: async (taskId) => {
    await tasksApi.delete(taskId);
  },

  archiveTask: async (taskId) => {
    await tasksApi.archive(taskId, true);
  },

  addComment: async (taskId, content, author) => {
    const comment = await commentsApi.create({ taskId, content, author });
    return comment;
  },
}));