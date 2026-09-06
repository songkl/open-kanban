import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Board, BoardPermission, PermissionAccess, User } from '@/types/kanban';
import { AddBoardPermissionForm } from '@/components/AddBoardPermissionForm';
import { authApi, type PermissionCandidate } from '@/services/api';

type AccessFilter = 'ALL' | PermissionAccess;

// The permission row emitted by GET /api/v1/auth/permissions carries
// both `nickname`/`username` (unified row, s-1041) while the legacy
// BoardPermission type keys off `userNickname`. Read both so the
// search box keeps working regardless of which shape the caller
// passed in.
function permissionDisplayName(perm: BoardPermission): string {
  const row = perm as BoardPermission & { nickname?: string };
  return perm.userNickname || row.nickname || '';
}

function permissionUsername(perm: BoardPermission): string {
  return (perm as BoardPermission & { username?: string }).username || '';
}

function matchesQuery(query: string, ...fields: (string | undefined)[]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((field) => (field || '').toLowerCase().includes(q));
}

interface BoardPermissionsModalProps {
  isOpen: boolean;
  board: Board | null;
  permissions: BoardPermission[];
  loading: boolean;
  currentUser?: { id: string; role: string } | null;
  canManageBoardPermissions?: boolean;
  onClose: () => void;
  onDeletePermission: (permissionId: string) => void;
  onPermissionAdded: () => void;
  onOwnershipTransferred?: () => void;
}

