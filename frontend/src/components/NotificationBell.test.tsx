import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { NotificationBell } from './NotificationBell';
import { useNotificationStore } from '../store/notificationStore';
import type { Notification } from '../services/api';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: Record<string, unknown>) => {
        if (opts && typeof opts.count === 'number') {
          return `${key}(${opts.count})`;
        }
        return key;
      },
      i18n: { language: 'en', changeLanguage: () => undefined },
    }),
  };
});

const seedNotification: Notification = {
  id: 'n1',
  userId: 'u1',
  source: 'TASK_ASSIGNED',
  title: 'You were assigned a task',
  body: 'Fix the bug',
  targetType: 'TASK',
  targetId: 'task-1',
  createdAt: new Date().toISOString(),
};

describe('NotificationBell', () => {
  beforeEach(() => {
    useNotificationStore.setState({
      notifications: [],
      unreadCount: 0,
      loaded: true,
    });
  });

  it('renders the bell icon without a badge when there are no unread notifications', () => {
    render(
      <MemoryRouter>
        <NotificationBell />
      </MemoryRouter>
    );
    expect(screen.getByTestId('notification-bell')).toBeInTheDocument();
    expect(screen.queryByTestId('notification-bell-badge')).toBeNull();
  });

  it('shows a badge with the unread count', () => {
    useNotificationStore.setState({ unreadCount: 3 });
    render(
      <MemoryRouter>
        <NotificationBell />
      </MemoryRouter>
    );
    expect(screen.getByTestId('notification-bell-badge')).toHaveTextContent('3');
  });

  it('opens the notification center when clicked', () => {
    useNotificationStore.setState({
      notifications: [seedNotification],
      unreadCount: 1,
    });
    render(
      <MemoryRouter>
        <NotificationBell />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByTestId('notification-bell'));
    expect(screen.getByTestId('notification-center')).toBeInTheDocument();
    expect(screen.getByTestId(`notification-row-${seedNotification.id}`)).toBeInTheDocument();
  });

  it('shows an empty state when there are no notifications', () => {
    render(
      <MemoryRouter>
        <NotificationBell />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByTestId('notification-bell'));
    expect(screen.getByText('notifications.empty')).toBeInTheDocument();
  });

  it('marks a single notification read when its row is clicked', () => {
    useNotificationStore.setState({
      notifications: [seedNotification],
      unreadCount: 1,
    });
    render(
      <MemoryRouter>
        <NotificationBell />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByTestId('notification-bell'));
    fireEvent.click(screen.getByTestId(`notification-row-${seedNotification.id}`).querySelector('button')!);
    const after = useNotificationStore.getState();
    expect(after.unreadCount).toBe(0);
    expect(after.notifications[0].readAt).toBeTruthy();
  });

  it('marks every notification read via the header action', () => {
    useNotificationStore.setState({
      notifications: [
        seedNotification,
        { ...seedNotification, id: 'n2', readAt: undefined },
      ],
      unreadCount: 2,
    });
    render(
      <MemoryRouter>
        <NotificationBell />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByTestId('notification-bell'));
    fireEvent.click(screen.getByText('notifications.markAllRead'));
    const after = useNotificationStore.getState();
    expect(after.unreadCount).toBe(0);
    expect(after.notifications.every((n) => Boolean(n.readAt))).toBe(true);
  });
});