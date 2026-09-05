import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { Board } from '../types/kanban';
import { authApi } from '@/services/api';
import { BoardPermissionsModal } from './BoardPermissionsModal';

interface BoardPermission {
  id: string;
  boardId: string;
  boardName: string;
  access: string;
  userId: string;
  userNickname: string;
}

interface BoardHeaderProps {
  boards: Board[];
  currentBoard: Board | null;
  boardIdFromUrl: string;
  currentUser?: { id: string; role: string } | null;
}

export function BoardHeader({ boards, currentBoard, boardIdFromUrl, currentUser }: BoardHeaderProps) {
  const { t } = useTranslation();
  const [showPermissionModal, setShowPermissionModal] = useState(false);
  const [permissions, setPermissions] = useState<BoardPermission[]>([]);
  const [permissionLoading, setPermissionLoading] = useState(false);

  const isAdmin = currentUser?.role === 'ADMIN';
  const activeBoard = currentBoard || boards.find((b) => b.id === boardIdFromUrl) || null;

  const handleOpenPermissionModal = async () => {
    if (!activeBoard) return;
    setShowPermissionModal(true);
    setPermissionLoading(true);
    try {
      const data = await authApi.getBoardPermissions(activeBoard.id);
      setPermissions(data.permissions || []);
    } catch (err) {
      console.error('Failed to fetch board permissions:', err);
    } finally {
      setPermissionLoading(false);
    }
  };

  const handleDeletePermission = async (permissionId: string) => {
    try {
      await authApi.deletePermission(permissionId);
      if (activeBoard) {
        const data = await authApi.getBoardPermissions(activeBoard.id);
        setPermissions(data.permissions || []);
      }
    } catch (err) {
      console.error('Failed to delete board permission:', err);
    }
  };

  return (
    <div className="flex items-center gap-3">
      <div className="relative">
        <button className="flex items-center gap-1 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-1 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-600 max-w-36">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="3" width="7" height="7" />
            <rect x="14" y="3" width="7" height="7" />
            <rect x="14" y="14" width="7" height="7" />
            <rect x="3" y="14" width="7" height="7" />
          </svg>
          <span className="truncate max-w-24">
            {currentBoard?.name || boards.find((b) => b.id === boardIdFromUrl)?.name || t('board.selectBoard')}
          </span>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      </div>
      {isAdmin && activeBoard && (
        <button
          onClick={handleOpenPermissionModal}
          className="flex items-center rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 p-1.5 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700"
          title={t('board.permissions')}
          aria-label={t('board.permissions')}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
          </svg>
        </button>
      )}
      <Link
        to={`/columns?boardId=${boardIdFromUrl}`}
        className="flex items-center rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 p-1.5 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700"
        title={t('column.manageColumns')}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" />
        </svg>
      </Link>
      <BoardPermissionsModal
        isOpen={showPermissionModal}
        board={activeBoard}
        permissions={permissions}
        loading={permissionLoading}
        onClose={() => setShowPermissionModal(false)}
        onDeletePermission={handleDeletePermission}
        onPermissionAdded={handleOpenPermissionModal}
      />
    </div>
  );
}