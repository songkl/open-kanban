import { useState, useEffect, useCallback, useRef } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { authApi, webhooksApi } from '../services/api';
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
import { WebhooksList } from '../components/settings/WebhooksList';
import { OAuthSettings } from '../components/OAuthSettings';
import { useUIStore } from '../store/uiStore';
import type { User } from '../types/kanban';

type Tab = 'profile' | 'tokens' | 'activities' | 'agents' | 'users' | 'shortcuts' | 'theme' | 'oauth' | 'webhooks';

const ALL_TABS: Tab[] = ['profile', 'tokens', 'activities', 'agents', 'users', 'shortcuts', 'theme', 'oauth', 'webhooks'];

function isTab(value: string | null): value is Tab {
  return value !== null && (ALL_TABS as string[]).includes(value);
}

function sidebarTabClass(active: boolean, extra = ''): string {
  const base = 'w-full rounded-md px-3 py-2 text-left text-sm transition-colors';
  const state = active
    ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
    : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-600 dark:bg-zinc-700';
  return `${base} ${state}${extra ? ' ' + extra : ''}`;
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
      // If the URL pinned a tab the user cannot see (e.g. non-admin
      // landing on ?tab=oauth via a shared link), fall back to the
      // profile so the tabpanel is never blank.
      setActiveTab((current) => {
        if (current === 'oauth' && meData.user!.role !== 'ADMIN') {
          return 'profile';
        }
        return current;
      });
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

  const switchToTab = useCallback((tab: Tab) => {
    setActiveTab(tab);
    if (tab === 'users') {
      loadUsers();
    }
  }, [loadUsers]);

  // s-1199: keyboard navigation between settings tabs (ARIA tablist
  // pattern). The available tab list is computed dynamically based on
  // the current user's role/type so we have to walk the DOM instead
  // of using static indices.
  const tablistRef = useRef<HTMLDivElement>(null);
  const handleTablistKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!tablistRef.current) return;
      const tabs = Array.from(
        tablistRef.current.querySelectorAll<HTMLButtonElement>('[role="tab"]')
      );
      if (tabs.length === 0) return;
      const currentIndex = tabs.findIndex((tab) => tab === document.activeElement);
      let nextIndex = currentIndex;
      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          nextIndex = (currentIndex + 1) % tabs.length;
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
          break;
        case 'Home':
          nextIndex = 0;
          break;
        case 'End':
          nextIndex = tabs.length - 1;
          break;
        default:
          return;
      }
      e.preventDefault();
      const next = tabs[nextIndex];
      if (next) {
        next.focus();
        const tabId = next.dataset.tabId as Tab | undefined;
        if (tabId) switchToTab(tabId);
      }
    },
    [switchToTab]
  );

  if (loading) {
    return <LoadingScreen />;
  }

  return (
    <div className="min-h-screen bg-zinc-100 dark:bg-zinc-900 p-6">
      <div className="mx-auto max-w-5xl">
        <div className="mb-6 flex items-center gap-4">
          <Link
            to="/"
            aria-label={t('settings.back')}
            className="rounded-md bg-zinc-200 dark:bg-zinc-700 px-3 py-2 text-sm text-zinc-700 dark:text-zinc-400 hover:bg-zinc-300 dark:hover:bg-zinc-600"
          >
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
            <div
              ref={tablistRef}
              role="tablist"
              aria-label={t('settings.title')}
              aria-orientation="vertical"
              onKeyDown={handleTablistKeyDown}
              className="space-y-1"
            >
              <button
                type="button"
                role="tab"
                id="settings-tab-profile"
                aria-selected={activeTab === 'profile'}
                aria-controls="settings-panel-profile"
                tabIndex={activeTab === 'profile' ? 0 : -1}
                data-tab-id="profile"
                onClick={() => switchToTab('profile')}
                className={sidebarTabClass(activeTab === 'profile')}
              >
                {t('settings.profile')}
              </button>
              <button
                type="button"
                role="tab"
                id="settings-tab-notifications"
                aria-selected={activeTab === 'notifications'}
                aria-controls="settings-panel-notifications"
                tabIndex={activeTab === 'notifications' ? 0 : -1}
                data-tab-id="notifications"
                onClick={() => switchToTab('notifications')}
                className={sidebarTabClass(activeTab === 'notifications')}
              >
                {t('settings.notificationsTab')}
              </button>
              <button
                type="button"
                role="tab"
                id="settings-tab-errorReporting"
                aria-selected={activeTab === 'errorReporting'}
                aria-controls="settings-panel-errorReporting"
                tabIndex={activeTab === 'errorReporting' ? 0 : -1}
                data-tab-id="errorReporting"
                onClick={() => switchToTab('errorReporting')}
                className={sidebarTabClass(activeTab === 'errorReporting')}
              >
                {t('settings.errorReportingTab')}
              </button>
              {currentUser?.role === 'ADMIN' && (
                <button
                  type="button"
                  role="tab"
                  id="settings-tab-tokens"
                  aria-selected={activeTab === 'tokens'}
                  aria-controls="settings-panel-tokens"
                  tabIndex={activeTab === 'tokens' ? 0 : -1}
                  data-tab-id="tokens"
                  onClick={() => switchToTab('tokens')}
                  className={sidebarTabClass(activeTab === 'tokens')}
                >
                  {t('settings.tokens')}
                </button>
              )}
              {currentUser?.role === 'ADMIN' && (
                <button
                  type="button"
                  role="tab"
                  id="settings-tab-activities"
                  aria-selected={activeTab === 'activities'}
                  aria-controls="settings-panel-activities"
                  tabIndex={activeTab === 'activities' ? 0 : -1}
                  data-tab-id="activities"
                  onClick={() => switchToTab('activities')}
                  className={sidebarTabClass(activeTab === 'activities')}
                >
                  {t('settings.activitiesTitle')}
                </button>
              )}
              {currentUser?.role === 'ADMIN' && (
                <button
                  type="button"
                  role="tab"
                  id="settings-tab-agents"
                  aria-selected={activeTab === 'agents'}
                  aria-controls="settings-panel-agents"
                  tabIndex={activeTab === 'agents' ? 0 : -1}
                  data-tab-id="agents"
                  onClick={() => switchToTab('agents')}
                  className={sidebarTabClass(activeTab === 'agents')}
                >
                  {t('settings.agents')}
                </button>
              )}
              {currentUser?.role === 'ADMIN' && (
                <button
                  type="button"
                  role="tab"
                  id="settings-tab-users"
                  aria-selected={activeTab === 'users'}
                  aria-controls="settings-panel-users"
                  tabIndex={activeTab === 'users' ? 0 : -1}
                  data-tab-id="users"
                  onClick={() => switchToTab('users')}
                  className={sidebarTabClass(activeTab === 'users')}
                >
                  {t('settings.users')}
                </button>
              )}
              <button
                type="button"
                role="tab"
                id="settings-tab-shortcuts"
                aria-selected={activeTab === 'shortcuts'}
                aria-controls="settings-panel-shortcuts"
                tabIndex={activeTab === 'shortcuts' ? 0 : -1}
                data-tab-id="shortcuts"
                onClick={() => switchToTab('shortcuts')}
                className={sidebarTabClass(activeTab === 'shortcuts')}
              >
                {t('settings.shortcuts')}
              </button>
              <button
                onClick={() => switchToTab('oauth')}
                className={`w-full rounded-md px-3 py-2 text-left text-sm ${activeTab === 'oauth' ? 'bg-blue-100 text-blue-700' : 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-600 dark:bg-zinc-700 dark:hover:bg-zinc-700'}`}
                data-testid="tab-oauth"
              >
                {t('oauth.admin.title')}
              </button>
              <button
                onClick={() => switchToTab('webhooks')}
                className={`w-full rounded-md px-3 py-2 text-left text-sm ${activeTab === 'webhooks' ? 'bg-blue-100 text-blue-700' : 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-600 dark:bg-zinc-700 dark:hover:bg-zinc-700'}`}
                data-testid="tab-webhooks"
              >
                {t('settings.webhooks')}
              </button>
              <button
                onClick={() => switchToTab('theme')}
                className={sidebarTabClass(activeTab === 'theme', 'flex items-center justify-between')}
              >
                <span>{t('nav.theme')}</span>
                {darkMode ? (
                  <svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-orange-400">
                    <circle cx="12" cy="12" r="5"/>
                    <line x1="12" y1="1" x2="12" y2="3"/>
                    <line x1="12" y1="21" x2="12" y2="23"/>
                    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
                    <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
                    <line x1="1" y1="12" x2="3" y2="12"/>
                    <line x1="21" y1="12" x2="23" y2="12"/>
                    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
                    <line x1="18.36" y1="5.64" x2="19.78" y2="5.64"/>
                  </svg>
                ) : (
                  <svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-400 dark:text-zinc-500">
                    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
                  </svg>
                )}
              </button>
              {currentUser?.role === 'ADMIN' && (
                <button
                  type="button"
                  role="tab"
                  id="settings-tab-oauth"
                  aria-selected={activeTab === 'oauth'}
                  aria-controls="settings-panel-oauth"
                  tabIndex={activeTab === 'oauth' ? 0 : -1}
                  data-tab-id="oauth"
                  onClick={() => switchToTab('oauth')}
                  className={sidebarTabClass(activeTab === 'oauth')}
                  data-testid="tab-oauth"
                >
                  {t('oauth.admin.title')}
                </button>
              )}
              <div className="border-t border-zinc-200 dark:border-zinc-700 pt-2 mt-2">
                <button
                  type="button"
                  onClick={() => {
                    localStorage.removeItem('token');
                    navigate('/login');
                  }}
                  className="w-full rounded-md px-3 py-2 text-left text-sm text-red-600 hover:bg-zinc-100 dark:hover:bg-zinc-600"
                >
                  {t('auth.logout')}
                </button>
              </div>
            </div>
          </div>

          <div
            className="flex-1 rounded-lg bg-white dark:bg-zinc-800 p-6 shadow"
            role="tabpanel"
            id={`settings-panel-${activeTab}`}
            aria-labelledby={`settings-tab-${activeTab}`}
            tabIndex={0}
          >
            {activeTab === 'profile' && currentUser && (
              <ProfileSettings
                currentUser={currentUser}
                onUserUpdate={(user) => setCurrentUser(user)}
              />
            )}

            {activeTab === 'notifications' && (
              <NotificationsSettings />
            )}

            {activeTab === 'errorReporting' && (
              <ErrorReportingSettings isAdmin={currentUser?.role === 'ADMIN'} />
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

            {activeTab === 'oauth' && currentUser?.role === 'ADMIN' && currentUser && (
              <OAuthSettings currentUser={currentUser} />
            )}

            {activeTab === 'webhooks' && currentUser && (
              <WebhooksList webhooksApi={webhooksApi} isAdmin={currentUser.role === 'ADMIN'} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
