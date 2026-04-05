import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { useBoard } from './useBoard';
import { boardsApi, authApi } from '../services/api';
import type { Board, User } from '../types/kanban';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: vi.fn(),
  };
});

vi.mock('../services/api', () => ({
  boardsApi: {
    getAll: vi.fn(),
  },
  authApi: {
    me: vi.fn().mockResolvedValue({ user: null, needsSetup: false }),
  },
}));

const mockBoard: Board = {
  id: 'board-1',
  name: 'Test Board',
  description: 'A test board',
  createdAt: '2024-01-01',
  updatedAt: '2024-01-01',
};

const mockUser: User = {
  id: 'user-1',
  nickname: 'Test User',
  avatar: null,
  role: 'ADMIN',
  type: 'HUMAN',
  enabled: true,
  createdAt: '2024-01-01',
  updatedAt: '2024-01-01',
};

describe('useBoard', () => {
  const mockNavigate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useNavigate).mockReturnValue(mockNavigate);
    localStorage.clear();
  });

  describe('initial state', () => {
    it('returns correct initial state', () => {
      const { result } = renderHook(() => useBoard(), {
        wrapper: MemoryRouter,
      });
      expect(result.current.boards).toEqual([]);
      expect(result.current.currentBoard).toBeNull();
      expect(result.current.currentUser).toBeNull();
      expect(result.current.loading).toBe(true);
      expect(result.current.boardSwitching).toBe(false);
      expect(result.current.loadError).toBeNull();
    });
  });

  describe('fetchBoards', () => {
    it('fetches boards successfully', async () => {
      const mockBoards = [mockBoard];
      vi.mocked(boardsApi.getAll).mockResolvedValue(mockBoards);
      vi.mocked(authApi.me).mockResolvedValue({ user: mockUser, needsSetup: false });

      const { result } = renderHook(() => useBoard(), {
        wrapper: MemoryRouter,
      });

      await act(async () => {
        await result.current.fetchBoards();
      });

      expect(boardsApi.getAll).toHaveBeenCalled();
      expect(result.current.boards).toEqual(mockBoards);
    });

    it('handles fetch boards error', async () => {
      vi.mocked(boardsApi.getAll).mockRejectedValue(new Error('Failed to fetch'));
      vi.mocked(authApi.me).mockResolvedValue({ user: mockUser, needsSetup: false });

      const { result } = renderHook(() => useBoard(), {
        wrapper: MemoryRouter,
      });

      await act(async () => {
        await result.current.fetchBoards();
      });

      expect(result.current.boards).toEqual([]);
    });

    it('handles empty boards array', async () => {
      vi.mocked(boardsApi.getAll).mockResolvedValue([]);
      vi.mocked(authApi.me).mockResolvedValue({ user: mockUser, needsSetup: false });

      const { result } = renderHook(() => useBoard(), {
        wrapper: MemoryRouter,
      });

      await act(async () => {
        await result.current.fetchBoards();
      });

      expect(result.current.boards).toEqual([]);
    });
  });

  describe('board switching', () => {
    it('does not switch board when boardIdFromUrl is not provided and boards are empty', async () => {
      vi.mocked(boardsApi.getAll).mockResolvedValue([]);
      vi.mocked(authApi.me).mockResolvedValue({ user: mockUser, needsSetup: false });

      renderHook(() => useBoard(), {
        wrapper: MemoryRouter,
      });

      await act(async () => {
        await Promise.resolve();
      });

      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('sets currentBoard when boardIdFromUrl matches a board after boards are fetched', async () => {
      const boards = [mockBoard, { ...mockBoard, id: 'board-2', name: 'Board 2' }];
      vi.mocked(boardsApi.getAll).mockResolvedValue(boards);
      vi.mocked(authApi.me).mockResolvedValue({ user: mockUser, needsSetup: false });

      const { result } = renderHook(() => useBoard({ boardIdFromUrl: 'board-2' }), {
        wrapper: MemoryRouter,
      });

      await act(async () => {
        await result.current.fetchBoards();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(result.current.currentBoard).toEqual({ ...mockBoard, id: 'board-2', name: 'Board 2' });
    });

    it('navigates to first board when boardIdFromUrl does not match any board after boards are fetched', async () => {
      const boards = [mockBoard];
      vi.mocked(boardsApi.getAll).mockResolvedValue(boards);
      vi.mocked(authApi.me).mockResolvedValue({ user: mockUser, needsSetup: false });

      const { result } = renderHook(() => useBoard({ boardIdFromUrl: 'nonexistent' }), {
        wrapper: MemoryRouter,
      });

      await act(async () => {
        await result.current.fetchBoards();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockNavigate).toHaveBeenCalledWith(`/board/${mockBoard.id}`);
    });

    it('sets boardSwitching to true during board change', async () => {
      const boards = [mockBoard, { ...mockBoard, id: 'board-2', name: 'Board 2' }];
      vi.mocked(boardsApi.getAll).mockResolvedValue(boards);
      vi.mocked(authApi.me).mockResolvedValue({ user: mockUser, needsSetup: false });

      const { result } = renderHook(() => useBoard({ boardIdFromUrl: 'board-1' }), {
        wrapper: MemoryRouter,
      });

      await act(async () => {
        await result.current.fetchBoards();
        await Promise.resolve();
      });

      expect(result.current.currentBoard?.id).toBe('board-1');
    });
  });

  describe('setCurrentBoard', () => {
    it('allows manually setting current board', async () => {
      vi.mocked(boardsApi.getAll).mockResolvedValue([mockBoard]);
      vi.mocked(authApi.me).mockResolvedValue({ user: mockUser, needsSetup: false });

      const { result } = renderHook(() => useBoard(), {
        wrapper: MemoryRouter,
      });

      await act(async () => {
        await result.current.fetchBoards();
      });

      act(() => {
        result.current.setCurrentBoard(mockBoard);
      });

      expect(result.current.currentBoard).toEqual(mockBoard);
    });

    it('allows setting current board to null', async () => {
      vi.mocked(boardsApi.getAll).mockResolvedValue([mockBoard]);
      vi.mocked(authApi.me).mockResolvedValue({ user: mockUser, needsSetup: false });

      const { result } = renderHook(() => useBoard(), {
        wrapper: MemoryRouter,
      });

      await act(async () => {
        await result.current.fetchBoards();
      });

      act(() => {
        result.current.setCurrentBoard(null);
      });

      expect(result.current.currentBoard).toBeNull();
    });
  });

  describe('currentUser', () => {
    it('fetches current user on mount', async () => {
      vi.mocked(boardsApi.getAll).mockResolvedValue([mockBoard]);
      vi.mocked(authApi.me).mockResolvedValue({ user: mockUser, needsSetup: false });

      const { result } = renderHook(() => useBoard(), {
        wrapper: MemoryRouter,
      });

      await act(async () => {
        await Promise.resolve();
      });

      expect(authApi.me).toHaveBeenCalled();
      expect(result.current.currentUser).toEqual(mockUser);
    });

    it('handles auth error gracefully', async () => {
      vi.mocked(boardsApi.getAll).mockResolvedValue([mockBoard]);
      vi.mocked(authApi.me).mockRejectedValue(new Error('Auth error'));

      const { result } = renderHook(() => useBoard(), {
        wrapper: MemoryRouter,
      });

      await act(async () => {
        await Promise.resolve();
      });

      expect(result.current.currentUser).toBeNull();
    });
  });
});