import { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { authApi } from '../services/api';
import { LoadingScreen } from '../components/LoadingScreen';
import { UserAvatar } from '../components/UserAvatar';
import { useSetupGuard } from '../hooks/useSetupGuard';
import { ProfileSettings } from '../components/settings/ProfileSettings';
import { TokensSettings } from '../components/settings/TokensSettings';
import { ActivitiesSettings } from '../components/settings/ActivitiesSettings';
import { AgentsSettings } from '../components/settings/AgentsSettings';
import { UsersSettings } from '../components/settings/UsersSettings';
import { ShortcutsSettings } from '../components/settings/ShortcutsSettings';
import { ThemeSettings } from '../components/settings/ThemeSettings';
import { OAuthSettings } from '../components/OAuthSettings';
import { useUIStore } from '../store/uiStore';
import type { User } from '../types/kanban';

type Tab = 'profile' | 'tokens' | 'activities' | 'agents' | 'users' | 'shortcuts' | 'theme' | 'oauth';

const ALL_TABS: Tab[] = ['profile', 'tokens', 'activities', 'agents', 'users', 'shortcuts', 'theme', 'oauth'];

function isTab(value: string | null): value is Tab {
  return value !== null && (ALL_TABS as string[]).includes(value);
}

export function SettingsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  useSetupGuard();
  const [searchParams, setSearchParams] = useSearchParams();
  const [loading, setLoading] = useState(true);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const darkMode = useUIStore((state) => state.darkMode);
  const [activeTab, setActiveTab] = useState<Tab>(() => {
    const tab = searchParams.get('tab');
    return isTab(tab) ? tab : 'profile';
  });
  const [users, setUsers] = useState<User[]>([]);

  const userNicknameMap = users.reduce((acc, user) => {
    acc[user.id] = user.nickname;
    return acc;
  }, {} as Record<string, string>);

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the URL in sync with the active tab so it can be bookmarked
  // and shared. Back/forward navigation also picks up the change.
  useEffect(() => {
    const current = searchParams.get('tab');
    if (current === activeTab) return;
    const next = new URLSearchParams(searchParams);
    next.set('tab', activeTab);
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

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

  const loadUsers = useCallback(async () => {
    try {
      const data = await authApi.getUsers();
      setUsers(data || []);
      return data || [];
    } catch (err) {
      console.error('Failed to load users:', err);
      return [];
    }
  }, []);

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
    <div className="min-h-screen bg-zinc-100 dark:bg-zinc-900 p-6">
      <div className="mx-auto max-w-5xl">
        <div className="mb-6 flex items-center gap-4">
          <Link to="/" className="rounded-md bg-zinc-200 dark:bg-zinc-700 px-3 py-2 text-sm text-zinc-700 dark:text-zinc-200 hover:bg-zinc-300 dark:hover:bg-zinc-600">
            ← {t('settings.back')}
          </Link>
          <h1 className="text-2xl font-bold text-zinc-800 dark:text-zinc-100">{t('settings.title')}</h1>
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
                className={`w-full rounded-md px-3 py-2 text-left text-sm ${activeTab === 'profile' ? 'bg-blue-100 text-blue-700' : 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700'}`}
              >
                {t('settings.profile')}
              </button>
              {currentUser?.role === 'ADMIN' && (
                <button
                  onClick={() => switchToTab('tokens')}
                  className={`w-full rounded-md px-3 py-2 text-left text-sm ${activeTab === 'tokens' ? 'bg-blue-100 text-blue-700' : 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700'}`}
                >
                  {t('settings.tokens')}
                </button>
              )}
              {currentUser?.role === 'ADMIN' && (
                <button
                  onClick={() => switchToTab('activities')}
                  className={`w-full rounded-md px-3 py-2 text-left text-sm ${activeTab === 'activities' ? 'bg-blue-100 text-blue-700' : 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700'}`}
                >
                  {t('settings.activitiesTitle')}
                </button>
              )}
              {currentUser?.role === 'ADMIN' && (
                <button
                  onClick={() => switchToTab('agents')}
                  className={`w-full rounded-md px-3 py-2 text-left text-sm ${activeTab === 'agents' ? 'bg-blue-100 text-blue-700' : 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700'}`}
                >
                  {t('settings.agents')}
                </button>
              )}
              {currentUser?.role === 'ADMIN' && (
                <button
                  onClick={() => switchToTab('users')}
                  className={`w-full rounded-md px-3 py-2 text-left text-sm ${activeTab === 'users' ? 'bg-blue-100 text-blue-700' : 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700'}`}
                >
                  {t('settings.users')}
                </button>
              )}
              <button
                onClick={() => switchToTab('shortcuts')}
                className={`w-full rounded-md px-3 py-2 text-left text-sm ${activeTab === 'shortcuts' ? 'bg-blue-100 text-blue-700' : 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700'}`}
              >
                {t('settings.shortcuts')}
              </button>
              <button
                onClick={() => switchToTab('oauth')}
                className={`w-full rounded-md px-3 py-2 text-left text-sm ${activeTab === 'oauth' ? 'bg-blue-100 text-blue-700' : 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700'}`}
                data-testid="tab-oauth"
              >
                {t('oauth.admin.title')}
              </button>
              <button
                onClick={() => switchToTab('theme')}
                className={`w-full flex items-center justify-between rounded-md px-3 py-2 text-left text-sm ${activeTab === 'theme' ? 'bg-blue-100 text-blue-700' : 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700'}`}
              >
                <span>{t('nav.theme')}</span>
                {darkMode ? (
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-orange-400">
                    <circle cx="12" cy="12" r="5"/>
                    <line x1="12" y1="1" x2="12" y2="3"/>
                    <line x1="12" y1="21" x2="12" y2="23"/>
                    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
                    <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
                    <line x1="1" y1="12" x2="3" y2="12"/>
                    <line x1="21" y1="12" x2="23" y2="12"/>
                    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
                    <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
                  </svg>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-400 dark:text-zinc-500">
                    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
                  </svg>
                )}
              </button>
              <div className="border-t border-zinc-200 dark:border-zinc-700 pt-2 mt-2">
                <button
                  onClick={() => {
                    localStorage.removeItem('token');
                    navigate('/login');
                  }}
                  className="w-full rounded-md px-3 py-2 text-left text-sm text-red-600 hover:bg-zinc-100"
                >
                  {t('auth.logout')}
                </button>
              </div>
            </nav>
          </div>

          <div className="flex-1 rounded-lg bg-white p-6 shadow dark:bg-zinc-800">
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

            {activeTab === 'theme' && (
              <ThemeSettings />
            )}

            {activeTab === 'oauth' && currentUser && (
              <OAuthSettings currentUser={currentUser} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
