import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNotificationStore } from '../store/notificationStore';
import { NotificationCenter } from './NotificationCenter';

interface NotificationBellProps {
  onSelect?: (notification: import('../services/api').Notification) => void;
}

/**
 * NotificationBell — the top-right bell icon that hosts the unread
 * badge and toggles the {@link NotificationCenter} dropdown. The
 * bell is intentionally minimal: the badge count is the only
 * visual state because that is what the spec calls out
 * (PM_REVIEW_2026-09-17 §5.2 ROI #2).
 *
 * The actual notification data lives in `useNotificationStore`,
 * which the {@link useNotifications} hook hydrates and keeps
 * up-to-date via the WebSocket. The bell just renders that state.
 */
export function NotificationBell({ onSelect }: NotificationBellProps) {
  const { t } = useTranslation();
  const unreadCount = useNotificationStore((s) => s.unreadCount);
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        data-testid="notification-bell"
        aria-label={t('notifications.title')}
        aria-expanded={open}
        title={t('notifications.title')}
        className="relative flex h-9 w-9 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-600 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {unreadCount > 0 && (
          <span
            data-testid="notification-bell-badge"
            className="absolute -right-1 -top-1 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold leading-none text-white"
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>
      <NotificationCenter
        open={open}
        onClose={() => setOpen(false)}
        onSelect={(n) => {
          setOpen(false);
          onSelect?.(n);
        }}
      />
    </div>
  );
}