import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Column as ColumnType, Task } from '../types/kanban';
import type { FilterState } from './filterStore';

const DARK_MODE_KEY = 'darkMode';

interface UIStore {
  darkMode: boolean;
  isMobile: boolean;
  activeMobileColumn: number;
  mobileViewMode: 'tabs' | 'scroll';
  showAddTaskModal: boolean;
  defaultColumnIdForNewTask: string | undefined;
  editTaskId: string | null;
  focusedColumnIndex: number;
  focusedTaskIndex: number;
  toast: string | null;

  setDarkMode: (dark: boolean) => void;
  toggleDarkMode: () => void;
  setIsMobile: (mobile: boolean) => void;
  setActiveMobileColumn: (index: number) => void;
  setMobileViewMode: (mode: 'tabs' | 'scroll') => void;
  setShowAddTaskModal: (show: boolean, defaultColumnId?: string) => void;
  setEditTaskId: (id: string | null) => void;
  setFocusedColumnIndex: (index: number) => void;
  setFocusedTaskIndex: (index: number) => void;
  showToast: (message: string) => void;
  clearToast: () => void;

  getFilteredColumns: (columns: ColumnType[], filters: FilterState) => ColumnType[];
  isInDateRange: (taskCreatedAt: string, dateRange: string) => boolean;
}

const getInitialDarkMode = () => {
  if (typeof window === 'undefined') return false;
  const saved = localStorage.getItem(DARK_MODE_KEY);
  return saved === 'true' || window.matchMedia('(prefers-color-scheme: dark)').matches;
};

export const useUIStore = create<UIStore>()(
  persist(
    (set, get) => ({
      darkMode: typeof window !== 'undefined' ? getInitialDarkMode() : false,
      isMobile: typeof window !== 'undefined' ? window.innerWidth < 768 : false,
      activeMobileColumn: 0,
      mobileViewMode: 'tabs',
      showAddTaskModal: false,
      defaultColumnIdForNewTask: undefined,
      editTaskId: null,
      focusedColumnIndex: 0,
      focusedTaskIndex: 0,
      toast: null,

      setDarkMode: (dark) => {
        set({ darkMode: dark });
        if (typeof document !== 'undefined') {
          if (dark) {
            document.documentElement.classList.add('dark');
          } else {
            document.documentElement.classList.remove('dark');
          }
        }
        localStorage.setItem(DARK_MODE_KEY, String(dark));
      },

      toggleDarkMode: () => {
        const newDark = !get().darkMode;
        get().setDarkMode(newDark);
      },

      setIsMobile: (mobile) => set({ isMobile: mobile }),
      setActiveMobileColumn: (index) => set({ activeMobileColumn: index }),
      setMobileViewMode: (mode) => set({ mobileViewMode: mode }),

      setShowAddTaskModal: (show, defaultColumnId) => set({
        showAddTaskModal: show,
        defaultColumnIdForNewTask: defaultColumnId
      }),

      setEditTaskId: (id) => set({ editTaskId: id }),
      setFocusedColumnIndex: (index) => set({ focusedColumnIndex: index }),
      setFocusedTaskIndex: (index) => set({ focusedTaskIndex: index }),

      showToast: (message) => {
        set({ toast: message });
        setTimeout(() => set({ toast: null }), 2000);
      },

      clearToast: () => set({ toast: null }),

      getFilteredColumns: (columns, filters) => {
        if (!filters.searchQuery && !filters.priority && !filters.assignee && !filters.dateRange && !filters.tag) {
          return columns;
        }

        return columns.map(col => ({
          ...col,
          tasks: (col.tasks || []).filter((task: Task) => {
            if (filters.searchQuery) {
              const query = filters.searchQuery.toLowerCase();
              const titleMatch = task.title.toLowerCase().includes(query);
              const descMatch = (task.description || '').toLowerCase().includes(query);
              if (!titleMatch && !descMatch) return false;
            }
            if (filters.priority && task.priority !== filters.priority) return false;
            if (filters.assignee && task.assignee !== filters.assignee) return false;
            if (filters.dateRange && !get().isInDateRange(task.createdAt, filters.dateRange)) return false;
            if (filters.tag) {
              const taskTag = task.meta && typeof task.meta === 'object' ? task.meta['标签'] : null;
              if (taskTag !== filters.tag) return false;
            }
            return true;
          })
        }));
      },

      isInDateRange: (taskCreatedAt: string, dateRange: string): boolean => {
        if (!dateRange) return true;
        const created = new Date(taskCreatedAt);
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const weekStart = new Date(todayStart);
        weekStart.setDate(weekStart.getDate() - weekStart.getDay());
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

        switch (dateRange) {
          case 'today':
            return created >= todayStart;
          case 'thisWeek':
            return created >= weekStart;
          case 'thisMonth':
            return created >= monthStart;
          default:
            return true;
        }
      },
    }),
    {
      name: 'ui-storage',
      partialize: (state) => ({ mobileViewMode: state.mobileViewMode }),
    }
  )
);

if (typeof window !== 'undefined') {
  const saved = localStorage.getItem(DARK_MODE_KEY);
  const shouldBeDark = saved === 'true' || window.matchMedia('(prefers-color-scheme: dark)').matches;
  if (shouldBeDark) {
    document.documentElement.classList.add('dark');
  }
}
