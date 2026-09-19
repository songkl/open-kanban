import { useEffect, useRef } from 'react';
import { notificationsApi } from '../services/api';
import type { Notification } from '../types/kanban';
import { useNotificationStore } from '../store/notificationStore';

interface UseNotificationsOptions {
  /**
   * Optional factory for the WebSocket the hook should subscribe
   * to. When omitted the hook opens its own socket using the same
   * URL the board page uses, so a page that doesn't already own a
   * WebSocket (e.g. BoardsPage, SettingsPage) still gets real-time
   * notification pushes.
   *
   * Returning `null` from the factory disables the WebSocket path
   * for that render — useful in tests so the WS path doesn't try
   * to hit the dev server.
   */
  wsFactory?: () => WebSocket | null;
  /** How often to re-fetch the notification list while the page is
   *  in the foreground. Defaults to 30s. */
  pollIntervalMs?: number;
  /** Disable polling entirely (the WS path still works). */
  disablePoll?: boolean;
}

/**
 * useNotifications — drives the notification bell-badge hydration
 * (PM_REVIEW_2026-09-17 §5.2 ROI #2).
 *
 * Responsibilities:
 *   1. On mount, fetch the latest list + unreadCount from
 *      `notificationsApi.list` and seed the store.
 *   2. While the page is mounted, re-fetch on a slow interval so a
 *      WS flap or a freshly inserted row on another tab surfaces.
 *   3. Listen to the supplied WebSocket and dispatch
 *      `new_notification` envelopes into the store via `push`.
 *
 * WebSocket ownership is intentionally not assumed: pages that
 * already own a WS (BoardPage) can pass it in via the factory,
 * pages that don't (BoardsPage, SettingsPage) get their own. The
 * hook never duplicates — calling it more than once with the same
 * factory still opens one socket because the factory is invoked
 * only inside the effect.
 */
export function useNotifications(options: UseNotificationsOptions = {}) {
  const { wsFactory, pollIntervalMs = 30_000, disablePoll = false } = options;
  const hydrate = useNotificationStore((s) => s.hydrate);
  const push = useNotificationStore((s) => s.push);
  const loaded = useNotificationStore((s) => s.loaded);

  // Memoize the WS creation so multiple renders don't open multiple
  // sockets. The ref survives across renders; the effect below
  // closes it on unmount.
  const wsRef = useRef<WebSocket | null>(null);
  const ownedWsRef = useRef<boolean>(false);

  useEffect(() => {
    if (wsFactory) {
      wsRef.current = wsFactory();
      ownedWsRef.current = false;
    } else {
      const getWsUrl = () => {
        if (import.meta.env.VITE_WS_URL) return import.meta.env.VITE_WS_URL;
        if (import.meta.env.DEV) return 'ws://localhost:8081/ws';
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${protocol}//${window.location.host}/ws`;
      };
      try {
        wsRef.current = new WebSocket(getWsUrl());
        ownedWsRef.current = true;
      } catch (error) {
        console.warn('useNotifications: failed to open WebSocket', error);
        wsRef.current = null;
      }
    }

    return () => {
      if (ownedWsRef.current && wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
      wsRef.current = null;
      ownedWsRef.current = false;
    };
  }, [wsFactory]);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      try {
        const { notifications, unreadCount } = await notificationsApi.list({ limit: 50 });
        if (cancelled) return;
        hydrate(notifications || [], unreadCount || 0);
      } catch (error) {
        console.warn('Failed to refresh notifications', error);
      }
    };

    if (!loaded) {
      void refresh();
    }

    if (disablePoll) {
      return () => {
        cancelled = true;
      };
    }

    const interval = setInterval(refresh, pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [hydrate, loaded, pollIntervalMs, disablePoll]);

  useEffect(() => {
    const ws = wsRef.current;
    if (!ws) return;

    const handler = (event: MessageEvent) => {
      try {
        const message = JSON.parse(event.data);
        if (message?.type !== 'new_notification') return;
        const row = message.notification as Notification | undefined;
        if (!row || !row.id || !row.userId) return;
        push(row);
      } catch (error) {
        console.warn('Failed to parse notification message', error);
      }
    };
    ws.addEventListener('message', handler);
    return () => {
      ws.removeEventListener('message', handler);
    };
  }, [push]);
}