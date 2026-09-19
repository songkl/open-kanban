import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { notificationsApi, type Notification } from '../services/api';
import { useNotificationStore } from '../store/notificationStore';

interface NotificationCenterProps {
  open: boolean;
  onClose: () => void;
  /** Optional callback fired when the user clicks a row so the
   *  parent can close the dropdown and navigate to the target. */
  onSelect?: (notification: Notification) => void;
}

const formatRelative = (iso: string, t: (key: string, opts?: Record<string, unknown>) => string): string => {
  if (!iso) return '';
  const now = Date.now();
  const ts = new Date(iso).getTime();
  const diff = Math.max(0, now - ts);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return t('notifications.justNow');
  if (diff < hour) return t('notifications.minutesAgo', { count: Math.round(diff / minute) });
  if (diff < day) return t('notifications.hoursAgo', { count: Math.round(diff / hour) });
  return t('notifications.daysAgo', { count: Math.round(diff / day) });
};

/**
 * NotificationCenter — dropdown panel that lists the caller's
 * notifications and exposes mark-read / mark-all-read actions.
 *
 * Kept as a separate component from the bell so the bell can
 * render without forcing the panel open, and so the panel can
 * be reused (e.g. embedded in the Settings page later) without
 * the badge logic.
 *
 * Visibility is controlled by the parent (the bell icon toggles
 * `open`). We trap clicks outside the panel via a `mousedown`
 * listener so the dropdown closes when the user clicks anywhere
 * else on the page.
 */
export function NotificationCenter({ open, onClose, onSelect }: NotificationCenterProps) {
  const { t } = useTranslation();
  const notifications = useNotificationStore((s) => s.notifications);
  const unreadCount = useNotificationStore((s) => s.unreadCount);
  const markReadLocal = useNotificationStore((s) => s.markReadLocal);
  const markAllReadLocal = useNotificationStore((s) => s.markAllReadLocal);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, onClose]);

  if (!open) return null;

  const handleMarkRead = async (n: Notification) => {
    if (n.readAt) return;
    markReadLocal(n.id);
    try {
      await notificationsApi.markRead(n.id);
    } catch (error) {
      // Best-effort: the local optimistic update is fine even if
      // the server call fails — the next poll will resync.
      console.warn('Failed to mark notification read', error);
    }
  };

  const handleMarkAll = async () => {
    if (unreadCount === 0 || busy) return;
    setBusy(true);
    markAllReadLocal();
    try {
      await notificationsApi.markAllRead();
    } catch (error) {
      console.warn('Failed to mark all notifications read', error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      ref={panelRef}
      data-testid="notification-center"
      role="dialog"
      aria-label={t('notifications.title')}
      className="absolute right-0 top-full z-50 mt-2 w-[360px] max-w-[calc(100vw-2rem)] rounded-lg border border-zinc-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-800"
    >
      <header className="flex items-center justify-between border-b border-zinc-100 px-4 py-3 dark:border-zinc-700">
        <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
          {t('notifications.title')}
        </h3>
        <button
          type="button"
          onClick={handleMarkAll}
          disabled={unreadCount === 0 || busy}
          className="text-xs font-medium text-blue-600 transition-colors hover:text-blue-700 disabled:cursor-not-allowed disabled:text-zinc-400 dark:text-blue-400 dark:hover:text-blue-300 dark:disabled:text-zinc-500"
        >
          {t('notifications.markAllRead')}
        </button>
      </header>

      <ul
        className="max-h-[480px] overflow-y-auto"
        data-testid="notification-list"
      >
        {notifications.length === 0 ? (
          <li className="px-4 py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
            {t('notifications.empty')}
          </li>
        ) : (
          notifications.map((n) => (
            <li
              key={n.id}
              data-testid={`notification-row-${n.id}`}
              className={[
                'border-b border-zinc-100 px-4 py-3 transition-colors last:border-b-0 dark:border-zinc-700',
                n.readAt ? 'bg-white dark:bg-zinc-800' : 'bg-blue-50/50 dark:bg-blue-900/10',
              ].join(' ')}
            >
              <button
                type="button"
                onClick={() => {
                  void handleMarkRead(n);
                  onSelect?.(n);
                }}
                className="flex w-full flex-col items-start gap-1 text-left"
              >
                <div className="flex w-full items-start justify-between gap-2">
                  <span className="text-sm font-medium text-zinc-800 dark:text-zinc-100">
                    {n.title}
                  </span>
                  {!n.readAt && (
                    <span
                      data-testid={`notification-unread-${n.id}`}
                      className="mt-1 inline-block h-2 w-2 flex-shrink-0 rounded-full bg-blue-500"
                      aria-label={t('notifications.unread')}
                    />
                  )}
                </div>
                {n.body && (
                  <p className="text-xs text-zinc-600 dark:text-zinc-400">{n.body}</p>
                )}
                <span className="text-xs text-zinc-400 dark:text-zinc-500">
                  {formatRelative(n.createdAt, t)}
                </span>
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}