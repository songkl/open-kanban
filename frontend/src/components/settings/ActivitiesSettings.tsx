import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { activitiesApi } from '../../services/api';

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

interface ActivitiesSettingsProps {
  currentUser: { id: string; role: string } | null;
  userNicknameMap: Record<string, string>;
}

export function ActivitiesSettings({ currentUser, userNicknameMap }: ActivitiesSettingsProps) {
  const { t } = useTranslation();
  const [activities, setActivities] = useState<Activity[]>([]);
  const [activityFilterAction, setActivityFilterAction] = useState('');
  const [activityFilterStartTime, setActivityFilterStartTime] = useState('');
  const [activityFilterEndTime, setActivityFilterEndTime] = useState('');
  const [loading, setLoading] = useState(false);

  const loadActivities = async (filters?: { userId?: string; action?: string; startTime?: string; endTime?: string }) => {
    setLoading(true);
    try {
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
      action: activityFilterAction || undefined,
      startTime: activityFilterStartTime || undefined,
      endTime: activityFilterEndTime || undefined,
    });
  };

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-zinc-800">{t('settings.activitiesTitle')}</h2>
      <p className="text-sm text-zinc-500">{t('settings.activitiesDescription')}</p>

      {currentUser?.role === 'ADMIN' && (
        <div className="rounded-lg border border-zinc-200 p-4">
          <h3 className="mb-3 text-sm font-medium text-zinc-700">{t('settings.filterConditions')}</h3>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <div>
              <label htmlFor="activityFilterAction" className="mb-1 block text-xs text-zinc-500">{t('settings.operationType')}</label>
              <select
                id="activityFilterAction"
                name="activityFilterAction"
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
              <label htmlFor="activityFilterStartTime" className="mb-1 block text-xs text-zinc-500">{t('settings.startTime')}</label>
              <input
                id="activityFilterStartTime"
                name="activityFilterStartTime"
                type="datetime-local"
                value={activityFilterStartTime}
                onChange={(e) => setActivityFilterStartTime(e.target.value)}
                className="w-full rounded-md border border-zinc-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="activityFilterEndTime" className="mb-1 block text-xs text-zinc-500">{t('settings.endTime')}</label>
              <input
                id="activityFilterEndTime"
                name="activityFilterEndTime"
                type="datetime-local"
                value={activityFilterEndTime}
                onChange={(e) => setActivityFilterEndTime(e.target.value)}
                className="w-full rounded-md border border-zinc-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div className="flex items-end">
              <button
                onClick={handleApplyFilter}
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
          {loading ? (
            <div className="py-8 text-center text-zinc-500">{t('common.loading')}</div>
          ) : activities.length === 0 ? (
            <div className="py-8 text-center text-zinc-500">{t('settings.noActivities')}</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
