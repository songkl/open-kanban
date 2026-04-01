import { useState, useEffect } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { authApi, activitiesApi } from '../services/api';
import { LoadingScreen } from '../components/LoadingScreen';
import { UserAvatar } from '../components/UserAvatar';
import type { User } from '../types/kanban';

type Tab = 'profile' | 'activities' | 'permissions' | 'boards';

interface BoardPermission {
  id: string;
  boardId: string;
  boardName: string;
  access: string;
}

interface ColumnPermission {
  id: string;
  columnId: string;
  columnName: string;
  access: string;
}

interface Activity {
  id: string;
  userId: string;
  userNickname?: string;
  userAvatar?: string;
  action: string;
  targetType: string;
  targetId?: string;
  targetTitle?: string;
  details?: string;
  ipAddress?: string;
  source?: string;
  createdAt: string;
}

export function UserDetailPage() {
  const { t } = useTranslation();
  const { userId } = useParams<{ userId: string }>();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [targetUser, setTargetUser] = useState<User | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('profile');
  const [activities, setActivities] = useState<Activity[]>([]);
  const [boardPermissions, setBoardPermissions] = useState<BoardPermission[]>([]);
  const [columnPermissions, setColumnPermissions] = useState<ColumnPermission[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [activitiesOffset, setActivitiesOffset] = useState(0);
  const [hasMoreActivities, setHasMoreActivities] = useState(true);

  useEffect(() => {
    loadData();
  }, [userId]);

  const loadData = async () => {
    if (!userId) return;
    try {
      setLoading(true);
      const [meData, usersData] = await Promise.all([
        authApi.me(),
        authApi.getUsers(),
      ]);
      setCurrentUser(meData.user);
      const foundUser = usersData.find((u: User) => u.id === userId);
      if (!foundUser) {
        navigate('/settings?tab=users');
        return;
      }
      setTargetUser(foundUser);
      await Promise.all([
        loadActivities(true),
        loadPermissions(),
      ]);
    } catch (err) {
      console.error('Failed to load user data:', err);
    } finally {
      setLoading(false);
    }
  };

  const loadActivities = async (reset = false) => {
    if (!userId) return;
    try {
      if (reset) {
        setActivitiesOffset(0);
        setActivities([]);
      }
      const offset = reset ? 0 : activitiesOffset;
      const data = await activitiesApi.getByUser(userId, offset, 20);
      if (reset) {
        setActivities(data.activities || []);
      } else {
        setActivities(prev => [...prev, ...(data.activities || [])]);
      }
      setHasMoreActivities(data.hasMore || false);
      setActivitiesOffset(offset + (data.activities?.length || 0));
    } catch (err) {
      console.error('Failed to load activities:', err);
    }
  };

  const loadPermissions = async () => {
    if (!userId) return;
    try {
      const [boardPerms, columnPerms] = await Promise.all([
        authApi.getPermissions(userId),
        authApi.getColumnPermissions(userId),
      ]);
      setBoardPermissions(boardPerms.permissions || []);
      setColumnPermissions(columnPerms.permissions || []);
    } catch (err) {
      console.error('Failed to load permissions:', err);
    }
  };

  const handleLoadMoreActivities = async () => {
    setLoadingMore(true);
    await loadActivities(false);
    setLoadingMore(false);
  };

  const getActionLabel = (action: string) => {
    return t(`settings.activities.${action}`, action);
  };

  const formatTime = (timeStr: string) => {
    const date = new Date(timeStr);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    if (minutes < 1) return t('time.justNow', 'Just now');
    if (minutes < 60) return t('time.minutesAgo', '{{count}} min ago', { count: minutes });
    if (hours < 24) return t('time.hoursAgo', '{{count}} hours ago', { count: hours });
    if (days < 7) return t('time.daysAgo', '{{count}} days ago', { count: days });
    return date.toLocaleDateString();
  };

  if (loading) {
    return <LoadingScreen />;
  }

  if (!targetUser) {
    return (
      <div className="min-h-screen bg-zinc-100 flex items-center justify-center">
        <div className="text-zinc-500">{t('userDetail.notFound', 'User not found')}</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-100 p-6">
      <div className="mx-auto max-w-5xl">
        <div className="mb-6 flex items-center gap-4">
          <Link
            to="/settings?tab=users"
            className="rounded-md bg-zinc-200 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-300 dark:bg-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-600"
          >
            ← {t('userDetail.back', 'Back to Users')}
          </Link>
          <h1 className="text-2xl font-bold text-zinc-800 dark:text-zinc-100">{t('userDetail.title', 'User Detail')}</h1>
          <div className="ml-auto flex items-center gap-2">
            <UserAvatar
              username={targetUser.nickname}
              avatar={targetUser.avatar}
              size="md"
            />
            <span className="font-medium text-zinc-800 dark:text-zinc-100">{targetUser.nickname}</span>
            {targetUser.role === 'ADMIN' && (
              <span className="rounded bg-blue-200 px-1.5 py-0.5 text-xs font-medium text-blue-800">{t('settings.admin')}</span>
            )}
            {targetUser.type === 'AGENT' && (
              <span className="rounded bg-green-200 px-1.5 py-0.5 text-xs font-medium text-green-800">{t('settings.agent')}</span>
            )}
          </div>
        </div>

        <div className="flex gap-6">
          <div className="w-48 flex-shrink-0">
            <nav className="space-y-1">
              <button
                onClick={() => setActiveTab('profile')}
                className={`w-full rounded-md px-3 py-2 text-left text-sm ${
                  activeTab === 'profile'
                    ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-200'
                    : 'text-zinc-600 hover:bg-zinc-50 dark:text-zinc-400 dark:hover:bg-zinc-800'
                }`}
              >
                {t('userDetail.profile', 'Profile')}
              </button>
              {currentUser?.role === 'ADMIN' && (
                <button
                  onClick={() => setActiveTab('activities')}
                  className={`w-full rounded-md px-3 py-2 text-left text-sm ${
                    activeTab === 'activities'
                      ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-200'
                      : 'text-zinc-600 hover:bg-zinc-50 dark:text-zinc-400 dark:hover:bg-zinc-800'
                  }`}
                >
                  {t('userDetail.activities', 'Activities')}
                </button>
              )}
              {currentUser?.role === 'ADMIN' && (
                <button
                  onClick={() => setActiveTab('permissions')}
                  className={`w-full rounded-md px-3 py-2 text-left text-sm ${
                    activeTab === 'permissions'
                      ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-200'
                      : 'text-zinc-600 hover:bg-zinc-50 dark:text-zinc-400 dark:hover:bg-zinc-800'
                  }`}
                >
                  {t('userDetail.permissions', 'Permissions')}
                </button>
              )}
              {currentUser?.role === 'ADMIN' && (
                <button
                  onClick={() => setActiveTab('boards')}
                  className={`w-full rounded-md px-3 py-2 text-left text-sm ${
                    activeTab === 'boards'
                      ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-200'
                      : 'text-zinc-600 hover:bg-zinc-50 dark:text-zinc-400 dark:hover:bg-zinc-800'
                  }`}
                >
                  {t('userDetail.boards', 'Boards')}
                </button>
              )}
            </nav>
          </div>

          <div className="flex-1 rounded-lg bg-white dark:bg-zinc-800 p-6 shadow">
            {activeTab === 'profile' && (
              <div className="space-y-6">
                <h2 className="text-lg font-semibold text-zinc-800 dark:text-zinc-100">{t('userDetail.profile', 'Profile')}</h2>
                <div className="grid grid-cols-2 gap-6">
                  <div className="space-y-4">
                    <div>
                      <label className="mb-2 block text-sm font-medium text-zinc-500">{t('userDetail.avatar', 'Avatar')}</label>
                      <UserAvatar
                        username={targetUser.nickname}
                        avatar={targetUser.avatar}
                        size="lg"
                      />
                    </div>
                    <div>
                      <label className="mb-2 block text-sm font-medium text-zinc-500">{t('userDetail.nickname', 'Nickname')}</label>
                      <p className="text-zinc-800 dark:text-zinc-100">{targetUser.nickname}</p>
                    </div>
                  </div>
                  <div className="space-y-4">
                    <div>
                      <label className="mb-2 block text-sm font-medium text-zinc-500">{t('userDetail.role', 'Role')}</label>
                      <span className={`inline-flex items-center rounded-lg px-2.5 py-1 text-xs font-medium ${
                        targetUser.role === 'ADMIN'
                          ? 'bg-blue-100 text-blue-700'
                          : targetUser.role === 'MEMBER'
                          ? 'bg-emerald-100 text-emerald-700'
                          : 'bg-zinc-100 text-zinc-600'
                      }`}>
                        {targetUser.role === 'ADMIN' ? t('settings.admin') : targetUser.role === 'MEMBER' ? t('settings.member') : t('settings.viewer')}
                      </span>
                    </div>
                    <div>
                      <label className="mb-2 block text-sm font-medium text-zinc-500">{t('userDetail.type', 'Type')}</label>
                      <span className={`inline-flex items-center rounded-lg px-2.5 py-1 text-xs font-medium ${
                        targetUser.type === 'AGENT'
                          ? 'bg-violet-100 text-violet-700'
                          : 'bg-zinc-100 text-zinc-500'
                      }`}>
                        {targetUser.type === 'AGENT' ? t('settings.agent') : t('settings.human')}
                      </span>
                    </div>
                    <div>
                      <label className="mb-2 block text-sm font-medium text-zinc-500">{t('userDetail.status', 'Status')}</label>
                      <span className={`inline-flex items-center rounded-lg px-2.5 py-1 text-xs font-medium ${
                        targetUser.enabled
                          ? 'bg-emerald-100 text-emerald-700'
                          : 'bg-red-100 text-red-700'
                      }`}>
                        {targetUser.enabled ? t('userDetail.enabled', 'Enabled') : t('userDetail.disabled', 'Disabled')}
                      </span>
                    </div>
                    <div>
                      <label className="mb-2 block text-sm font-medium text-zinc-500">{t('userDetail.createdAt', 'Created At')}</label>
                      <p className="text-zinc-800 dark:text-zinc-100">
                        {new Date(targetUser.createdAt).toLocaleString()}
                      </p>
                    </div>
                    {targetUser.lastActiveAt && (
                      <div>
                        <label className="mb-2 block text-sm font-medium text-zinc-500">{t('userDetail.lastActive', 'Last Active')}</label>
                        <p className="text-zinc-800 dark:text-zinc-100">
                          {new Date(targetUser.lastActiveAt).toLocaleString()}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'activities' && currentUser?.role === 'ADMIN' && (
              <div className="space-y-6">
                <h2 className="text-lg font-semibold text-zinc-800 dark:text-zinc-100">{t('userDetail.activities', 'Activities')}</h2>
                {activities.length === 0 ? (
                  <div className="py-12 text-center rounded-xl bg-zinc-50 dark:bg-zinc-900 border border-zinc-100 dark:border-zinc-800">
                    <p className="text-zinc-500 dark:text-zinc-400">{t('settings.noActivities')}</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {activities.map((activity) => (
                      <div
                        key={activity.id}
                        className="flex items-start gap-3 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 p-4"
                      >
                        <UserAvatar
                          username={activity.userNickname || 'Unknown'}
                          avatar={activity.userAvatar}
                          size="sm"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium text-zinc-800 dark:text-zinc-100">
                              {activity.userNickname || 'Unknown'}
                            </span>
                            <span className="text-zinc-500 dark:text-zinc-400">
                              {getActionLabel(activity.action)}
                            </span>
                            {activity.targetTitle && (
                              <span className="text-zinc-600 dark:text-zinc-300 truncate">
                                {activity.targetTitle}
                              </span>
                            )}
                          </div>
                          <div className="mt-1 flex items-center gap-3 text-xs text-zinc-400">
                            <span>{formatTime(activity.createdAt)}</span>
                            {activity.source && (
                              <span className="rounded bg-zinc-100 dark:bg-zinc-700 px-1.5 py-0.5">
                                {activity.source}
                              </span>
                            )}
                          </div>
                          {activity.details && (
                            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">{activity.details}</p>
                          )}
                        </div>
                      </div>
                    ))}
                    {hasMoreActivities && (
                      <div className="flex justify-center pt-4">
                        <button
                          onClick={handleLoadMoreActivities}
                          disabled={loadingMore}
                          className="rounded-lg px-4 py-2 text-sm font-medium text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-zinc-800 disabled:opacity-50"
                        >
                          {loadingMore ? t('settings.loading') : t('userDetail.loadMore', 'Load More')}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {activeTab === 'permissions' && currentUser?.role === 'ADMIN' && (
              <div className="space-y-6">
                <h2 className="text-lg font-semibold text-zinc-800 dark:text-zinc-100">{t('userDetail.boardPermissions', 'Board Permissions')}</h2>
                {boardPermissions.length === 0 ? (
                  <div className="py-12 text-center rounded-xl bg-zinc-50 dark:bg-zinc-900 border border-zinc-100 dark:border-zinc-800">
                    <p className="text-zinc-500 dark:text-zinc-400">{t('settings.noPermission')}</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {boardPermissions.map((perm) => (
                      <div
                        key={perm.id}
                        className="flex items-center justify-between rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 p-4"
                      >
                        <div className="flex items-center gap-3">
                          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-100 text-blue-600 dark:bg-blue-900 dark:text-blue-300">
                            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><line x1="3" x2="21" y1="9" y2="9"/><line x1="9" x2="9" y1="21" y2="9"/>
                            </svg>
                          </div>
                          <div>
                            <div className="font-medium text-zinc-800 dark:text-zinc-100">{perm.boardName}</div>
                            <div className="text-xs text-zinc-500">{perm.boardId}</div>
                          </div>
                        </div>
                        <span className={`rounded-lg px-2.5 py-1 text-xs font-medium ${
                          perm.access === 'ADMIN'
                            ? 'bg-violet-100 text-violet-700 dark:bg-violet-900 dark:text-violet-300'
                            : perm.access === 'WRITE'
                            ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300'
                            : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300'
                        }`}>
                          {perm.access === 'ADMIN' ? t('settings.admin') : perm.access === 'WRITE' ? t('settings.member') : t('settings.viewer')}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                <h2 className="text-lg font-semibold text-zinc-800 dark:text-zinc-100 pt-4">{t('userDetail.columnPermissions', 'Column Permissions')}</h2>
                {columnPermissions.length === 0 ? (
                  <div className="py-12 text-center rounded-xl bg-zinc-50 dark:bg-zinc-900 border border-zinc-100 dark:border-zinc-800">
                    <p className="text-zinc-500 dark:text-zinc-400">{t('settings.noPermission')}</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {columnPermissions.map((perm) => (
                      <div
                        key={perm.id}
                        className="flex items-center justify-between rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 p-4"
                      >
                        <div className="flex items-center gap-3">
                          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-purple-100 text-purple-600 dark:bg-purple-900 dark:text-purple-300">
                            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <line x1="8" x2="21" y1="6" y2="6"/><line x1="8" x2="21" y1="12" y2="12"/><line x1="8" x2="21" y1="18" y2="18"/><line x1="3" x2="3.01" y1="6" y2="6"/><line x1="3" x2="3.01" y1="12" y2="12"/><line x1="3" x2="3.01" y1="18" y2="18"/>
                            </svg>
                          </div>
                          <div>
                            <div className="font-medium text-zinc-800 dark:text-zinc-100">{perm.columnName}</div>
                            <div className="text-xs text-zinc-500">{perm.columnId}</div>
                          </div>
                        </div>
                        <span className={`rounded-lg px-2.5 py-1 text-xs font-medium ${
                          perm.access === 'ADMIN'
                            ? 'bg-violet-100 text-violet-700 dark:bg-violet-900 dark:text-violet-300'
                            : perm.access === 'WRITE'
                            ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300'
                            : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300'
                        }`}>
                          {perm.access === 'ADMIN' ? t('settings.admin') : perm.access === 'WRITE' ? t('settings.member') : t('settings.viewer')}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {activeTab === 'boards' && currentUser?.role === 'ADMIN' && (
              <div className="space-y-6">
                <h2 className="text-lg font-semibold text-zinc-800 dark:text-zinc-100">{t('userDetail.boards', 'Accessible Boards')}</h2>
                {boardPermissions.length === 0 ? (
                  <div className="py-12 text-center rounded-xl bg-zinc-50 dark:bg-zinc-900 border border-zinc-100 dark:border-zinc-800">
                    <p className="text-zinc-500 dark:text-zinc-400">{t('userDetail.noBoards', 'No accessible boards')}</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-4">
                    {boardPermissions.map((perm) => (
                      <Link
                        key={perm.id}
                        to={`/board/${perm.boardId}`}
                        className="flex items-center gap-3 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 p-4 hover:shadow-md transition-shadow"
                      >
                        <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-blue-100 text-blue-600 dark:bg-blue-900 dark:text-blue-300">
                          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><line x1="3" x2="21" y1="9" y2="9"/><line x1="9" x2="9" y1="21" y2="9"/>
                          </svg>
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-zinc-800 dark:text-zinc-100 truncate">{perm.boardName}</div>
                          <div className="text-xs text-zinc-500">{perm.boardId}</div>
                        </div>
                        <span className={`rounded-lg px-2.5 py-1 text-xs font-medium ${
                          perm.access === 'ADMIN'
                            ? 'bg-violet-100 text-violet-700 dark:bg-violet-900 dark:text-violet-300'
                            : perm.access === 'WRITE'
                            ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300'
                            : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300'
                        }`}>
                          {perm.access}
                        </span>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}