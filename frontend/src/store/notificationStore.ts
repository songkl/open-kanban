import { create } from 'zustand';
import type { Notification } from '../services/api';

/**
 * Shared store of in-app notifications (s-1194, PM_REVIEW_2026-09-17
 * §5.2 ROI #2). The bell badge and dropdown are mounted in the new
 * AppShell, which sits at the root of the authenticated route tree;
 * the actual rows are populated by `useNotifications` (which polls
 * on mount and listens for `new_notification` WebSocket messages)
 * so any descendant component can subscribe without re-fetching.
 *
 * Why a store rather than local state: the bell badge needs both
 * the unread count and the recent list at the same time, and the
 * mark-read / mark-all-read mutations need to update both views
 * optimistically without waiting for the server round-trip. The
 * store keeps that bookkeeping in one place.
 */
interface NotificationStore {
  notifications: Notification[];
  unreadCount: number;
  loaded: boolean;

  setNotifications: (rows: Notification[]) => void;
  setUnreadCount: (count: number) => void;
  /** Replace both the list and the count atomically. Used by the
   *  initial GET so the bell badge hydrates in one render. */
  hydrate: (rows: Notification[], unreadCount: number) => void;
  /** Append a single notification received via the WebSocket
   *  `new_notification` channel. Increments unreadCount when the
   *  row has no readAt. */
  push: (row: Notification) => void;
  /** Optimistically mark a single row read and decrement the badge. */
  markReadLocal: (id: string) => void;
  /** Optimistically mark every row read and zero the badge. */
  markAllReadLocal: () => void;
}

export const useNotificationStore = create<NotificationStore>()((set) => ({
  notifications: [],
  unreadCount: 0,
  loaded: false,

  setNotifications: (rows) => set({ notifications: rows }),
  setUnreadCount: (count) => set({ unreadCount: count }),

  hydrate: (rows, unreadCount) =>
    set({ notifications: rows, unreadCount, loaded: true }),

  push: (row) =>
    set((state) => {
      // Drop duplicates that can arrive when the WebSocket
      // connection flaps and the client reconnects after the
      // server has already enqueued a fan-out.
      if (state.notifications.some((n) => n.id === row.id)) {
        return state;
      }
      const isUnread = !row.readAt;
      return {
        notifications: [row, ...state.notifications],
        unreadCount: state.unreadCount + (isUnread ? 1 : 0),
      };
    }),

  markReadLocal: (id) =>
    set((state) => {
      let unreadDelta = 0;
      const next = state.notifications.map((n) => {
        if (n.id !== id || n.readAt) return n;
        unreadDelta = 1;
        return { ...n, readAt: new Date().toISOString() };
      });
      if (unreadDelta === 0) {
        return state;
      }
      return {
        notifications: next,
        unreadCount: Math.max(0, state.unreadCount - unreadDelta),
      };
    }),

  markAllReadLocal: () =>
    set((state) => {
      const stamp = new Date().toISOString();
      const next = state.notifications.map((n) =>
        n.readAt ? n : { ...n, readAt: stamp }
      );
      return {
        notifications: next,
        unreadCount: 0,
      };
    }),
}));