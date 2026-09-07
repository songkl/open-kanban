import { useTranslation } from 'react-i18next';
import type { Column, ColumnPermission } from '@/types/kanban';
import { AddColumnPermissionForm } from '@/components/AddColumnPermissionForm';

interface ColumnPermissionsModalProps {
  isOpen: boolean;
  column: Column | null;
  permissions: ColumnPermission[];
  loading: boolean;
  onClose: () => void;
  onDeletePermission: (permissionId: string) => void;
  onPermissionAdded: () => void;
}

// Unified row shape (s-1054) carries `nickname` / `username` while
// the legacy ColumnPermission keyed off `userNickname`. Read both
// so the modal keeps working regardless of which shape the caller
// passed in.
function columnPermissionDisplayName(perm: ColumnPermission): string {
  const row = perm as ColumnPermission & { nickname?: string };
  return perm.userNickname || row.nickname || '';
}

function columnPermissionGrantor(perm: ColumnPermission): string {
  return perm.grantedByUsername || perm.grantedByNickname || '';
}

function columnPermissionGrantedAt(perm: ColumnPermission): string {
  if (!perm.grantedAt) return '';
  const date = new Date(perm.grantedAt);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString();
}

function columnPermissionExpiresAt(perm: ColumnPermission): string {
  if (!perm.expiresAt) return '';
  const date = new Date(perm.expiresAt);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString();
}

export function ColumnPermissionsModal({
  isOpen,
  column,
  permissions,
  loading,
  onClose,
  onDeletePermission,
  onPermissionAdded,
}: ColumnPermissionsModalProps) {
  const { t } = useTranslation();

  if (!isOpen || !column) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl bg-white dark:bg-zinc-700 p-6 shadow dark:bg-zinc-800 border border-zinc-100 dark:border-zinc-700 max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 text-white">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
          </div>
          <div>
            <h2 className="text-xl font-bold text-zinc-800 dark:text-zinc-100">{t('column.columnPermissions')}</h2>
            <p className="text-sm text-zinc-500 dark:text-zinc-500">{column.name}</p>
          </div>
        </div>

        {loading ? (
          <div className="py-8 text-center text-zinc-500 dark:text-zinc-500">{t('common.loading')}</div>
        ) : (
          <>
            <div className="mb-4">
              <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-400 mb-3">{t('column.currentPermissions')}</h3>
              {permissions.length === 0 ? (
                <p className="text-sm text-zinc-400 dark:text-zinc-500 py-4 text-center">{t('column.noPermissions')}</p>
              ) : (
                <div className="space-y-2" data-testid="column-permissions-list">
                  {permissions.map((perm) => {
                    const displayName = columnPermissionDisplayName(perm);
                    const grantor = columnPermissionGrantor(perm);
                    const grantedAtText = columnPermissionGrantedAt(perm);
                    const expiresAtText = columnPermissionExpiresAt(perm);
                    const showAuditLine = grantor || grantedAtText || expiresAtText;
                    return (
                    <div key={perm.id} data-testid="column-permission-row" className="flex items-center justify-between p-3 bg-zinc-50 dark:bg-zinc-700 rounded-xl border border-zinc-100">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-violet-100 text-violet-600 text-xs font-bold">
                          {(displayName || '?').charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-zinc-800 dark:text-zinc-100">{displayName}</div>
                          <div className="text-xs text-zinc-400 dark:text-zinc-500">{t('column.permission.' + perm.access)}</div>
                          {showAuditLine && (
                            <div
                              className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-zinc-500 dark:text-zinc-400"
                              data-testid="column-permission-audit"
                            >
                              {grantor && (
                                <span>
                                  <span className="text-zinc-400 dark:text-zinc-500">{t('board.grantedBy')}</span>
                                  <span className="ml-1 font-medium text-zinc-700 dark:text-zinc-200">{grantor}</span>
                                </span>
                              )}
                              {grantedAtText && (
                                <span>
                                  <span className="text-zinc-400 dark:text-zinc-500">{t('board.grantedAt')}</span>
                                  <span className="ml-1 text-zinc-600 dark:text-zinc-300">{grantedAtText}</span>
                                </span>
                              )}
                              {expiresAtText && (
                                <span>
                                  <span className="text-zinc-400 dark:text-zinc-500">{t('board.expiresAt')}</span>
                                  <span className="ml-1">{expiresAtText}</span>
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                      <button
                        onClick={() => onDeletePermission(perm.id)}
                        className="rounded-lg px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                      >
                        {t('column.remove')}
                      </button>
                    </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="border-t border-zinc-100 dark:border-zinc-700 pt-4">
              <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-400 mb-3">{t('column.addPermission')}</h3>
              <AddColumnPermissionForm
                columnId={column.id}
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
    </div>
  );
}
