import { useState, useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { authApi } from '../services/api';
import { LoadingScreen } from '../components/LoadingScreen';
import { UserAvatar } from '../components/UserAvatar';
import { ProfileSettings } from '../components/settings/ProfileSettings';
import { TokensSettings } from '../components/settings/TokensSettings';
import { ActivitiesSettings } from '../components/settings/ActivitiesSettings';
import { AgentsSettings } from '../components/settings/AgentsSettings';
import { UsersSettings } from '../components/settings/UsersSettings';
import { ShortcutsSettings } from '../components/settings/ShortcutsSettings';
import type { User } from '../types/kanban';

type Tab = 'profile' | 'tokens' | 'activities' | 'agents' | 'users' | 'shortcuts';

export function SettingsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [loading, setLoading] = useState(true);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>(() => {
    const tab = searchParams.get('tab');
    if (tab === 'users') return tab;
    return 'profile';
  });
  const [users, setUsers] = useState<User[]>([]);

  const userNicknameMap = users.reduce((acc, user) => {
    acc[user.id] = user.nickname;
    return acc;
  }, {} as Record<string, string>);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const meData = await authApi.me();
      if (!meData.user) {
        navigate('/');
        return;
      }
      setCurrentUser(meData.user);

      if (meData.user.type === 'AGENT') {
        setActiveTab('activities');
      }
      if (meData.user.role === 'ADMIN') {
        loadUsers();
      }
    } catch (err) {
      console.error('Failed to load user data:', err);
    } finally {
      setLoading(false);
    }
  };

  const loadTokens = async () => {
    try {
      const data = await authApi.getTokens();
      return data.tokens || [];
    } catch (err) {
      console.error('Failed to load tokens:', err);
      return [];
    }
  };

  const loadUsers = async () => {
    try {
      const data = await authApi.getUsers();
      setUsers(data || []);
      return data || [];
    } catch (err) {
      console.error('Failed to load users:', err);
      return [];
    }
  };

  const switchToTab = (tab: Tab) => {
    setActiveTab(tab);
    if (tab === 'users') {
      loadUsers();
    }
  };

  if (loading) {
    return <LoadingScreen />;
  }

  return (
    <div className="min-h-screen bg-zinc-100 p-6">
      <div className="mx-auto max-w-5xl">
        <div className="mb-6 flex items-center gap-4">
          <Link to="/" className="rounded-md bg-zinc-200 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-300">
            ← {t('settings.back')}
          </Link>
          <h1 className="text-2xl font-bold text-zinc-800">{t('settings.title')}</h1>
          <div className="ml-auto flex items-center gap-2">
            <UserAvatar
              username={currentUser?.nickname || ''}
              avatar={currentUser?.avatar}
              size="md"
            />
            <span className="font-medium">{currentUser?.nickname}</span>
            {currentUser?.role === 'ADMIN' && (
              <span className="rounded bg-blue-200 px-1.5 py-0.5 text-xs font-medium text-blue-800">{t('settings.admin')}</span>
            )}
            {currentUser?.type === 'AGENT' && (
              <span className="rounded bg-green-200 px-1.5 py-0.5 text-xs font-medium text-green-800">{t('settings.agent')}</span>
            )}
          </div>
        </div>

        <div className="flex gap-6">
          <div className="w-48 flex-shrink-0">
            <nav className="space-y-1">
              <button
                onClick={() => switchToTab('profile')}
                className={`w-full rounded-md px-3 py-2 text-left text-sm ${activeTab === 'profile' ? 'bg-blue-100 text-blue-700' : 'text-zinc-600 hover:bg-zinc-50'}`}
              >
                {t('settings.profile')}
              </button>
              {currentUser?.role === 'ADMIN' && (
                <button
                  onClick={() => switchToTab('tokens')}
                  className={`w-full rounded-md px-3 py-2 text-left text-sm ${activeTab === 'tokens' ? 'bg-blue-100 text-blue-700' : 'text-zinc-600 hover:bg-zinc-50'}`}
                >
                  {t('settings.tokens')}
                </button>
              )}
              {currentUser?.role === 'ADMIN' && (
                <button
                  onClick={() => switchToTab('activities')}
                  className={`w-full rounded-md px-3 py-2 text-left text-sm ${activeTab === 'activities' ? 'bg-blue-100 text-blue-700' : 'text-zinc-600 hover:bg-zinc-50'}`}
                >
                  {t('settings.activitiesTitle')}
                </button>
              )}
              {currentUser?.role === 'ADMIN' && (
                <button
                  onClick={() => switchToTab('agents')}
                  className={`w-full rounded-md px-3 py-2 text-left text-sm ${activeTab === 'agents' ? 'bg-blue-100 text-blue-700' : 'text-zinc-600 hover:bg-zinc-50'}`}
                >
                  {t('settings.agents')}
                </button>
              )}
              {currentUser?.role === 'ADMIN' && (
                <button
                  onClick={() => switchToTab('users')}
                  className={`w-full rounded-md px-3 py-2 text-left text-sm ${activeTab === 'users' ? 'bg-blue-100 text-blue-700' : 'text-zinc-600 hover:bg-zinc-50'}`}
                >
                  {t('settings.users')}
                </button>
              )}
              <button
                onClick={() => switchToTab('shortcuts')}
                className={`w-full rounded-md px-3 py-2 text-left text-sm ${activeTab === 'shortcuts' ? 'bg-blue-100 text-blue-700' : 'text-zinc-600 hover:bg-zinc-50'}`}
              >
                {t('settings.shortcuts')}
              </button>
            </nav>
          </div>

          <div className="flex-1 rounded-lg bg-white p-6 shadow">
            {activeTab === 'profile' && currentUser && (
              <ProfileSettings
                currentUser={currentUser}
                onUserUpdate={(user) => setCurrentUser(user)}
              />
            )}

            {activeTab === 'tokens' && (
              <TokensSettings onLoadTokens={loadTokens} />
            )}

            {activeTab === 'activities' && (
              <ActivitiesSettings
                currentUser={currentUser}
                userNicknameMap={userNicknameMap}
              />
            )}

            {activeTab === 'agents' && (
              <AgentsSettings />
            )}

            {activeTab === 'users' && currentUser?.role === 'ADMIN' && (
              <UsersSettings
                currentUser={currentUser}
                onLoadUsers={loadUsers}
              />
            )}

            {activeTab === 'shortcuts' && (
              <ShortcutsSettings />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
