import { describe, it, expect, beforeEach } from 'vitest';
import { useNotificationStore } from './notificationStore';
import type { Notification } from '../services/api';

const baseNotification: Notification = {
  id: 'n1',
  userId: 'u1',
  source: 'TASK_ASSIGNED',
  title: 'title',
  body: 'body',
  targetType: 'TASK',
  targetId: 'task-1',
  createdAt: new Date().toISOString(),
};

describe('notificationStore', () => {
  beforeEach(() => {
    useNotificationStore.setState({
      notifications: [],
      unreadCount: 0,
      loaded: false,
    });
  });

  it('hydrates the list and count atomically', () => {
    const rows = [baseNotification, { ...baseNotification, id: 'n2', readAt: 'now' }];
    useNotificationStore.getState().hydrate(rows, 1);
    const state = useNotificationStore.getState();
    expect(state.notifications).toEqual(rows);
    expect(state.unreadCount).toBe(1);
    expect(state.loaded).toBe(true);
  });

  it('push appends and bumps unreadCount for unread rows', () => {
    useNotificationStore.getState().hydrate([], 0);
    useNotificationStore.getState().push(baseNotification);
    const state = useNotificationStore.getState();
    expect(state.notifications).toHaveLength(1);
    expect(state.unreadCount).toBe(1);
  });

  it('push dedupes rows that arrive twice on a flaky WS', () => {
    useNotificationStore.getState().hydrate([], 0);
    useNotificationStore.getState().push(baseNotification);
    useNotificationStore.getState().push(baseNotification);
    const state = useNotificationStore.getState();
    expect(state.notifications).toHaveLength(1);
    expect(state.unreadCount).toBe(1);
  });

  it('push keeps unreadCount stable when the row already has readAt', () => {
    useNotificationStore.getState().hydrate([], 5);
    useNotificationStore.getState().push({ ...baseNotification, readAt: 'now' });
    expect(useNotificationStore.getState().unreadCount).toBe(5);
  });

  it('markReadLocal stamps readAt and decrements the badge', () => {
    useNotificationStore.getState().hydrate([baseNotification], 1);
    useNotificationStore.getState().markReadLocal('n1');
    const state = useNotificationStore.getState();
    expect(state.unreadCount).toBe(0);
    expect(state.notifications[0].readAt).toBeTruthy();
  });

  it('markReadLocal is a no-op when called twice', () => {
    useNotificationStore.getState().hydrate([baseNotification], 1);
    useNotificationStore.getState().markReadLocal('n1');
    const first = useNotificationStore.getState();
    useNotificationStore.getState().markReadLocal('n1');
    const second = useNotificationStore.getState();
    expect(second.unreadCount).toBe(first.unreadCount);
  });

  it('markAllReadLocal zeros the badge and stamps every row', () => {
    useNotificationStore.getState().hydrate([
      baseNotification,
      { ...baseNotification, id: 'n2' },
    ], 2);
    useNotificationStore.getState().markAllReadLocal();
    const state = useNotificationStore.getState();
    expect(state.unreadCount).toBe(0);
    expect(state.notifications.every((n) => Boolean(n.readAt))).toBe(true);
  });
});