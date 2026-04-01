import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { authApi } from '@/services/api';
import type { User } from '@/types/kanban';

interface AddColumnPermissionFormProps {
  columnId: string;
  onPermissionAdded?: () => void;
}

export function AddColumnPermissionForm({ columnId, onPermissionAdded }: AddColumnPermissionFormProps) {
  const { t } = useTranslation();
  const [users, setUsers] = useState<User[]>([]);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [selectedAccess, setSelectedAccess] = useState<string>('READ');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadUsers();
  }, []);

  const loadUsers = async () => {
    try {
      const data = await authApi.getUsers();
      setUsers(data || []);
    } catch (err) {
      console.error('Failed to load users:', err);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedUserId || !selectedAccess) return;

    setLoading(true);
    setError(null);
    try {
      await authApi.setColumnPermission(selectedUserId, columnId, selectedAccess);
      setSelectedUserId('');
      setSelectedAccess('READ');
      onPermissionAdded?.();
    } catch (err) {
      console.error('Failed to set column permission:', err);
      setError(t('column.permissionAddFailed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      {error && (
        <div className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">
          {error}
        </div>
      )}
      <div className="flex gap-2">
        <select
          value={selectedUserId}
          onChange={(e) => setSelectedUserId(e.target.value)}
          className="flex-1 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-800 transition-all focus:border-blue-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20"
          required
        >
          <option value="">{t('column.selectUser')}</option>
          {users.map((user) => (
            <option key={user.id} value={user.id}>
              {user.nickname} {user.type === 'AGENT' ? `(${t('settings.agent')})` : ''}
            </option>
          ))}
        </select>
        <select
          value={selectedAccess}
          onChange={(e) => setSelectedAccess(e.target.value)}
          className="rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-800 transition-all focus:border-blue-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20"
          required
        >
          <option value="READ">{t('column.permission.READ')}</option>
          <option value="WRITE">{t('column.permission.WRITE')}</option>
          <option value="ADMIN">{t('column.permission.ADMIN')}</option>
        </select>
        <button
          type="submit"
          disabled={loading || !selectedUserId}
          className="rounded-xl bg-gradient-to-r from-violet-500 to-purple-600 px-4 py-2 text-sm font-medium text-white hover:from-violet-600 hover:to-purple-700 disabled:from-zinc-300 disabled:to-zinc-300 transition-all shadow-sm hover:shadow"
        >
          {loading ? t('common.loading') : t('column.add')}
        </button>
      </div>
    </form>
  );
}