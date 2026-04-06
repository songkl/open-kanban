import { useState, useEffect, useCallback, useRef, useMemo, startTransition } from 'react';
import { useNavigate } from 'react-router-dom';
import { boardsApi, authApi } from '../services/api';
import type { Board, User } from '../types/kanban';

const LAST_BOARD_KEY = 'lastSelectedBoardId';

interface UseBoardOptions {
  boardIdFromUrl?: string;
}

interface UseBoardReturn {
  boards: Board[];
  currentBoard: Board | null;
  currentUser: User | null;
  loading: boolean;
  boardSwitching: boolean;
  loadError: string | null;
  fetchBoards: () => Promise<void>;
  setCurrentBoard: (board: Board | null) => void;
}

export function useBoard({ boardIdFromUrl }: UseBoardOptions = {}): UseBoardReturn {
  const navigate = useNavigate();

  const [boards, setBoards] = useState<Board[]>([]);
  const [currentBoard, setCurrentBoard] = useState<Board | null>(null);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [loading, _setLoading] = useState(true);
  const [loadError, _setLoadError] = useState<string | null>(null);

  const boardSwitching = useMemo(() => {
    if (!currentBoard || !boardIdFromUrl) return false;
    return boardIdFromUrl !== currentBoard.id;
  }, [currentBoard, boardIdFromUrl]);

  const currentBoardRef = useRef<Board | null>(null);

  useEffect(() => {
    currentBoardRef.current = currentBoard;
  }, [currentBoard]);

  const fetchBoards = useCallback(async () => {
    try {
      const data = await boardsApi.getAll();
      setBoards(data || []);
    } catch (error) {
      console.error('Failed to fetch boards:', error);
    }
  }, []);

  useEffect(() => {
    authApi.me().then((data) => {
      if (data.user) {
        setCurrentUser(data.user);
      }
    }).catch(console.error);
  }, []);

  useEffect(() => {
    if (!boardIdFromUrl && boards.length > 0) {
      const lastBoardId = localStorage.getItem(LAST_BOARD_KEY);
      const lastBoard = lastBoardId ? boards.find((b: Board) => b.id === lastBoardId) : null;
      const targetBoard = lastBoard || boards[0];
      navigate(`/board/${targetBoard.id}`);
    }
  }, [boardIdFromUrl, boards, navigate]);

  useEffect(() => {
    if (!boardIdFromUrl || boards.length === 0) return;

    const board = boards.find((b) => b.id === boardIdFromUrl);
    if (board) {
      if (currentBoard?.id !== board.id) {
        startTransition(() => {
          setCurrentBoard(board);
        });
      }
    } else {
      console.warn(`Board ${boardIdFromUrl} not found, redirecting to ${boards[0].id}`);
      navigate(`/board/${boards[0].id}`);
    }
  }, [boardIdFromUrl, boards, navigate, currentBoard?.id]);

  return {
    boards,
    currentBoard,
    currentUser,
    loading,
    boardSwitching,
    loadError,
    fetchBoards,
    setCurrentBoard,
  };
}