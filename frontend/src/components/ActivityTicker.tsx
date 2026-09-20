import { useState, useEffect, useRef, useCallback, startTransition } from 'react';
import { useTranslation } from 'react-i18next';
import { activitiesApi } from '@/services/api';
import { resolveActivityActionLabel } from '@/utils/activityActions';
import { localizeActivityDetails } from '@/utils/activityDetails';

interface Activity {
  id: string;
  userId: string;
  action: string;
  targetType: string;
  targetId?: string;
  targetTitle?: string;
  details?: string;
  createdAt: string;
}

const actionIcons: Record<string, string> = {
  CREATE_TASK: '📝',
  COMPLETE_TASK: '✅',
  ADD_COMMENT: '💬',
  UPDATE_TASK: '✏️',
  DELETE_TASK: '🗑️',
  BOARD_CREATE: '📋',
  BOARD_UPDATE: '📋',
  COLUMN_CREATE: '📑',
  COLUMN_UPDATE: '📑',
  USER_CREATE: '👤',
  LOGIN: '🔑',
};

export function ActivityTicker() {
  const { t, i18n } = useTranslation();
  const [activities, setActivities] = useState<Activity[]>([]);
  const [isPaused, setIsPaused] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const fetchActivities = useCallback(async () => {
    try {
      const data = await activitiesApi.getAll({ pageSize: 20 });
      startTransition(() => {
        setActivities(data.activities || []);
      });
    } catch (err) {
      console.error('Failed to fetch activities:', err);
    }
  }, []);

  useEffect(() => {
    fetchActivities();
    const interval = setInterval(() => fetchActivities(), 30000);
    return () => clearInterval(interval);
  }, [fetchActivities]);

  const formatTime = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return t('taskModal.justNow');
    if (diffMins < 60) return t('taskModal.minutesAgo', { count: diffMins });
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  if (activities.length === 0) return null;

  return (
    <div
      className="fixed bottom-0 left-0 right-0 z-40 bg-gradient-to-r from-zinc-900 to-zinc-800 text-white shadow-lg"
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
    >
      <div className="relative overflow-hidden">
        <div
          ref={containerRef}
          className={`flex gap-8 py-2 ${isPaused ? '' : 'animate-marquee'}`}
          style={{
            animation: isPaused ? 'none' : 'marquee 60s linear infinite',
            width: 'max-content',
          }}
        >
          {[...activities, ...activities].map((activity, idx) => {
            // s-1262, PM review s-1261 P2-3: pipe `details` through
            // localizeActivityDetails so the marquee renders the
            // same localised sentence as the /activities page
            // ("Status: In progress → Review" instead of "Status:
            // 'in_progress' → 'review'"). The helper falls back to
            // the raw value for unknown shapes so older rows still
            // render.
            const localized = localizeActivityDetails(activity.details, t);
            return (
              <div
                key={`${activity.id}-${idx}`}
                className="flex items-center gap-2 whitespace-nowrap text-sm"
              >
                <span className="text-base">{actionIcons[activity.action] || '📌'}</span>
                <span className="text-zinc-300">
                  {resolveActivityActionLabel(activity.action, t, i18n)}
                </span>
                {activity.targetTitle && (
                  <span className="max-w-32 truncate text-blue-300">{activity.targetTitle}</span>
                )}
                {localized && (
                  <span className="text-zinc-400 dark:text-zinc-500">· {localized}</span>
                )}
                <span className="text-zinc-500 dark:text-zinc-500">{formatTime(activity.createdAt)}</span>
              </div>
            );
          })}
        </div>
      </div>
      <style>{`
        @keyframes marquee {
          0% { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
      `}</style>
    </div>
  );
}