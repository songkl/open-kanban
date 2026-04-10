import { create } from 'zustand';
import type { Board } from '../types/kanban';
import { boardsApi } from '../services/api';

interface BoardState {
  boards: Board[];
  currentBoard: Board | null;
  loading: boolean;
  loadError: string | null;

  setBoards: (boards: Board[]) => void;
  setCurrentBoard: (board: Board | null) => void;
  fetchBoards: () => Promise<void>;
}

export const useBoardStore = create<BoardState>((set) => ({
  boards: [],
  currentBoard: null,
  loading: true,
  loadError: null,

  setBoards: (boards) => set({ boards }),
  setCurrentBoard: (board) => set({ currentBoard: board }),

  fetchBoards: async () => {
    try {
      const data = await boardsApi.getAll();
      set({ boards: data || [], loading: false, loadError: null });
    } catch (error) {
      console.error('Failed to fetch boards:', error);
      set({ loadError: error instanceof Error ? error.message : 'Failed to load boards', loading: false });
    }
  },
}));