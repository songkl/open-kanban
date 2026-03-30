import { useState, useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { authApi, attachmentsApi } from '../services/api';
import { LoadingScreen } from '../components/LoadingScreen';
import { showErrorToast } from '../components/ErrorToast';
import { UserAvatar } from '../components/UserAvatar';
import type { User, Token, Agent } from '../types/kanban';

type Tab = 'profile' | 'tokens' | 'activities' | 'agents' | 'users' | 'shortcuts';

interface Activity {
  id: string;
  userId: string;
  action: string;
  targetType: string;
  targetId?: string;
  targetTitle?: string;
  details?: string;
  ipAddress?: string;
  source?: string;
  createdAt: string;
}

interface UserWithExtra extends User {
  tokenCount?: number;
  commentCount?: number;
}

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
  const [tokens, setTokens] = useState<Token[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [users, setUsers] = useState<UserWithExtra[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);

  // Agent creation state
  const [newAgentName, setNewAgentName] = useState('');
  const [newAgentRole, setNewAgentRole] = useState<'ADMIN' | 'MEMBER' | 'VIEWER'>('MEMBER');
  const [creatingAgent, setCreatingAgent] = useState(false);
  const [showTokenModal, setShowTokenModal] = useState(false);
  const [newAgentToken, setNewAgentToken] = useState('');
  const [agentTokenCopied, setAgentTokenCopied] = useState(false);

  // Agent editing state
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [editingAgentNickname, setEditingAgentNickname] = useState('');
  const [editingAgentAvatar, setEditingAgentAvatar] = useState('');
  const [editingAgentSaving, setEditingAgentSaving] = useState(false);

  // Profile state
  const [nickname, setNickname] = useState('');
  const [avatar, setAvatar] = useState('');
  const [updateSuccess, setUpdateSuccess] = useState(false);

  // Token state
  const [newTokenName, setNewTokenName] = useState('');
  const [creatingToken, setCreatingToken] = useState(false);
  const [editingTokenId, setEditingTokenId] = useState<string | null>(null);
  const [editingTokenName, setEditingTokenName] = useState('');

  // Activity filter state
  const [activityFilterAction, setActivityFilterAction] = useState('');
  const [activityFilterStartTime, setActivityFilterStartTime] = useState('');
  const [activityFilterEndTime, setActivityFilterEndTime] = useState('');

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
      setNickname(meData.user.nickname);
      setAvatar(meData.user.avatar || '');

      if (meData.user.type === 'AGENT') {
        setActiveTab('activities');
        loadActivities();
      }
      if (meData.user.role === 'ADMIN') {
        loadUsers();
        loadActivities();
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
      setTokens(data.tokens || []);
    } catch (err) {
      console.error('Failed to load tokens:', err);
    }
  };

  const loadActivities = async (filters?: { userId?: string; action?: string; startTime?: string; endTime?: string }) => {
    try {
      const params = new URLSearchParams();
      if (filters?.userId) params.append('userId', filters.userId);
      if (filters?.action) params.append('action', filters.action);
      if (filters?.startTime) params.append('startTime', filters.startTime);
      if (filters?.endTime) params.append('endTime', filters.endTime);
      const queryString = params.toString();
      const res = await fetch(`/api/auth/activities${queryString ? '?' + queryString : ''}`, { credentials: 'include' });
      const data = await res.json();
      setActivities(data.activities || []);
    } catch (err) {
      console.error('Failed to load activities:', err);
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

  const loadAgents = async () => {
    try {
      const data = await authApi.getAgents();
      setAgents(data || []);
    } catch (err) {
      console.error('Failed to load agents:', err);
    }
  };

  const handleUpdateProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentUser || !currentUser.id) return;

    try {
      await authApi.updateUser(currentUser.id, { nickname, avatar: avatar || '' });
      setCurrentUser((prev) => prev ? { ...prev, nickname, avatar } : null);
      setUpdateSuccess(true);
      setTimeout(() => setUpdateSuccess(false), 2000);
    } catch (err) {
      console.error('Failed to update profile:', err);
    }
  };

  const handleCreateToken = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTokenName.trim()) return;

    setCreatingToken(true);
    try {
      await authApi.createToken(newTokenName.trim());
      await loadTokens();
      setNewTokenName('');
      showErrorToast(t('settings.tokenCreated'), 'info');
    } catch (err) {
      console.error('Failed to create token:', err);
      showErrorToast(t('settings.tokenCreateFailed'), 'error');
    } finally {
      setCreatingToken(false);
    }
  };

  const handleUpdateToken = async (id: string) => {
    if (!editingTokenName.trim()) return;

    try {
      await authApi.updateToken(id, editingTokenName.trim());
      await loadTokens();
      setEditingTokenId(null);
      setEditingTokenName('');
    } catch (err) {
      console.error('Failed to update token:', err);
    }
  };

  const handleDeleteToken = async (id: string) => {
    if (!confirm(t('settings.deleteTokenConfirm'))) return;

    try {
      await authApi.deleteToken(id);
      await loadTokens();
    } catch (err) {
      console.error('Failed to delete token:', err);
    }
  };

  const switchToTab = (tab: Tab) => {
    setActiveTab(tab);
    if (tab === 'tokens' && tokens.length === 0) {
      loadTokens();
    }
    if (tab === 'activities') {
      loadActivities();
    }
    if (tab === 'agents') {
      loadAgents();
    }
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
            {activeTab === 'profile' && (
              <form onSubmit={handleUpdateProfile} className="space-y-6">
                <h2 className="text-lg font-semibold text-zinc-800">{t('settings.profile')}</h2>

                <div>
                  <label className="mb-2 block text-sm font-medium text-zinc-700">{t('settings.avatar')}</label>
                  <div className="space-y-4">
                    <div className="flex items-center gap-4">
                      <UserAvatar
                        username={nickname}
                        avatar={avatar}
                        size="lg"
                      />
                      <div className="flex flex-col gap-2">
                        <div className="flex gap-2">
                          <label className="cursor-pointer rounded-md bg-blue-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-600">
                            <input
                              type="file"
                              accept="image/*"
                              className="hidden"
                              onChange={async (e) => {
                                const file = e.target.files?.[0];
                                if (!file) return;
                                try {
                                  const { promise } = attachmentsApi.upload(file);
                                  const attachment = await promise;
                                  setAvatar(attachment.url);
                                } catch (err) {
                                  showErrorToast(t('settings.avatarUploadFailed'));
                                }
                              }}
                            />
                            {t('settings.uploadAvatar')}
                          </label>
                          {avatar && (
                            <button
                              type="button"
                              onClick={() => setAvatar('')}
                              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
                            >
                              {t('settings.useLetterAvatar')}
                            </button>
                          )}
                        </div>
                        <p className="text-xs text-zinc-500">{t('settings.avatarHint')}</p>
                      </div>
                    </div>
                    
                  </div>
                </div>

                <div>
                  <label className="mb-2 block text-sm font-medium text-zinc-700">{t('settings.nickname')}</label>
                  <input
                    type="text"
                    value={nickname}
                    onChange={(e) => setNickname(e.target.value)}
                    className="w-full rounded-md border border-zinc-300 px-4 py-2 focus:border-blue-500 focus:outline-none"
                    maxLength={20}
                  />
                </div>

                <div className="flex items-center gap-4">
                  <button
                    type="submit"
                    className="rounded-md bg-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600"
                  >
                    {t('settings.saveChanges')}
                  </button>
                  {updateSuccess && <span className="text-sm text-green-600">{t('settings.saveSuccess')}</span>}
                </div>
              </form>
            )}

            {activeTab === 'tokens' && (
              <div className="space-y-6">
                <h2 className="text-lg font-semibold text-zinc-800">{t('settings.tokens')}</h2>
                <p className="text-sm text-zinc-500">{t('settings.tokenDescription')}</p>

                <form onSubmit={handleCreateToken} className="flex gap-3">
                  <input
                    type="text"
                    value={newTokenName}
                    onChange={(e) => setNewTokenName(e.target.value)}
                    placeholder={t('settings.tokenNamePlaceholder')}
                    className="flex-1 rounded-md border border-zinc-300 px-4 py-2 focus:border-blue-500 focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={creatingToken || !newTokenName.trim()}
                    className="rounded-md bg-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600 disabled:bg-zinc-300"
                  >
                    {creatingToken ? t('settings.creating') : t('settings.createToken')}
                  </button>
                </form>

                <div className="space-y-3">
                  {tokens.map((token) => (
                    <div key={token.id} className="flex items-center justify-between rounded-lg border border-zinc-200 p-4">
                      <div className="flex-1">
                        {editingTokenId === token.id ? (
                          <div className="flex items-center gap-2">
                            <input
                              type="text"
                              value={editingTokenName}
                              onChange={(e) => setEditingTokenName(e.target.value)}
                              className="rounded-md border border-zinc-300 px-3 py-1 text-sm focus:border-blue-500 focus:outline-none"
                              autoFocus
                            />
                            <button
                              onClick={() => handleUpdateToken(token.id)}
                              className="rounded bg-green-500 px-2 py-1 text-xs text-white hover:bg-green-600"
                            >
                              {t('settings.save')}
                            </button>
                            <button
                              onClick={() => setEditingTokenId(null)}
                              className="rounded bg-zinc-200 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-300"
                            >
                              {t('settings.cancel')}
                            </button>
                          </div>
                        ) : (
                          <div>
                            <div className="font-medium text-zinc-800">{token.name}</div>
                            <div className="font-mono text-sm text-zinc-500">{token.key}</div>
                            <div className="mt-1 text-xs text-zinc-400">
                              {t('settings.createdAt', { date: new Date(token.createdAt).toLocaleDateString() })}
                            </div>
                          </div>
                        )}
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => {
                            setEditingTokenId(token.id);
                            setEditingTokenName(token.name);
                          }}
                          className="rounded bg-zinc-100 px-3 py-1 text-sm text-zinc-600 hover:bg-zinc-200"
                        >
                          {t('settings.rename')}
                        </button>
                        <button
                          onClick={() => handleDeleteToken(token.id)}
                          className="rounded bg-red-50 px-3 py-1 text-sm text-red-600 hover:bg-red-100"
                        >
                          {t('settings.delete')}
                        </button>
                      </div>
                    </div>
                  ))}
                  {tokens.length === 0 && (
                    <div className="py-8 text-center text-zinc-500">{t('settings.noTokens')}</div>
                  )}
                </div>
              </div>
            )}

            {activeTab === 'activities' && (
              <div className="space-y-6">
                <h2 className="text-lg font-semibold text-zinc-800">{t('settings.activitiesTitle')}</h2>
                <p className="text-sm text-zinc-500">{t('settings.activitiesDescription')}</p>

                {currentUser?.role === 'ADMIN' && (
                  <div className="rounded-lg border border-zinc-200 p-4">
                    <h3 className="mb-3 text-sm font-medium text-zinc-700">{t('settings.filterConditions')}</h3>
                    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                      <div>
                        <label className="mb-1 block text-xs text-zinc-500">{t('settings.operationType')}</label>
                        <select
                          value={activityFilterAction}
                          onChange={(e) => setActivityFilterAction(e.target.value)}
                          className="w-full rounded-md border border-zinc-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
                        >
                          <option value="">{t('filter.all')}</option>
                          <option value="CREATE_TASK">{t('settings.activities.CREATE_TASK')}</option>
                          <option value="UPDATE_TASK">{t('settings.activities.UPDATE_TASK')}</option>
                          <option value="DELETE_TASK">{t('settings.activities.DELETE_TASK')}</option>
                          <option value="COMPLETE_TASK">{t('settings.activities.COMPLETE_TASK')}</option>
                          <option value="ADD_COMMENT">{t('settings.activities.ADD_COMMENT')}</option>
                          <option value="BOARD_CREATE">{t('settings.activities.BOARD_CREATE')}</option>
                          <option value="BOARD_UPDATE">{t('settings.activities.BOARD_UPDATE')}</option>
                          <option value="BOARD_DELETE">{t('settings.activities.BOARD_DELETE')}</option>
                          <option value="COLUMN_CREATE">{t('settings.activities.COLUMN_CREATE')}</option>
                          <option value="COLUMN_UPDATE">{t('settings.activities.COLUMN_UPDATE')}</option>
                          <option value="COLUMN_DELETE">{t('settings.activities.COLUMN_DELETE')}</option>
                          <option value="USER_CREATE">{t('settings.activities.USER_CREATE')}</option>
                          <option value="USER_UPDATE">{t('settings.activities.USER_UPDATE')}</option>
                          <option value="LOGIN">{t('settings.activities.LOGIN')}</option>
                          <option value="LOGOUT">{t('settings.activities.LOGOUT')}</option>
                        </select>
                      </div>
                      <div>
                        <label className="mb-1 block text-xs text-zinc-500">{t('settings.startTime')}</label>
                        <input
                          type="datetime-local"
                          value={activityFilterStartTime}
                          onChange={(e) => setActivityFilterStartTime(e.target.value)}
                          className="w-full rounded-md border border-zinc-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs text-zinc-500">{t('settings.endTime')}</label>
                        <input
                          type="datetime-local"
                          value={activityFilterEndTime}
                          onChange={(e) => setActivityFilterEndTime(e.target.value)}
                          className="w-full rounded-md border border-zinc-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
                        />
                      </div>
                      <div className="flex items-end">
                        <button
                          onClick={() => loadActivities({
                            action: activityFilterAction || undefined,
                            startTime: activityFilterStartTime || undefined,
                            endTime: activityFilterEndTime || undefined,
                          })}
                          className="rounded-md bg-blue-500 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-600"
                        >
                          {t('settings.applyFilter')}
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                <div className="h-[calc(100vh-380px)] overflow-y-auto rounded-xl border border-zinc-200 bg-white">
                  <div className="p-4 space-y-3">
                    {activities.map((activity) => (
                      <div key={activity.id} className="flex items-start gap-4 rounded-lg border border-zinc-100 p-4">
                        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-100">
                          {activity.action === 'CREATE_TASK' && <span className="text-lg">📝</span>}
                          {activity.action === 'COMPLETE_TASK' && <span className="text-lg">✅</span>}
                          {activity.action === 'ADD_COMMENT' && <span className="text-lg">💬</span>}
                          {activity.action === 'UPDATE_TASK' && <span className="text-lg">✏️</span>}
                          {activity.action === 'DELETE_TASK' && <span className="text-lg">🗑️</span>}
                          {activity.action === 'BOARD_CREATE' && <span className="text-lg">📋</span>}
                          {activity.action === 'BOARD_UPDATE' && <span className="text-lg">📋</span>}
                          {activity.action === 'BOARD_DELETE' && <span className="text-lg">📋</span>}
                          {activity.action === 'COLUMN_CREATE' && <span className="text-lg">📑</span>}
                          {activity.action === 'COLUMN_UPDATE' && <span className="text-lg">📑</span>}
                          {activity.action === 'COLUMN_DELETE' && <span className="text-lg">📑</span>}
                          {activity.action === 'USER_CREATE' && <span className="text-lg">👤</span>}
                          {activity.action === 'USER_UPDATE' && <span className="text-lg">👤</span>}
                          {activity.action === 'LOGIN' && <span className="text-lg">🔑</span>}
                          {activity.action === 'LOGOUT' && <span className="text-lg">🔒</span>}
                          {activity.action === 'BOARD_COPY' && <span className="text-lg">📋</span>}
                          {activity.action === 'TEMPLATE_CREATE' && <span className="text-lg">📝</span>}
                          {activity.action === 'TEMPLATE_DELETE' && <span className="text-lg">🗑️</span>}
                          {activity.action === 'BOARD_IMPORT' && <span className="text-lg">📥</span>}
                        </div>
                        <div className="flex-1">
                          <div className="font-medium text-zinc-800">
                            {typeof t(`settings.activities.${activity.action}`) === 'string' ? t(`settings.activities.${activity.action}`) : activity.action}
                          </div>
                          {activity.targetTitle && (
                            <div className="text-sm text-zinc-600">{activity.targetTitle}</div>
                          )}
                          {currentUser?.role === 'ADMIN' && (
                            <div className="mt-1 text-xs text-zinc-400">
                              {t('settings.operator')}: {userNicknameMap[activity.userId] || activity.userId} | {new Date(activity.createdAt).toLocaleString()}
                              {activity.ipAddress && (
                                <> | IP: {activity.ipAddress}</>
                              )}
                              {activity.source && (
                                <> | {t('settings.source')}: {activity.source === 'mcp' ? t('settings.agentActivity.sourceMcp') : t('settings.agentActivity.sourceWeb')}</>
                              )}
                            </div>
                          )}
                          {currentUser?.role !== 'ADMIN' && (
                            <div className="mt-1 text-xs text-zinc-400">
                              {new Date(activity.createdAt).toLocaleString()}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                    {activities.length === 0 && (
                      <div className="py-8 text-center text-zinc-500">{t('settings.noActivities')}</div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'shortcuts' && (
              <div className="space-y-6">
                <h2 className="text-lg font-semibold text-zinc-800">{t('settings.shortcuts')}</h2>
                <p className="text-sm text-zinc-500">{t('settings.shortcutsDescription')}</p>
                <div className="space-y-6">
                  <div>
                    <h3 className="mb-3 text-sm font-medium text-zinc-700">{t('settings.shortcutsGlobal')}</h3>
                    <div className="rounded-lg border border-zinc-200 divide-y divide-zinc-100">
                      <div className="flex items-center justify-between px-4 py-3">
                        <span className="text-sm text-zinc-600">{t('settings.shortcutSearch')}</span>
                        <kbd className="rounded bg-zinc-100 px-2 py-1 text-xs font-mono text-zinc-600">/</kbd>
                      </div>
                      <div className="flex items-center justify-between px-4 py-3">
                        <span className="text-sm text-zinc-600">{t('settings.shortcutNewTask')}</span>
                        <kbd className="rounded bg-zinc-100 px-2 py-1 text-xs font-mono text-zinc-600">N</kbd>
                      </div>
                      <div className="flex items-center justify-between px-4 py-3">
                        <span className="text-sm text-zinc-600">{t('settings.shortcutEditTask')}</span>
                        <div className="flex gap-1">
                          <kbd className="rounded bg-zinc-100 px-2 py-1 text-xs font-mono text-zinc-600">E</kbd>
                        </div>
                      </div>
                      <div className="flex items-center justify-between px-4 py-3">
                        <span className="text-sm text-zinc-600">{t('settings.shortcutSaveTask')}</span>
                        <div className="flex gap-1">
                          <kbd className="rounded bg-zinc-100 px-2 py-1 text-xs font-mono text-zinc-600">Ctrl</kbd>
                          <span className="text-xs text-zinc-400">+</span>
                          <kbd className="rounded bg-zinc-100 px-2 py-1 text-xs font-mono text-zinc-600">S</kbd>
                        </div>
                      </div>
                      <div className="flex items-center justify-between px-4 py-3">
                        <span className="text-sm text-zinc-600">{t('settings.shortcutCancelEdit')}</span>
                        <kbd className="rounded bg-zinc-100 px-2 py-1 text-xs font-mono text-zinc-600">Esc</kbd>
                      </div>
                      <div className="flex items-center justify-between px-4 py-3">
                        <span className="text-sm text-zinc-600">{t('settings.shortcutQuickAdd')}</span>
                        <kbd className="rounded bg-zinc-100 px-2 py-1 text-xs font-mono text-zinc-600">Q</kbd>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'agents' && currentUser?.role === 'ADMIN' && (
              <div className="space-y-6">
                <h2 className="text-lg font-semibold text-zinc-800">{t('settings.agentManagement')}</h2>
                <p className="text-sm text-zinc-500">{t('settings.agentDescription')}</p>

                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (!newAgentName.trim()) return;
                    setCreatingAgent(true);
                    try {
                      const data = await authApi.createAgent(newAgentName.trim(), undefined, newAgentRole);
                      await loadAgents();
                      setNewAgentName('');
                      setNewAgentRole('MEMBER');
                      setNewAgentToken(data.agent.token);
                      setShowTokenModal(true);
                    } catch (err) {
                      console.error('Failed to create agent:', err);
                    } finally {
                      setCreatingAgent(false);
                    }
                  }}
                  className="flex gap-3"
                >
                  <input
                    type="text"
                    value={newAgentName}
                    onChange={(e) => setNewAgentName(e.target.value)}
                    placeholder={t('settings.agentNamePlaceholder')}
                    className="flex-1 rounded-md border border-zinc-300 px-4 py-2 focus:border-blue-500 focus:outline-none"
                  />
                  <select
                    value={newAgentRole}
                    onChange={(e) => setNewAgentRole(e.target.value as 'ADMIN' | 'MEMBER' | 'VIEWER')}
                    className="rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  >
                    <option value="ADMIN">{t('settings.admin')}</option>
                    <option value="MEMBER">{t('settings.member')}</option>
                    <option value="VIEWER">{t('settings.viewer')}</option>
                  </select>
                  <button
                    type="submit"
                    disabled={creatingAgent || !newAgentName.trim()}
                    className="rounded-md bg-green-500 px-4 py-2 text-sm font-medium text-white hover:bg-green-600 disabled:bg-zinc-300"
                  >
                    {creatingAgent ? t('settings.creating') : t('settings.createAgent')}
                  </button>
                </form>

                <div className="space-y-3">
                  {agents.map((agent) => (
                    <div key={agent.id} className="flex items-center justify-between rounded-lg border border-zinc-200 p-4">
                      <div className="flex items-center gap-3">
                        <UserAvatar
                          username={agent.nickname}
                          avatar={agent.avatar}
                          size="md"
                        />
                        <div>
                          <div className="font-medium text-zinc-800">{agent.nickname}</div>
                          <div className="flex gap-2 text-xs text-zinc-500">
                            <span className={`rounded px-1.5 py-0.5 text-xs ${agent.role === 'ADMIN' ? 'bg-blue-200 text-blue-800' : agent.role === 'MEMBER' ? 'bg-green-200 text-green-800' : 'bg-zinc-200 text-zinc-600'}`}>
                              {agent.role === 'ADMIN' ? t('settings.admin') : agent.role === 'MEMBER' ? t('settings.member') : t('settings.viewer')}
                            </span>
                            {agent.lastActiveAt && (
                              <span>{t('settings.lastActive', { time: new Date(agent.lastActiveAt).toLocaleString() })}</span>
                            )}
                            {!agent.lastActiveAt && <span>{t('settings.neverActive')}</span>}
                          </div>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={async () => {
                            if (!confirm(t('settings.toggleEnabledConfirm', { name: agent.nickname, action: agent.enabled ? t('settings.disable') : t('settings.enable') }))) return;
                            try {
                              await authApi.setUserEnabled(agent.id, !agent.enabled);
                              await loadAgents();
                            } catch (err) {
                              console.error('Failed to toggle agent enabled:', err);
                            }
                          }}
                          className={`rounded px-3 py-1 text-sm ${agent.enabled ? 'bg-orange-50 text-orange-600 hover:bg-orange-100' : 'bg-green-50 text-green-600 hover:bg-green-100'}`}
                        >
                          {agent.enabled ? t('settings.disable') : t('settings.enable')}
                        </button>
                        <button
                          onClick={async () => {
                            setEditingAgent(agent);
                            setEditingAgentNickname(agent.nickname);
                            setEditingAgentAvatar(agent.avatar || '');
                          }}
                          className="rounded bg-zinc-100 px-3 py-1 text-sm text-zinc-700 hover:bg-zinc-200"
                        >
                          {t('settings.edit')}
                        </button>
                        <button
                          onClick={async () => {
                            if (!confirm(t('settings.resetTokenConfirm', { name: agent.nickname }))) return;
                            try {
                              const data = await authApi.resetAgentToken(agent.id);
                              setNewAgentToken(data.token);
                              setShowTokenModal(true);
                            } catch (err) {
                              console.error('Failed to reset token:', err);
                            }
                          }}
                          className="rounded bg-blue-50 px-3 py-1 text-sm text-blue-600 hover:bg-blue-100"
                        >
                          {t('settings.resetToken')}
                        </button>
                        <button
                          onClick={async () => {
                            if (!confirm(t('settings.deleteAgentConfirm', { name: agent.nickname }))) return;
                            try {
                              await authApi.deleteAgent(agent.id);
                              await loadAgents();
                            } catch (err) {
                              console.error('Failed to delete agent:', err);
                            }
                          }}
                          className="rounded bg-red-50 px-3 py-1 text-sm text-red-600 hover:bg-red-100"
                        >
                          {t('settings.delete')}
                        </button>
                      </div>
                    </div>
                  ))}
                  {agents.length === 0 && (
                    <div className="py-8 text-center text-zinc-500">{t('settings.noAgents')}</div>
                  )}
                </div>
              </div>
            )}

            {activeTab === 'users' && currentUser?.role === 'ADMIN' && (
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
                          <div className="font-medium text-zinc-800">{user.nickname}</div>
                          <div className="flex gap-2 mt-1">
                            <select
                              value={user.role}
                              onChange={async (e) => {
                                const newRole = e.target.value as 'ADMIN' | 'MEMBER' | 'VIEWER';
                                if (newRole === user.role) return;
                                if (!confirm(t('settings.confirmRoleChange', { name: user.nickname, role: newRole === 'ADMIN' ? t('settings.admin') : newRole === 'MEMBER' ? t('settings.member') : t('settings.viewer') }))) return;
                                try {
                                  await authApi.updateUser(user.id, { role: newRole });
                                  await loadUsers();
                                } catch (err) {
                                  console.error('Failed to update user role:', err);
                                }
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
                          onClick={async () => {
                            if (user.id === currentUser?.id) {
                              showErrorToast(t('settings.cannotDisableSelf'), 'warning');
                              return;
                            }
                            if (!confirm(t('settings.toggleEnabledConfirm', { name: user.nickname, action: user.enabled ? t('settings.disable') : t('settings.enable') }))) return;
                            try {
                              await authApi.setUserEnabled(user.id, !user.enabled);
                              await loadUsers();
                            } catch (err) {
                              console.error('Failed to toggle user enabled:', err);
                            }
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
              </div>
            )}
          </div>
        </div>
      </div>

      {showTokenModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" />
          <div className="relative z-10 w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
            <h2 className="mb-4 text-lg font-semibold text-zinc-800">{t('settings.tokenGenerated')}</h2>
            <p className="mb-4 text-sm text-zinc-500">{t('settings.tokenGeneratedHint')}</p>
            <div className="mb-4 flex items-center gap-2 rounded-lg bg-zinc-100 p-3">
              <code className="flex-1 break-all font-mono text-sm">{newAgentToken}</code>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(newAgentToken).then(() => {
                    setAgentTokenCopied(true);
                    setTimeout(() => setAgentTokenCopied(false), 2000);
                  }).catch(() => {
                    showErrorToast(t('settings.copyFailed'), 'error');
                  });
                }}
                className={`rounded px-3 py-1 text-sm text-white transition-colors ${
                  agentTokenCopied ? 'bg-green-500' : 'bg-blue-500 hover:bg-blue-600'
                }`}
              >
                {agentTokenCopied ? t('settings.copied') : t('settings.copy')}
              </button>
            </div>
            <button
              onClick={() => setShowTokenModal(false)}
              className="w-full rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-200"
            >
              {t('settings.close')}
            </button>
          </div>
        </div>
      )}

      {editingAgent && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => setEditingAgent(null)} />
          <div className="relative z-10 w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
            <h2 className="mb-4 text-lg font-semibold text-zinc-800">{t('settings.editAgent')}</h2>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (!editingAgentNickname.trim()) return;
                setEditingAgentSaving(true);
                try {
                  await authApi.updateUser(editingAgent.id, {
                    nickname: editingAgentNickname.trim(),
                    avatar: editingAgentAvatar || '',
                  });
                  await loadAgents();
                  setEditingAgent(null);
                } catch (err) {
                  console.error('Failed to update agent:', err);
                  showErrorToast(t('settings.updateAgentFailed'));
                } finally {
                  setEditingAgentSaving(false);
                }
              }}
              className="space-y-4"
            >
              <div>
                <label className="mb-2 block text-sm font-medium text-zinc-700">{t('settings.avatar')}</label>
                <div className="space-y-3">
                  <div className="flex items-center gap-4">
                    <UserAvatar
                      username={editingAgentNickname}
                      avatar={editingAgentAvatar}
                      size="lg"
                    />
                    <div className="flex flex-col gap-2">
                      <div className="flex gap-2">
                        <label className="cursor-pointer rounded-md bg-blue-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-600">
                          <input
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={async (e) => {
                              const file = e.target.files?.[0];
                              if (!file) return;
                              try {
                                const { promise } = attachmentsApi.upload(file);
                                const attachment = await promise;
                                setEditingAgentAvatar(attachment.url);
                              } catch (err) {
                                showErrorToast(t('settings.avatarUploadFailed'));
                              }
                            }}
                          />
                          {t('settings.uploadAvatar')}
                        </label>
                        {editingAgentAvatar && (
                          <button
                            type="button"
                            onClick={() => setEditingAgentAvatar('')}
                            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
                          >
                            {t('settings.useLetterAvatar')}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div>
                <label className="mb-2 block text-sm font-medium text-zinc-700">{t('settings.nickname')}</label>
                <input
                  type="text"
                  value={editingAgentNickname}
                  onChange={(e) => setEditingAgentNickname(e.target.value)}
                  className="w-full rounded-md border border-zinc-300 px-4 py-2 focus:border-blue-500 focus:outline-none"
                  maxLength={20}
                />
              </div>
              <div className="flex gap-2 pt-2">
                <button
                  type="submit"
                  disabled={editingAgentSaving || !editingAgentNickname.trim()}
                  className="flex-1 rounded-md bg-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600 disabled:bg-zinc-300"
                >
                  {editingAgentSaving ? t('settings.saving') : t('settings.save')}
                </button>
                <button
                  type="button"
                  onClick={() => setEditingAgent(null)}
                  className="flex-1 rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-200"
                >
                  {t('settings.cancel')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
