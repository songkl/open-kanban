import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DashboardPage } from './DashboardPage';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (params && typeof params.count === 'number') {
        return `${params.count} ${key}`;
      }
      return key;
    },
    i18n: { language: 'en' },
  }),
}));

vi.mock('../hooks/useSetupGuard', () => ({ useSetupGuard: () => undefined }));

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    dashboardApi: {
      getStats: vi.fn(),
    },
    authApi: {
      me: vi.fn().mockResolvedValue({ user: { id: 'u1' }, needsSetup: false }),
    },
  },
}));

vi.mock('../services/api', () => ({
  dashboardApi: apiMock.dashboardApi,
  authApi: apiMock.authApi,
}));

const FULL_STATS = {
  totalTasks: 24,
  tasksByStatus: { todo: 8, in_progress: 6, done: 10 },
  tasksByPriority: { high: 4, medium: 12, low: 8 },
  publishedTasks: 20,
  draftTasks: 4,
  archivedTasks: 3,
  totalBoards: 5,
  activeBoardCount: 5,
  totalColumns: 12,
  totalUsers: 9,
  tasksCompletedLast7Days: 7,
  topAgentsByActivity: [
    { userId: 'a1', nickname: 'Alpha Agent', avatar: 'A', activityCount: 12 },
    { userId: 'a2', nickname: 'Beta Agent', avatar: 'B', activityCount: 9 },
    { userId: 'a3', nickname: 'Gamma Agent', avatar: 'G', activityCount: 3 },
  ],
  longestBlockedCards: [
    {
      taskId: 't1',
      title: 'Stuck refactor',
      boardId: 'b1',
      boardName: 'Backend',
      columnId: 'c1',
      columnName: 'In Progress',
      updatedAt: '2026-09-01T00:00:00Z',
      daysBlocked: 17,
      assignee: 'agent-1',
      priority: 'high',
    },
    {
      taskId: 't2',
      title: 'Pending review',
      boardId: 'b1',
      boardName: 'Backend',
      columnId: 'c2',
      columnName: 'Review',
      updatedAt: '2026-09-05T00:00:00Z',
      daysBlocked: 13,
      assignee: 'agent-2',
      priority: 'medium',
    },
  ],
};

describe('DashboardPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the four headline tiles after stats load', async () => {
    apiMock.dashboardApi.getStats.mockResolvedValueOnce(FULL_STATS);

    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(apiMock.dashboardApi.getStats).toHaveBeenCalledTimes(1);
    });

    expect(screen.getByTestId('dashboard-tile-active-boards')).toHaveTextContent('5');
    expect(screen.getByTestId('dashboard-tile-completed-7d')).toHaveTextContent('7');
  });

  it('renders top agents list', async () => {
    apiMock.dashboardApi.getStats.mockResolvedValueOnce(FULL_STATS);

    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('dashboard-agent-a1')).toBeInTheDocument();
    });
    expect(screen.getByTestId('dashboard-agent-a1')).toHaveTextContent('Alpha Agent');
    expect(screen.getByTestId('dashboard-agent-a2')).toHaveTextContent('Beta Agent');
    expect(screen.getByTestId('dashboard-agent-a3')).toHaveTextContent('Gamma Agent');
  });

  it('renders blocked cards with priority and days blocked', async () => {
    apiMock.dashboardApi.getStats.mockResolvedValueOnce(FULL_STATS);

    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('dashboard-blocked-t1')).toBeInTheDocument();
    });
    const t1 = screen.getByTestId('dashboard-blocked-t1');
    expect(t1).toHaveTextContent('Stuck refactor');
    expect(t1).toHaveTextContent('high');
    expect(screen.getByTestId('dashboard-blocked-t1')).toContainHTML('href="/board/b1/column/c1"');
  });

  it('renders empty states when stats are zero', async () => {
    apiMock.dashboardApi.getStats.mockResolvedValueOnce({
      ...FULL_STATS,
      activeBoardCount: 0,
      tasksCompletedLast7Days: 0,
      topAgentsByActivity: [],
      longestBlockedCards: [],
    });

    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('dashboard-tile-active-boards')).toHaveTextContent('0');
    });
    expect(screen.getByText('dashboard.noAgentActivity')).toBeInTheDocument();
    expect(screen.getByText('dashboard.noBlockedCards')).toBeInTheDocument();
  });

  it('renders error banner when stats fetch fails', async () => {
    apiMock.dashboardApi.getStats.mockRejectedValueOnce(new Error('boom'));

    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('dashboard-error')).toBeInTheDocument();
    });
  });
});