export function BoardPermissionsModal({
  isOpen,
  board,
  permissions,
  loading,
  currentUser,
  canManageBoardPermissions,
  onClose,
  onDeletePermission,
  onPermissionAdded,
  onOwnershipTransferred,
}: BoardPermissionsModalProps) {
  const { t } = useTranslation();

  const [transferOpen, setTransferOpen] = useState(false);
  const [transferUsers, setTransferUsers] = useState<User[]>([]);
  const [transferUsersLoading, setTransferUsersLoading] = useState(false);
  const [selectedNewOwnerId, setSelectedNewOwnerId] = useState('');
  const [transferring, setTransferring] = useState(false);
  const [transferError, setTransferError] = useState<string | null>(null);

  const [candidates, setCandidates] = useState<PermissionCandidate[]>([]);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [accessFilter, setAccessFilter] = useState<AccessFilter>('ALL');

  const boardId = board?.id ?? null;
  // Re-fetch candidates whenever the granted set changes (an add or a
  // delete moves a user between the two lists).
  const permissionsKey = permissions.map((p) => p.id).join(',');

  useEffect(() => {
    if (!isOpen || !boardId) {
      return;
    }
    let cancelled = false;
    setCandidatesLoading(true);
    Promise.resolve(authApi.getBoardPermissions(boardId))
      .then((data) => {
        if (cancelled) return;
        setCandidates(data?.candidates || []);
        setCandidatesLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('Failed to load board permission candidates:', err);
        setCandidates([]);
        setCandidatesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, boardId, permissionsKey]);

  useEffect(() => {
    if (!transferOpen || !board) {
      return;
    }
    let cancelled = false;
    setTransferUsersLoading(true);
    authApi
      .getUsers()
      .then((data) => {
        if (cancelled) return;
        setTransferUsers(data || []);
        setTransferUsersLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setTransferUsersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [transferOpen, board]);

  useEffect(() => {
    if (!isOpen) {
      setTransferOpen(false);
      setSelectedNewOwnerId('');
      setTransferError(null);
      setTransferring(false);
      setSearchQuery('');
      setAccessFilter('ALL');
      setCandidates([]);
    }
  }, [isOpen]);

  // The access filter only narrows granted rows: candidates have no
  // access level yet, so they stay visible under the search filter and
  // are hidden entirely when a specific level is selected.
  const filteredPermissions = useMemo(
    () =>
      permissions.filter((perm) => {
        if (accessFilter !== 'ALL' && perm.access !== accessFilter) return false;
        return matchesQuery(searchQuery, permissionDisplayName(perm), permissionUsername(perm));
      }),
    [permissions, accessFilter, searchQuery]
  );

  const filteredCandidates = useMemo(
    () =>
      accessFilter === 'ALL'
        ? candidates.filter((c) => matchesQuery(searchQuery, c.nickname, c.username))
        : [],
    [candidates, accessFilter, searchQuery]
  );

  if (!isOpen || !board) return null;

  const currentOwner =
    permissions.find((p) => p.ownerAgentId && p.ownerAgentId === p.userId) || null;
  const canTransfer =
    !!canManageBoardPermissions &&
    (currentUser?.role === 'ADMIN' ||
      (currentOwner !== null && currentOwner.userId === currentUser?.id));

  const eligibleUsers = transferUsers.filter(
    (u) => permissions.some((p) => p.userId === u.id) && u.id !== currentUser?.id
  );

  const handleTransfer = async () => {
    if (!selectedNewOwnerId || !board) {
      return;
    }
    setTransferring(true);
    setTransferError(null);
    try {
      await authApi.transferOwnership(board.id, selectedNewOwnerId);
      setTransferOpen(false);
      setSelectedNewOwnerId('');
      onOwnershipTransferred?.();
      onPermissionAdded();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : t('board.transferOwnershipFailed');
      setTransferError(message);
    } finally {
      setTransferring(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl bg-white dark:bg-zinc-800 p-6 shadow border border-zinc-100 dark:border-zinc-700 max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 text-white">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
          </div>
          <div>
            <h2 className="text-xl font-bold text-zinc-800 dark:text-zinc-100">{t('board.permissions')}</h2>
            <p className="text-sm text-zinc-500 dark:text-zinc-500">{board.name}</p>
          </div>
        </div>

        {loading ? (
          <div className="py-8 text-center text-zinc-500 dark:text-zinc-500">{t('common.loading')}</div>
        ) : (
          <>
            {currentOwner && (
              <div className="mb-4 flex items-center gap-3 rounded-xl border border-amber-200 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 px-3 py-2">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-amber-600 dark:text-amber-400">
                  <path d="M12 2l3 7h7l-5.5 4 2 7L12 16l-6.5 4 2-7L2 9h7z"/>
                </svg>
                <div className="flex-1 text-sm text-amber-800 dark:text-amber-300">
                  <span className="font-medium">{t('board.currentOwner')}: </span>
                  {permissionDisplayName(currentOwner)}
                </div>
                {canTransfer && (
                  <button
                    onClick={() => setTransferOpen(true)}
                    className="rounded-lg border border-amber-300 dark:border-amber-700 bg-white dark:bg-zinc-800 px-3 py-1 text-xs font-medium text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/40 transition-colors"
                  >
                    {t('board.transferOwnership')}
                  </button>
                )}
              </div>
            )}

            <div className="mb-4 flex flex-col gap-2 sm:flex-row">
              <input
                type="search"
                data-testid="board-permission-search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('board.searchUsersPlaceholder')}
                aria-label={t('board.searchUsers')}
                className="flex-1 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-700 px-3 py-2 text-sm text-zinc-800 dark:text-zinc-100 transition-all focus:border-blue-500 focus:bg-white dark:focus:bg-zinc-700 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
              <select
                data-testid="board-permission-access-filter"
                value={accessFilter}
                onChange={(e) => setAccessFilter(e.target.value as AccessFilter)}
                aria-label={t('board.accessFilter')}
                className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-700 px-3 py-2 text-sm text-zinc-800 dark:text-zinc-100 transition-all focus:border-blue-500 focus:bg-white dark:focus:bg-zinc-700 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              >
                <option value="ALL">{t('board.accessFilterAll')}</option>
                <option value="READ">{t('column.permission.READ')}</option>
                <option value="WRITE">{t('column.permission.WRITE')}</option>
                <option value="ADMIN">{t('column.permission.ADMIN')}</option>
              </select>
            </div>

            <div className="mb-4">
              <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-400 mb-3">{t('board.currentPermissions')}</h3>
              {permissions.length === 0 ? (
                <p className="text-sm text-zinc-400 dark:text-zinc-500 py-4 text-center">{t('board.noPermissions')}</p>
              ) : filteredPermissions.length === 0 ? (
                <p className="text-sm text-zinc-400 dark:text-zinc-500 py-4 text-center">{t('board.noMatchingPermissions')}</p>
              ) : (
                <div className="space-y-2" data-testid="board-permissions-list">
                  {filteredPermissions.map((perm) => (
                    <div key={perm.id} data-testid="board-permission-row" className="flex items-center justify-between p-3 bg-zinc-50 dark:bg-zinc-700 rounded-xl border border-zinc-100 dark:border-zinc-700">
                      <div className="flex items-center gap-3">
                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-violet-100 text-violet-600 text-xs font-bold">
                          {permissionDisplayName(perm).charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-zinc-800 dark:text-zinc-100">{permissionDisplayName(perm)}</span>
                            {perm.ownerAgentId && perm.ownerAgentId === perm.userId && (
                              <span className="rounded-full bg-amber-100 dark:bg-amber-900/40 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-300">
                                {t('board.ownerBadge')}
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-zinc-400 dark:text-zinc-500">{t('column.permission.' + perm.access)}</div>
                        </div>
                      </div>
                      <button
                        onClick={() => onDeletePermission(perm.id)}
                        className="rounded-lg px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                      >
                        {t('column.remove')}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="mb-4 border-t border-zinc-100 dark:border-zinc-700 pt-4">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-400">
                  {t('board.invitableUsers')}
                </h3>
                <span className="text-xs text-zinc-400 dark:text-zinc-500">
                  {filteredCandidates.length}
                </span>
              </div>
              {candidatesLoading ? (
                <p className="text-sm text-zinc-400 dark:text-zinc-500 py-4 text-center">{t('common.loading')}</p>
              ) : filteredCandidates.length === 0 ? (
                <p className="text-sm text-zinc-400 dark:text-zinc-500 py-4 text-center">{t('board.noInvitableUsers')}</p>
              ) : (
                <div className="max-h-40 space-y-2 overflow-y-auto" data-testid="board-permission-candidates">
                  {filteredCandidates.map((candidate) => (
                    <div
                      key={candidate.userId}
                      data-testid="board-permission-candidate-row"
                      className="flex items-center gap-3 rounded-xl border border-zinc-100 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2"
                    >
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900/40 text-emerald-600 dark:text-emerald-300 text-xs font-bold">
                        {(candidate.nickname || candidate.username || '?').charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium text-zinc-800 dark:text-zinc-100">
                            {candidate.nickname}
                          </span>
                          {candidate.type === 'AGENT' && (
                            <span className="rounded-full bg-zinc-100 dark:bg-zinc-700 px-2 py-0.5 text-[10px] text-zinc-500 dark:text-zinc-400">
                              {t('settings.agent')}
                            </span>
                          )}
                        </div>
                        {candidate.username && (
                          <div className="truncate text-xs text-zinc-400 dark:text-zinc-500">
                            @{candidate.username}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="border-t border-zinc-100 dark:border-zinc-700 pt-4">
              <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-400 mb-3">{t('board.addPermission')}</h3>
              <AddBoardPermissionForm
                boardId={board.id}
                onPermissionAdded={onPermissionAdded}
              />
            </div>
          </>
        )}

        <div className="mt-6 flex justify-end">
          <button
            onClick={onClose}
            className="rounded-xl bg-zinc-100 dark:bg-zinc-700 px-4 py-2 text-sm font-medium text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-600 transition-colors"
          >
            {t('common.close')}
          </button>
        </div>
      </div>

      {transferOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={() => {
            if (!transferring) {
              setTransferOpen(false);
              setTransferError(null);
              setSelectedNewOwnerId('');
            }
          }}
        >
          <div
            className="relative z-10 w-full max-w-sm rounded-2xl bg-white dark:bg-zinc-800 p-6 shadow border border-zinc-100 dark:border-zinc-700"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-amber-500 to-orange-500 text-white shadow-lg">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><polyline points="17 11 19 13 23 9"/>
                </svg>
              </div>
              <h3 className="text-lg font-bold text-zinc-800 dark:text-zinc-100">
                {t('board.transferOwnershipTitle')}
              </h3>
            </div>

            <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-300">
              {t('board.transferOwnershipMessage')}
            </p>

            <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1">
              {t('board.transferOwnershipSelect')}
            </label>
            <select
              value={selectedNewOwnerId}
              onChange={(e) => setSelectedNewOwnerId(e.target.value)}
              disabled={transferring || transferUsersLoading}
              className="mb-4 w-full rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-700 px-3 py-2 text-sm text-zinc-800 dark:text-zinc-100 focus:border-blue-500 focus:bg-white dark:focus:bg-zinc-700 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            >
              <option value="">{t('board.transferOwnershipPickUser')}</option>
              {eligibleUsers.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.nickname} {u.type === 'AGENT' ? `(${t('settings.agent')})` : ''}
                </option>
              ))}
            </select>

            {eligibleUsers.length === 0 && !transferUsersLoading && (
              <p className="mb-4 rounded-lg bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                {t('board.transferOwnershipNoCandidates')}
              </p>
            )}

            {transferError && (
              <p className="mb-4 rounded-lg bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-600 dark:text-red-300">
                {transferError}
              </p>
            )}

            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => {
                  setTransferOpen(false);
                  setTransferError(null);
                  setSelectedNewOwnerId('');
                }}
                disabled={transferring}
                className="flex-1 rounded-xl bg-zinc-100 dark:bg-zinc-700 px-4 py-3 font-medium text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-600 transition-colors disabled:opacity-50"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={handleTransfer}
                disabled={transferring || !selectedNewOwnerId || eligibleUsers.length === 0}
                className="flex-1 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 px-4 py-3 font-medium text-white transition-all shadow-sm hover:shadow hover:from-amber-600 hover:to-orange-600 disabled:from-zinc-300 disabled:to-zinc-300 disabled:shadow-none"
              >
                {transferring ? t('common.loading') : t('board.transferOwnershipConfirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
