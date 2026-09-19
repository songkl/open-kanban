import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Board, BoardPermission, PermissionAccess } from '@/types/kanban';
import { authApi } from '@/services/api';
import { AddBoardPermissionForm } from '@/components/AddBoardPermissionForm';
import { BulkBoardPermissionForm } from '@/components/BulkBoardPermissionForm';

export interface PermissionCandidate {
  userId: string;
  nickname: string;
  username?: string;
  userType?: 'HUMAN' | 'AGENT';
  userRole?: string;
}

type AccessFilter = 'ALL' | PermissionAccess;

interface BoardPermissionsModalProps {
  isOpen: boolean;
  board: Board | null;
  permissions: BoardPermission[];
  loading: boolean;
  canManageBoardPermissions?: boolean;
  onClose: () => void;
  onDeletePermission: (permissionId: string) => void;
  onPermissionAdded: () => void;
}

export function BoardPermissionsModal({
  isOpen,
  board,
  permissions,
  loading,
  canManageBoardPermissions = true,
  onClose,
  onDeletePermission,
  onPermissionAdded,
}: BoardPermissionsModalProps) {
  const { t } = useTranslation();
  const [_candidates, setCandidates] = useState<PermissionCandidate[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [accessFilter, setAccessFilter] = useState<AccessFilter>('ALL');
  const boardId = board?.id ?? null;

  useEffect(() => {
    if (!isOpen || !boardId) {
      setCandidates([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const data = await authApi.getBoardPermissions(boardId);
        if (!cancelled) {
          setCandidates((data.candidates as PermissionCandidate[] | undefined) ?? []);
        }
      } catch {
        if (!cancelled) setCandidates([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, boardId, permissions]);

  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-zinc-900 rounded-lg p-6 max-w-3xl w-full">
        <h2 className="text-xl font-semibold mb-4">
          {t('board.permissions.title', { board: board?.name })}
        </h2>
        <input
          className="border rounded px-2 py-1 w-full mb-3"
          placeholder={t('common.search')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        <select
          className="border rounded px-2 py-1 mb-3"
          value={accessFilter}
          onChange={(e) => setAccessFilter(e.target.value as AccessFilter)}
        >
          <option value="ALL">All</option>
          <option value="READ">READ</option>
          <option value="WRITE">WRITE</option>
          <option value="ADMIN">ADMIN</option>
        </select>
        {loading ? (
          <div className="text-zinc-500">{t('common.loading')}</div>
        ) : permissions.length === 0 ? (
          <div className="text-zinc-500">{t('board.permissions.empty')}</div>
        ) : (
          <ul className="divide-y">
            {permissions.map((p) => (
              <li key={p.id} className="py-2 flex items-center justify-between">
                <span>{p.userNickname} — {p.access}</span>
                {canManageBoardPermissions && (
                  <button
                    className="text-red-500 text-sm"
                    onClick={() => onDeletePermission(p.id)}
                  >
                    {t('common.delete')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {canManageBoardPermissions && boardId && (
          <div className="mt-4 flex flex-col gap-3">
            <AddBoardPermissionForm
              boardId={boardId}
              onPermissionAdded={onPermissionAdded}
            />
            <BulkBoardPermissionForm
              boardId={boardId}
              onGranted={onPermissionAdded}
              existingPermissionUserIds={permissions.map((p) => p.userId)}
            />
          </div>
        )}
        <div className="mt-4 flex justify-end">
          <button className="px-4 py-2 rounded bg-zinc-200 dark:bg-zinc-700" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
