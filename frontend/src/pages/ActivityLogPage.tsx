import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { authApi, tasksApi, commentsApi, activitiesApi } from '../services/api';
import { LoadingScreen } from '../components/LoadingScreen';
import { UserAvatar } from '../components/UserAvatar';
import { TaskModal } from '../components/TaskModal';
import type { User, Task } from '../types/kanban';

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

interface UserMap {
  [userId: string]: string;
}

const actionIcons: Record<string, string> = {
  CREATE_TASK: '📝',
  COMPLETE_TASK: '✅',
  ADD_COMMENT: '💬',
  UPDATE_TASK: '✏️',
  DELETE_TASK: '🗑️',
  BOARD_CREATE: '📋',
  BOARD_UPDATE: '📋',
  BOARD_DELETE: '📋',
  COLUMN_CREATE: '📑',
  COLUMN_UPDATE: '📑',
  COLUMN_DELETE: '📑',
  USER_CREATE: '👤',
  USER_UPDATE: '👤',
  LOGIN: '🔑',
  LOGOUT: '🔒',
};

const clickableActions = ['CREATE_TASK', 'ADD_COMMENT'];

export function ActivityLogPage() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [users, setUsers] = useState<UserMap>({});
  const [filterAction, setFilterAction] = useState('');
  const [filterStartTime, setFilterStartTime] = useState('');
  const [filterEndTime, setFilterEndTime] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [showTaskModal, setShowTaskModal] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const meData = await authApi.me();
      if (!meData.user) {
        setError('Not logged in');
        return;
      }
      setCurrentUser(meData.user);

      if (meData.user.role === 'ADMIN') {
        const usersData = await authApi.getUsers();
        const userMap: UserMap = {};
        (usersData || []).forEach((u: User) => {
          userMap[u.id] = u.nickname;
        });
        setUsers(userMap);
      }

      await loadActivities();
    } catch (err) {
      console.error('Failed to load data:', err);
      setError(t('app.error.loadFailed'));
    } finally {
      setLoading(false);
    }
  };

  const loadActivities = async (filters?: { action?: string; startTime?: string; endTime?: string }) => {
    try {
      setLoading(true);
      const data = await activitiesApi.getAll({
        action: filters?.action,
        startTime: filters?.startTime,
        endTime: filters?.endTime,
      });
      setActivities(data.activities || []);
    } catch (err) {
      console.error('Failed to load activities:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleApplyFilter = () => {
    loadActivities({
      action: filterAction || undefined,
      startTime: filterStartTime || undefined,
      endTime: filterEndTime || undefined,
    });
  };

  const handleClearFilter = () => {
    setFilterAction('');
    setFilterStartTime('');
    setFilterEndTime('');
    loadActivities();
  };

  const formatTime = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return t('taskModal.justNow');
    if (diffMins < 60) return t('taskModal.minutesAgo', { count: diffMins });
    if (diffHours < 24) return t('taskModal.hoursAgo', { count: diffHours });
    if (diffDays < 7) return t('taskModal.daysAgo', { count: diffDays });
    return date.toLocaleString();
  };

  const handleActivityClick = async (activity: Activity) => {
    if (!clickableActions.includes(activity.action) || !activity.targetId) return;

    try {
      let taskId: string | null = null;

      if (activity.action === 'CREATE_TASK') {
        taskId = activity.targetId;
      } else if (activity.action === 'ADD_COMMENT') {
        const comment = await commentsApi.getById(activity.targetId);
        taskId = comment.taskId;
      }

      if (taskId) {
        const task = await tasksApi.getById(taskId);
        setSelectedTask(task);
        setShowTaskModal(true);
      }
    } catch (err) {
      console.error('Failed to load task:', err);
    }
  };

  const handleCloseTaskModal = () => {
    setShowTaskModal(false);
    setSelectedTask(null);
  };

  if (loading && !currentUser) {
    return <LoadingScreen />;
  }

  if (error) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4">
        <div className="text-red-500">{t('app.error.loadFailed')}</div>
        <Link to="/" className="rounded-md bg-blue-500 px-4 py-2 text-sm text-white hover:bg-blue-600">
          {t('nav.back')}
        </Link>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-100 p-6">
      <div className="mx-auto max-w-4xl">
        <header className="mb-6">
          <Link
            to="/"
            className="mb-4 inline-block rounded-md bg-zinc-200 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-300"
          >
            ← {t('nav.back')}
          </Link>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <h1 className="text-2xl font-bold text-zinc-800">{t('nav.activityLog')}</h1>
              {currentUser && (
                <div className="flex items-center gap-2">
                  <UserAvatar username={currentUser.nickname} avatar={currentUser.avatar} size="sm" />
                  <span className="text-sm text-zinc-600">{currentUser.nickname}</span>
                </div>
              )}
            </div>
            <span className="text-sm text-zinc-500">{activities.length} {t('nav.records')}</span>
          </div>
        </header>

        <div className="mb-6 rounded-lg bg-white p-4 shadow">
          <h3 className="mb-3 text-sm font-medium text-zinc-700">{t('settings.filterConditions')}</h3>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
            <div>
              <label className="mb-1 block text-xs text-zinc-500">{t('settings.operationType')}</label>
              <select
                value={filterAction}
                onChange={(e) => setFilterAction(e.target.value)}
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
                value={filterStartTime}
                onChange={(e) => setFilterStartTime(e.target.value)}
                className="w-full rounded-md border border-zinc-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-zinc-500">{t('settings.endTime')}</label>
              <input
                type="datetime-local"
                value={filterEndTime}
                onChange={(e) => setFilterEndTime(e.target.value)}
                className="w-full rounded-md border border-zinc-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div className="flex items-end gap-2">
              <button
                onClick={handleApplyFilter}
                className="flex-1 rounded-md bg-blue-500 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-600"
              >
                {t('settings.applyFilter')}
              </button>
              <button
                onClick={handleClearFilter}
                className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-50"
              >
                {t('filter.clear')}
              </button>
            </div>
          </div>
        </div>

        {loading ? (
          <div className="flex h-64 items-center justify-center">
            <div className="text-zinc-500">{t('settings.loading')}</div>
          </div>
        ) : activities.length === 0 ? (
          <div className="rounded-lg bg-white p-8 text-center text-zinc-500 shadow">
            {t('settings.noActivities')}
          </div>
        ) : (
          <div className="space-y-3">
            {activities.map((activity) => {
              const isClickable = clickableActions.includes(activity.action) && activity.targetId;
              return (
                <div
                  key={activity.id}
                  className={`flex items-start gap-4 rounded-lg bg-white p-4 shadow ${isClickable ? 'cursor-pointer hover:bg-zinc-50' : ''}`}
                  onClick={() => handleActivityClick(activity)}
                >
                  <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-blue-100">
                    <span className="text-lg">{actionIcons[activity.action] || '📌'}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`font-medium ${isClickable ? 'text-blue-600' : 'text-zinc-800'}`}>
                        {typeof t(`settings.activities.${activity.action}`) === 'string' ? t(`settings.activities.${activity.action}`) : activity.action}
                      </span>
                      {activity.targetTitle && (
                        <span className="text-sm text-zinc-600 truncate">- {activity.targetTitle}</span>
                      )}
                      {activity.details && (
                        <span className="text-sm text-blue-600">{activity.details}</span>
                      )}
                      {isClickable && (
                        <span className="text-xs text-blue-500">{t('settings.clickToView')}</span>
                      )}
                    </div>
                    <div className="mt-1 flex items-center gap-3 text-xs text-zinc-400">
                      <span>{formatTime(activity.createdAt)}</span>
                      <span>|</span>
                      <span>{t('settings.operator')}: {users[activity.userId] || activity.userId}</span>
                      {currentUser?.role === 'ADMIN' && (
                        <>
                          {activity.ipAddress && (
                            <>
                              <span>|</span>
                              <span>IP: {activity.ipAddress}</span>
                            </>
                          )}
                          {activity.source && (
                            <>
                              <span>|</span>
                              <span>{t('settings.source')}: {activity.source === 'mcp' ? t('settings.agentActivity.sourceMcp') : t('settings.agentActivity.sourceWeb')}</span>
                            </>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {showTaskModal && selectedTask && (
          <TaskModal
            task={selectedTask}
            canEdit={false}
            onClose={handleCloseTaskModal}
            onUpdate={() => {}}
            onDelete={() => {}}
            onArchive={() => {}}
            onAddComment={() => {}}
          />
        )}
      </div>
    </div>
  );
}