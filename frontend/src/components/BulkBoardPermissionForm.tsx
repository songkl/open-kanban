import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authApi } from '@/services/api';
import { showErrorToast } from '@/components/ErrorToast';
import type { PermissionAccess, User } from '@/types/kanban';

type RoleFilter = 'ALL' | 'ADMIN' | 'MEMBER' | 'VIEWER';
type TypeFilter = 'ALL' | 'HUMAN' | 'AGENT';

interface BulkBoardPermissionFormProps {
  boardId: string;
  onGranted: () => void;
  existingPermissionUserIds: string[];
}

export function BulkBoardPermissionForm({
  boardId,
  onGranted,
  existingPermissionUserIds,
}: BulkBoardPermissionFormProps) {
  const { t } = useTranslation();
  const [users, setUsers] = useState<User[]>([]);
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('ALL');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('ALL');
  const [access, setAccess] = useState<PermissionAccess>('READ');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    let cancelled = false;
    authApi
      .getUsers()
      .then((data) => {
        if (cancelled) return;
        setUsers(data || []);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('Failed to load users:', err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const existingSet = useMemo(
    () => new Set(existingPermissionUserIds),
    [existingPermissionUserIds]
  );

  const filteredUsers = useMemo(
    () =>
      users.filter((u) => {
        if (roleFilter !== 'ALL' && u.role !== roleFilter) return false;
        if (typeFilter !== 'ALL' && u.type !== typeFilter) return false;
        return true;
      }),
    [users, roleFilter, typeFilter]
  );

  const visibleSelectedCount = useMemo(
    () => filteredUsers.filter((u) => selectedUserIds.includes(u.id)).length,
    [filteredUsers, selectedUserIds]
  );

  const toggleUser = (id: string) => {
    setSelectedUserIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const selectAllVisible = () => {
    setSelectedUserIds((prev) => {
      const next = new Set(prev);
      filteredUsers.forEach((u) => next.add(u.id));
      return Array.from(next);
    });
  };

  const deselectAllVisible = () => {
    setSelectedUserIds((prev) => prev.filter((id) => !filteredUsers.some((u) => u.id === id)));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedUserIds.length === 0 || loading || !access) return;
    setLoading(true);
    setError(null);
    try {
      const result = await authApi.bulkSetPermissions(boardId, selectedUserIds, access);
      const count = typeof result?.count === 'number' ? result.count : selectedUserIds.length;
      showErrorToast(t('board.bulkAddSuccess', { count }), 'info');
      setSelectedUserIds([]);
      onGranted();
    } catch (err) {
      const status = (err as { status?: number }).status;
      const message = err instanceof Error ? err.message : '';
      const data = (err as { data?: { unknownUserIds?: unknown } }).data;
      const unknownIds: unknown = data?.unknownUserIds;

      if (status === 400 && Array.isArray(unknownIds) && unknownIds.length > 0) {
        const idsText = (unknownIds as unknown[]).map((x) => String(x)).join(', ');
        setError(t('board.bulkAddPartialFailure', { ids: idsText }));
      } else if (status === 400 && /too many/i.test(message)) {
        setError(t('board.bulkAddTooMany'));
      } else if (status === 401 || status === 403 || status === 404) {
        setError(message || t('board.permissionAddFailed'));
      } else {
        setError(message || t('board.permissionAddFailed'));
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50/50 dark:bg-zinc-900/40 p-3">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between text-left"
      >
        <div>
          <h4 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
            {t('board.bulkAddTitle')}
          </h4>
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-500">
            {t('board.bulkAddHint')}
          </p>
        </div>
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
          className={`text-zinc-500 dark:text-zinc-400 transition-transform ${expanded ? 'rotate-180' : ''}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {expanded && (
        <form onSubmit={handleSubmit} className="mt-3 space-y-3">
          {error && (
            <div className="rounded-lg bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-600 dark:text-red-300">
              {error}
            </div>
          )}

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
              <span className="shrink-0 font-medium">{t('board.bulkAddRoleFilter')}</span>
              <select
                value={roleFilter}
                onChange={(e) => setRoleFilter(e.target.value as RoleFilter)}
                disabled={loading}
                className="flex-1 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-700 px-2 py-1 text-xs text-zinc-800 dark:text-zinc-100 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
              >
                <option value="ALL">{t('board.bulkAddAll')}</option>
                <option value="ADMIN">{t('board.role.admin')}</option>
                <option value="MEMBER">{t('board.role.member')}</option>
                <option value="VIEWER">{t('board.role.viewer')}</option>
              </select>
            </label>
            <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
              <span className="shrink-0 font-medium">{t('board.bulkAddTypeFilter')}</span>
              <select
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value as TypeFilter)}
                disabled={loading}
                className="flex-1 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-700 px-2 py-1 text-xs text-zinc-800 dark:text-zinc-100 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
              >
                <option value="ALL">{t('board.bulkAddAll')}</option>
                <option value="HUMAN">{t('settings.human')}</option>
                <option value="AGENT">{t('settings.agent')}</option>
              </select>
            </label>
          </div>

          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-zinc-500 dark:text-zinc-500">
              {t('board.bulkAddSelectUsers')} ({visibleSelectedCount}/{filteredUsers.length})
            </span>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={selectAllVisible}
                disabled={loading || filteredUsers.length === 0}
                className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-700 px-2 py-1 text-[11px] font-medium text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-600 disabled:opacity-50 transition-colors"
              >
                {t('board.bulkAddSelectAll')}
              </button>
              <button
                type="button"
                onClick={deselectAllVisible}
                disabled={loading || visibleSelectedCount === 0}
                className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-700 px-2 py-1 text-[11px] font-medium text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-600 disabled:opacity-50 transition-colors"
              >
                {t('board.bulkAddDeselectAll')}
              </button>
            </div>
          </div>

          <div className="max-h-48 overflow-y-auto rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 divide-y divide-zinc-100 dark:divide-zinc-700">
            {filteredUsers.length === 0 ? (
              <div className="px-3 py-4 text-center text-xs text-zinc-400 dark:text-zinc-500">
                {t('board.bulkAddEmpty')}
              </div>
            ) : (
              filteredUsers.map((user) => {
                const checked = selectedUserIds.includes(user.id);
                const already = existingSet.has(user.id);
                return (
                  <label
                    key={user.id}
                    className="flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-zinc-50 dark:hover:bg-zinc-700/50 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleUser(user.id)}
                      disabled={loading}
                      className="h-3.5 w-3.5 rounded border-zinc-300 dark:border-zinc-600 text-indigo-500 focus:ring-indigo-500 dark:bg-zinc-700"
                    />
                    <span className="flex-1 truncate text-zinc-800 dark:text-zinc-100">
                      {user.nickname}
                      {user.type === 'AGENT' && (
                        <span className="ml-1 text-[10px] text-zinc-400 dark:text-zinc-500">
                          ({t('settings.agent')})
                        </span>
                      )}
                    </span>
                    {already && (
                      <span className="rounded-full bg-zinc-100 dark:bg-zinc-700 px-2 py-0.5 text-[10px] text-zinc-500 dark:text-zinc-400">
                        {t('board.bulkAddAlreadyHasPermission')}
                      </span>
                    )}
                  </label>
                );
              })
            )}
          </div>

          <div className="flex items-center gap-2">
            <label className="flex-1 flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
              <span className="shrink-0 font-medium">{t('board.bulkAddAccess')}</span>
              <select
                value={access}
                onChange={(e) => setAccess(e.target.value as PermissionAccess)}
                disabled={loading}
                className="flex-1 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-700 px-2 py-1 text-xs text-zinc-800 dark:text-zinc-100 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
              >
                <option value="READ">{t('column.permission.READ')}</option>
                <option value="WRITE">{t('column.permission.WRITE')}</option>
                <option value="ADMIN">{t('column.permission.ADMIN')}</option>
              </select>
            </label>
            <button
              type="submit"
              disabled={selectedUserIds.length === 0 || loading || !access}
              className="rounded-xl bg-gradient-to-r from-indigo-500 to-violet-600 px-4 py-1.5 text-xs font-medium text-white shadow-sm hover:from-indigo-600 hover:to-violet-700 hover:shadow disabled:from-zinc-300 disabled:to-zinc-300 disabled:shadow-none disabled:cursor-not-allowed transition-all"
            >
              {loading ? t('common.loading') : t('board.bulkAddSubmit')}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
