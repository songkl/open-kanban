import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { authApi } from '../../services/api';
import { showErrorToast } from '../ErrorToast';
import { UserAvatar } from '../UserAvatar';
import { ConfirmDialog } from '../ConfirmDialog';
import type { User } from '../../types/kanban';

interface UsersSettingsProps {
  currentUser: User | null;
  onLoadUsers: () => Promise<User[]>;
}

interface ConfirmDialogState {
  isOpen: boolean;
  title: string;
  message: string;
  onConfirm: () => void;
  variant?: 'danger' | 'warning' | 'default';
}

export function UsersSettings({ currentUser, onLoadUsers }: UsersSettingsProps) {
  const { t } = useTranslation();
  const [users, setUsers] = useState<User[]>([]);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState>({ isOpen: false, title: '', message: '', onConfirm: () => {} });
  const [loading, setLoading] = useState(false);
  const [showAddUser, setShowAddUser] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newNickname, setNewNickname] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<'ADMIN' | 'MEMBER' | 'VIEWER'>('MEMBER');
  const [creating, setCreating] = useState(false);
  const [registrationConfig, setRegistrationConfig] = useState<{ allowRegistration: boolean; requirePassword: boolean; authEnabled: boolean } | null>(null);

  const loadUsers = async () => {
    setLoading(true);
    try {
      const data = await onLoadUsers();
      setUsers(data);
    } catch (err) {
      console.error('Failed to load users:', err);
    } finally {
      setLoading(false);
    }
  };

  const loadConfig = async () => {
    try {
      const config = await authApi.getConfig();
      setRegistrationConfig(config);
    } catch (err) {
      console.error('Failed to load config:', err);
    }
  };

  useState(() => {
    loadUsers();
    loadConfig();
  });

  const handleCreateUser = async () => {
    if (!newUsername.trim()) {
      showErrorToast(t('settings.usernameRequired'));
      return;
    }
    setCreating(true);
    try {
      await authApi.createUser({
        username: newUsername.trim(),
        nickname: newNickname.trim() || undefined,
        password: newPassword || undefined,
        role: newRole,
      });
      showErrorToast(t('settings.userCreated'), 'info');
      setShowAddUser(false);
      setNewUsername('');
      setNewNickname('');
      setNewPassword('');
      setNewRole('MEMBER');
      await loadUsers();
    } catch (err) {
      console.error('Failed to create user:', err);
      showErrorToast(t('settings.createUserFailed'));
    } finally {
      setCreating(false);
    }
  };

  const handleUpdateConfig = async (key: 'allowRegistration' | 'requirePassword' | 'authEnabled', value: boolean) => {
    try {
      await authApi.updateConfig({ [key]: value });
      await loadConfig();
      showErrorToast(t('settings.configUpdated'), 'info');
    } catch (err) {
      console.error('Failed to update config:', err);
      showErrorToast(t('settings.updateConfigFailed'));
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 text-white shadow-lg shadow-violet-500/30">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
            </svg>
          </div>
          <div>
            <h2 className="text-xl font-bold text-zinc-800">{t('settings.userManagement')}</h2>
            <p className="text-sm text-zinc-500">{t('settings.usersDescription')}</p>
          </div>
        </div>
        <div className="py-8 text-center text-zinc-500">{t('common.loading')}</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 text-white shadow-lg shadow-violet-500/30">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
          </svg>
        </div>
        <div>
          <h2 className="text-xl font-bold text-zinc-800">{t('settings.userManagement')}</h2>
          <p className="text-sm text-zinc-500">{t('settings.usersDescription')}</p>
        </div>
      </div>

      <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-zinc-700 mb-4 flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-violet-600">
            <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
          {t('settings.registrationSettings')}
        </h3>
        <div className="space-y-3">
          <label className="flex items-center justify-between p-3 rounded-xl bg-zinc-50 border border-zinc-100 cursor-pointer hover:bg-zinc-100 transition-colors">
            <div>
              <div className="font-medium text-zinc-800 text-sm">{t('settings.allowRegistration')}</div>
              <div className="text-xs text-zinc-500 mt-0.5">{t('settings.allowRegistrationDesc')}</div>
            </div>
            <input
              type="checkbox"
              checked={registrationConfig?.allowRegistration ?? true}
              onChange={(e) => handleUpdateConfig('allowRegistration', e.target.checked)}
              className="h-5 w-5 rounded border-zinc-300 text-blue-600 focus:ring-blue-500"
            />
          </label>
          <label className="flex items-center justify-between p-3 rounded-xl bg-zinc-50 border border-zinc-100 cursor-pointer hover:bg-zinc-100 transition-colors">
            <div>
              <div className="font-medium text-zinc-800 text-sm">{t('settings.requirePassword')}</div>
              <div className="text-xs text-zinc-500 mt-0.5">{t('settings.requirePasswordDesc')}</div>
            </div>
            <input
              type="checkbox"
              checked={registrationConfig?.requirePassword ?? false}
              onChange={(e) => handleUpdateConfig('requirePassword', e.target.checked)}
              className="h-5 w-5 rounded border-zinc-300 text-blue-600 focus:ring-blue-500"
            />
          </label>
        </div>
      </div>

      <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-zinc-700 flex items-center gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-600">
              <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/>
            </svg>
            {t('settings.addUser')}
          </h3>
          {!showAddUser && (
            <button
              onClick={() => setShowAddUser(true)}
              className="rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600 transition-colors"
            >
              + {t('settings.addUser')}
            </button>
          )}
        </div>

        {showAddUser && (
          <div className="space-y-3 p-4 rounded-xl bg-zinc-50 border border-zinc-200">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-zinc-600 mb-1">{t('settings.username')} *</label>
                <input
                  type="text"
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value)}
                  placeholder={t('settings.usernamePlaceholder')}
                  className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-600 mb-1">{t('settings.nickname')}</label>
                <input
                  type="text"
                  value={newNickname}
                  onChange={(e) => setNewNickname(e.target.value)}
                  placeholder={t('settings.nicknamePlaceholder')}
                  className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-zinc-600 mb-1">{t('settings.password')}</label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder={t('settings.passwordPlaceholder')}
                  className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-600 mb-1">{t('settings.role')}</label>
                <select
                  value={newRole}
                  onChange={(e) => setNewRole(e.target.value as 'ADMIN' | 'MEMBER' | 'VIEWER')}
                  className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                >
                  <option value="MEMBER">{t('settings.member')}</option>
                  <option value="ADMIN">{t('settings.admin')}</option>
                  <option value="VIEWER">{t('settings.viewer')}</option>
                </select>
              </div>
            </div>
            <div className="flex gap-2 pt-2">
              <button
                onClick={handleCreateUser}
                disabled={creating}
                className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-50 transition-colors"
              >
                {creating ? t('common.loading') : t('settings.createUser')}
              </button>
              <button
                onClick={() => {
                  setShowAddUser(false);
                  setNewUsername('');
                  setNewNickname('');
                  setNewPassword('');
                  setNewRole('MEMBER');
                }}
                className="rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-200 transition-colors"
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="space-y-3">
        {users.map((user) => (
          <div key={user.id} className="flex items-center justify-between rounded-xl border border-zinc-200 bg-white p-4 shadow-sm hover:shadow-md transition-shadow">
            <div className="flex items-center gap-3">
              <UserAvatar
                username={user.nickname}
                avatar={user.avatar}
                size="md"
              />
              <div>
                <Link to={`/user/${user.id}`} className="font-medium text-zinc-800 hover:text-blue-600 dark:hover:text-blue-400">
                  {user.nickname}
                </Link>
                <div className="flex gap-2 mt-1">
                  <select
                    value={user.role}
                    onChange={async (e) => {
                      const newRole = e.target.value as 'ADMIN' | 'MEMBER' | 'VIEWER';
                      if (newRole === user.role) return;
                      setConfirmDialog({
                        isOpen: true,
                        title: t('settings.confirmRoleChangeTitle') || t('modal.confirmTitle'),
                        message: t('settings.confirmRoleChange', { name: user.nickname, role: newRole === 'ADMIN' ? t('settings.admin') : newRole === 'MEMBER' ? t('settings.member') : t('settings.viewer') }),
                        variant: 'warning',
                        onConfirm: async () => {
                          try {
                            await authApi.updateUser(user.id, { role: newRole });
                            await loadUsers();
                          } catch (err) {
                            console.error('Failed to update user role:', err);
                          }
                          setConfirmDialog(prev => ({ ...prev, isOpen: false }));
                        },
                      });
                    }}
                    disabled={user.id === currentUser?.id}
                    className={`rounded-lg px-2 py-1 text-xs border font-medium ${user.role === 'ADMIN' ? 'bg-blue-100 text-blue-700 border-blue-200' : user.role === 'MEMBER' ? 'bg-emerald-100 text-emerald-700 border-emerald-200' : 'bg-zinc-100 text-zinc-600 border-zinc-200'} ${user.id === currentUser?.id ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                  >
                    <option value="ADMIN">{t('settings.admin')}</option>
                    <option value="MEMBER">{t('settings.member')}</option>
                    <option value="VIEWER">{t('settings.viewer')}</option>
                  </select>
                  <span className={`inline-flex items-center rounded-lg px-2 py-1 text-xs font-medium ${user.type === 'AGENT' ? 'bg-violet-100 text-violet-700' : 'bg-zinc-100 text-zinc-500'}`}>
                    {user.type === 'AGENT' ? t('settings.agent') : t('settings.human')}
                  </span>
                </div>
              </div>
            </div>
            <div className="flex gap-2 items-center">
              <button
                onClick={() => {
                  if (user.id === currentUser?.id) {
                    showErrorToast(t('settings.cannotDisableSelf'), 'warning');
                    return;
                  }
                  setConfirmDialog({
                    isOpen: true,
                    title: t('settings.toggleEnabledTitle') || t('modal.confirmTitle'),
                    message: t('settings.toggleEnabledConfirm', { name: user.nickname, action: user.enabled ? t('settings.disable') : t('settings.enable') }),
                    variant: 'warning',
                    onConfirm: async () => {
                      try {
                        await authApi.setUserEnabled(user.id, !user.enabled);
                        await loadUsers();
                      } catch (err) {
                        console.error('Failed to toggle user enabled:', err);
                      }
                      setConfirmDialog(prev => ({ ...prev, isOpen: false }));
                    },
                  });
                }}
                disabled={user.id === currentUser?.id}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${user.enabled ? 'bg-orange-100 text-orange-700 hover:bg-orange-200' : 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200'} ${user.id === currentUser?.id ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                {user.enabled ? t('settings.disable') : t('settings.enable')}
              </button>
              <div className="text-xs text-zinc-400">
                {t('settings.createdAt', { date: new Date(user.createdAt).toLocaleDateString() })}
              </div>
            </div>
          </div>
        ))}
        {users.length === 0 && (
          <div className="py-12 text-center rounded-xl bg-white border border-zinc-100 shadow-sm">
            <p className="text-zinc-500">{t('settings.noUsers')}</p>
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-zinc-700 mb-4 flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-violet-600">
            <circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>
          </svg>
          {t('settings.rolePermissions')}
        </h3>
        <p className="text-xs text-zinc-500 mb-4">{t('settings.rolePermissionsDescription')}</p>
        <div className="space-y-3">
          <div className="flex items-start gap-3 p-3 rounded-xl bg-blue-50 border border-blue-100">
            <div className="flex h-6 w-6 items-center justify-center rounded-lg bg-blue-200 text-blue-700 text-xs font-bold">A</div>
            <div className="flex-1">
              <div className="font-medium text-blue-800 text-sm">{t('settings.admin')}</div>
              <div className="text-xs text-blue-600 mt-0.5">{t('settings.adminRoleDesc')}</div>
            </div>
          </div>
          <div className="flex items-start gap-3 p-3 rounded-xl bg-emerald-50 border border-emerald-100">
            <div className="flex h-6 w-6 items-center justify-center rounded-lg bg-emerald-200 text-emerald-700 text-xs font-bold">M</div>
            <div className="flex-1">
              <div className="font-medium text-emerald-800 text-sm">{t('settings.member')}</div>
              <div className="text-xs text-emerald-600 mt-0.5">{t('settings.memberRoleDesc')}</div>
            </div>
          </div>
          <div className="flex items-start gap-3 p-3 rounded-xl bg-zinc-50 border border-zinc-100">
            <div className="flex h-6 w-6 items-center justify-center rounded-lg bg-zinc-200 text-zinc-600 text-xs font-bold">V</div>
            <div className="flex-1">
              <div className="font-medium text-zinc-700 text-sm">{t('settings.viewer')}</div>
              <div className="text-xs text-zinc-500 mt-0.5">{t('settings.viewerRoleDesc')}</div>
            </div>
          </div>
        </div>
      </div>

      <ConfirmDialog
        isOpen={confirmDialog.isOpen}
        title={confirmDialog.title}
        message={confirmDialog.message}
        variant={confirmDialog.variant}
        onConfirm={confirmDialog.onConfirm}
        onCancel={() => setConfirmDialog(prev => ({ ...prev, isOpen: false }))}
      />
    </div>
  );
}
