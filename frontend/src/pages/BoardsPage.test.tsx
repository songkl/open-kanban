import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { BoardsPage } from './BoardsPage';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (params && typeof params.count === 'number') {
        return `${params.count} ${key}`;
      }
      if (key === 'board.contactOwner') {
        return '请联系看板 owner 邀请你';
      }
      return key;
    },
    i18n: { language: 'en' },
  }),
}));

vi.mock('../hooks/useSetupGuard', () => ({ useSetupGuard: () => undefined }));

vi.mock('../components/ImportModal', () => ({
  ImportModal: () => null,
  ImportConflictConfirm: () => null,
}));

vi.mock('../components/CreateBoardModal', () => ({
  CreateBoardModal: () => null,
}));

vi.mock('../components/TemplateList', () => ({
  TemplateList: () => null,
}));

vi.mock('../components/TemplateNameModal', () => ({
  TemplateNameModal: () => null,
}));

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    boardsApi: {
      getAll: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      copy: vi.fn(),
      export: vi.fn(),
      import: vi.fn(),
      createFromTemplate: vi.fn(),
    },
    templatesApi: {
      getAll: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    presetTemplatesApi: {
      getAll: vi.fn(),
    },
    onboardingApi: {
      quickstart: vi.fn(),
    },
    authApi: {
      me: vi.fn(),
    },
  },
}));

vi.mock('../services/api', () => apiMock);

import { boardsApi, templatesApi, presetTemplatesApi, authApi } from '../services/api';

const mockedBoardsGetAll = vi.mocked(boardsApi.getAll);
const mockedTemplatesGetAll = vi.mocked(templatesApi.getAll);
const mockedPresetTemplatesGetAll = vi.mocked(presetTemplatesApi.getAll);
const mockedAuthMe = vi.mocked(authApi.me);

const LocationDisplay = () => {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}{location.search}</div>;
};

const renderBoardsPage = () =>
  render(
    <MemoryRouter initialEntries={['/boards']}>
      <BoardsPage />
      <LocationDisplay />
    </MemoryRouter>,
  );

const makeUser = (role: 'ADMIN' | 'MEMBER' | 'VIEWER') => ({
  id: `${role.toLowerCase()}-1`,
  nickname: role,
  avatar: null,
  role,
  type: 'HUMAN' as const,
  enabled: true,
  createdAt: '2024-01-01',
  updatedAt: '2024-01-01',
});

const renderLoadErrorPage = async (role: 'ADMIN' | 'MEMBER' | 'VIEWER') => {
  mockedBoardsGetAll.mockRejectedValue(new Error('Failed to load boards'));
  mockedAuthMe.mockResolvedValue({ user: makeUser(role), needsSetup: false });

  renderBoardsPage();

  await waitFor(() => {
    expect(screen.getByText('app.error.loadFailed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'board.contactAdmin' })).toBeInTheDocument();
  });
};

describe('BoardsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedTemplatesGetAll.mockResolvedValue([]);
    mockedBoardsGetAll.mockResolvedValue([]);
    mockedPresetTemplatesGetAll.mockResolvedValue([]);
    mockedAuthMe.mockResolvedValue({ user: null, needsSetup: false });
  });

  it('shows noBoardsYet and create button for ADMIN when no boards exist', async () => {
    mockedBoardsGetAll.mockResolvedValue([]);
    mockedAuthMe.mockResolvedValue({
      user: {
        id: 'admin-1',
        nickname: 'Admin',
        avatar: null,
        role: 'ADMIN',
        type: 'HUMAN',
        enabled: true,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      },
      needsSetup: false,
    });

    renderBoardsPage();

    await waitFor(() => {
      expect(screen.getByText('board.noBoardsYet')).toBeInTheDocument();
    });

    const createButtons = screen.getAllByRole('button', { name: /modal.newBoard/ });
    expect(createButtons.length).toBeGreaterThan(0);
  });

  it('shows noAccessibleBoards and hides create button for VIEWER when no boards exist', async () => {
    mockedBoardsGetAll.mockResolvedValue([]);
    mockedAuthMe.mockResolvedValue({
      user: {
        id: 'viewer-1',
        nickname: 'Viewer',
        avatar: null,
        role: 'VIEWER',
        type: 'HUMAN',
        enabled: true,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      },
      needsSetup: false,
    });

    renderBoardsPage();

    await waitFor(() => {
      expect(screen.getByText('board.noAccessibleBoards')).toBeInTheDocument();
    });

    expect(screen.queryByText('board.noBoardsYet')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /modal.newBoard/ })).not.toBeInTheDocument();
  });

  it.each(['MEMBER', 'VIEWER'] as const)('returns %s users to boards with an owner invitation toast', async (role) => {
    await renderLoadErrorPage(role);

    fireEvent.click(screen.getByRole('button', { name: 'board.contactAdmin' }));

    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/boards');
    });
    expect(screen.getByText('请联系看板 owner 邀请你')).toBeInTheDocument();
  });

  it('sends ADMIN users to the user settings tab', async () => {
    await renderLoadErrorPage('ADMIN');

    fireEvent.click(screen.getByRole('button', { name: 'board.contactAdmin' }));

    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/settings?tab=users');
    });
    expect(screen.queryByText('请联系看板 owner 邀请你')).not.toBeInTheDocument();
  });

  it('filters out boards with empty effectiveAccess', async () => {
    mockedBoardsGetAll.mockResolvedValue([
      {
        id: 'board-1',
        name: 'Accessible Board',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        effectiveAccess: 'WRITE',
        isOwner: false,
      },
      {
        id: 'board-2',
        name: 'No Access Board',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        effectiveAccess: '',
        isOwner: false,
      },
    ]);
    mockedAuthMe.mockResolvedValue({
      user: {
        id: 'member-1',
        nickname: 'Member',
        avatar: null,
        role: 'MEMBER',
        type: 'HUMAN',
        enabled: true,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      },
      needsSetup: false,
    });

    renderBoardsPage();

    await waitFor(() => {
      expect(screen.getByText('Accessible Board')).toBeInTheDocument();
    });

    expect(screen.queryByText('No Access Board')).not.toBeInTheDocument();
  });

  it('renders owner crown when isOwner is true', async () => {
    mockedBoardsGetAll.mockResolvedValue([
      {
        id: 'board-owned',
        name: 'My Owned Board',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        effectiveAccess: 'ADMIN',
        isOwner: true,
      },
    ]);
    mockedAuthMe.mockResolvedValue({
      user: {
        id: 'member-1',
        nickname: 'Member',
        avatar: null,
        role: 'MEMBER',
        type: 'HUMAN',
        enabled: true,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      },
      needsSetup: false,
    });

    renderBoardsPage();

    await waitFor(() => {
      expect(screen.getByText('My Owned Board')).toBeInTheDocument();
    });

    expect(screen.getByTestId('board-owner-crown')).toBeInTheDocument();
  });

  it('shows the import-from-template CTA on empty boards when presets exist', async () => {
    mockedPresetTemplatesGetAll.mockResolvedValue([
      { id: 'a', slug: 'alpha-template', name: 'Alpha', description: '', category: '', columnsConfig: '[]', sampleTasks: '[]', sampleAgent: '', position: 0 },
      { id: 'b', slug: 'beta-template', name: 'Beta', description: '', category: '', columnsConfig: '[]', sampleTasks: '[]', sampleAgent: '', position: 1 },
    ]);
    mockedAuthMe.mockResolvedValue({
      user: { id: 'admin-1', nickname: 'Admin', avatar: null, role: 'ADMIN', type: 'HUMAN', enabled: true, createdAt: '', updatedAt: '' },
      needsSetup: false,
    });

    renderBoardsPage();

    await waitFor(() => {
      expect(screen.getByText('board.noBoardsYet')).toBeInTheDocument();
    });
    // The empty state surfaces the new CTA.
    expect(screen.getByRole('button', { name: /board.importFromTemplate/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /board.browseMarketplace/ })).toBeInTheDocument();
  });

  it('hides the import-from-template CTA when no presets are available', async () => {
    mockedPresetTemplatesGetAll.mockResolvedValue([]);
    mockedAuthMe.mockResolvedValue({
      user: { id: 'admin-1', nickname: 'Admin', avatar: null, role: 'ADMIN', type: 'HUMAN', enabled: true, createdAt: '', updatedAt: '' },
      needsSetup: false,
    });

    renderBoardsPage();

    await waitFor(() => {
      expect(screen.getByText('board.noBoardsYet')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /board.importFromTemplate/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /board.browseMarketplace/ })).not.toBeInTheDocument();
  });

  it('navigates to /onboarding when the empty-state CTA is clicked', async () => {
    mockedPresetTemplatesGetAll.mockResolvedValue([
      { id: 'a', slug: 'alpha-template', name: 'Alpha', description: '', category: '', columnsConfig: '[]', sampleTasks: '[]', sampleAgent: '', position: 0 },
    ]);
    mockedAuthMe.mockResolvedValue({
      user: { id: 'admin-1', nickname: 'Admin', avatar: null, role: 'ADMIN', type: 'HUMAN', enabled: true, createdAt: '', updatedAt: '' },
      needsSetup: false,
    });

    renderBoardsPage();

    await waitFor(() => {
      expect(screen.getByText('board.noBoardsYet')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /board.importFromTemplate/ }));
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/onboarding');
    });
  });
});

describe('BoardsPage search and sort', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedTemplatesGetAll.mockResolvedValue([]);
    mockedPresetTemplatesGetAll.mockResolvedValue([]);
    mockedAuthMe.mockResolvedValue({
      user: { id: 'admin-1', nickname: 'Admin', avatar: null, role: 'ADMIN', type: 'HUMAN', enabled: true, createdAt: '', updatedAt: '' },
      needsSetup: false,
    });
  });

  const makeBoard = (overrides: Partial<{
    id: string;
    name: string;
    description: string;
    isPublic: boolean;
    ownerNickname: string;
    isOwner: boolean;
    taskCount: number;
    lastActiveAt: string;
    createdAt: string;
    updatedAt: string;
    effectiveAccess: string;
  }> = {}) => ({
    id: 'board',
    name: 'Board',
    description: '',
    isPublic: true,
    ownerNickname: '',
    isOwner: false,
    taskCount: 0,
    lastActiveAt: '2024-01-01T00:00:00Z',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    effectiveAccess: 'ADMIN',
    ...overrides,
  });

  const visibleBoardNames = () =>
    screen
      .getAllByTestId('board-card-meta')
      .map((node) => {
        const card = node.closest('[data-testid]')?.parentElement;
        const title = card?.querySelector('h3');
        return title?.textContent ?? '';
      })
      .filter(Boolean);

  it('filters boards by name, description, id, and owner nickname via the search input', async () => {
    mockedBoardsGetAll.mockResolvedValue([
      makeBoard({ id: 'alpha', name: 'Alpha Roadmap', description: 'Q1 planning' }),
      makeBoard({ id: 'beta', name: 'Beta Backlog', description: 'engineering' }),
      makeBoard({ id: 'gamma', name: 'Gamma Notes', description: 'designed by GammaBot', ownerNickname: 'carol' }),
      makeBoard({ id: 'delta', name: 'Delta', description: '' }),
    ]);

    renderBoardsPage();

    await waitFor(() => {
      expect(screen.getAllByTestId('board-card-meta')).toHaveLength(4);
    });

    const input = screen.getByTestId('boards-search-input') as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'beta' } });
    await waitFor(() => {
      expect(screen.getAllByTestId('board-card-meta')).toHaveLength(1);
    });
    expect(screen.getByText('Beta Backlog')).toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'alpha' } });
    await waitFor(() => {
      expect(screen.getAllByTestId('board-card-meta')).toHaveLength(1);
    });
    expect(screen.getByText('Alpha Roadmap')).toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'gammabot' } });
    await waitFor(() => {
      expect(screen.getAllByTestId('board-card-meta')).toHaveLength(1);
    });
    expect(screen.getByText('Gamma Notes')).toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'delta' } });
    await waitFor(() => {
      expect(screen.getAllByTestId('board-card-meta')).toHaveLength(1);
    });
    expect(screen.getByText('Delta')).toBeInTheDocument();
  });

  it('shows the no-results empty state when the search yields no match and clears on click', async () => {
    mockedBoardsGetAll.mockResolvedValue([makeBoard({ id: 'alpha', name: 'Alpha' })]);

    renderBoardsPage();
    await waitFor(() => {
      expect(screen.getAllByTestId('board-card-meta')).toHaveLength(1);
    });

    fireEvent.change(screen.getByTestId('boards-search-input'), { target: { value: 'nothing' } });

    await waitFor(() => {
      expect(screen.getByTestId('boards-empty-filter')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('board-card-meta')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('boards-search-clear'));

    await waitFor(() => {
      expect(screen.queryByTestId('boards-empty-filter')).not.toBeInTheDocument();
    });
    expect(screen.getAllByTestId('board-card-meta')).toHaveLength(1);
  });

  it('sorts by lastActive descending (default) and ascending when toggled', async () => {
    mockedBoardsGetAll.mockResolvedValue([
      makeBoard({ id: 'a', name: 'A', lastActiveAt: '2024-05-10T00:00:00Z' }),
      makeBoard({ id: 'b', name: 'B', lastActiveAt: '2024-06-15T00:00:00Z' }),
      makeBoard({ id: 'c', name: 'C', lastActiveAt: '2024-04-01T00:00:00Z' }),
    ]);

    renderBoardsPage();
    await waitFor(() => {
      expect(screen.getAllByTestId('board-card-meta')).toHaveLength(3);
    });

    expect(visibleBoardNames()).toEqual(['B', 'A', 'C']);

    fireEvent.click(screen.getByTestId('boards-sort-order'));
    expect(visibleBoardNames()).toEqual(['C', 'A', 'B']);
  });

  it('sorts by createdAt when the sort key changes', async () => {
    mockedBoardsGetAll.mockResolvedValue([
      makeBoard({ id: 'a', name: 'A', createdAt: '2024-03-01T00:00:00Z', lastActiveAt: '2024-08-01T00:00:00Z' }),
      makeBoard({ id: 'b', name: 'B', createdAt: '2024-06-01T00:00:00Z', lastActiveAt: '2024-04-01T00:00:00Z' }),
      makeBoard({ id: 'c', name: 'C', createdAt: '2024-01-01T00:00:00Z', lastActiveAt: '2024-09-01T00:00:00Z' }),
    ]);

    renderBoardsPage();
    await waitFor(() => {
      expect(screen.getAllByTestId('board-card-meta')).toHaveLength(3);
    });

    fireEvent.change(screen.getByTestId('boards-sort-select'), { target: { value: 'createdAt' } });

    expect(visibleBoardNames()).toEqual(['B', 'A', 'C']);
  });

  it('sorts by taskCount descending', async () => {
    mockedBoardsGetAll.mockResolvedValue([
      makeBoard({ id: 'a', name: 'A', taskCount: 1 }),
      makeBoard({ id: 'b', name: 'B', taskCount: 25 }),
      makeBoard({ id: 'c', name: 'C', taskCount: 5 }),
    ]);

    renderBoardsPage();
    await waitFor(() => {
      expect(screen.getAllByTestId('board-card-meta')).toHaveLength(3);
    });

    fireEvent.change(screen.getByTestId('boards-sort-select'), { target: { value: 'taskCount' } });
    expect(visibleBoardNames()).toEqual(['B', 'C', 'A']);
  });

  it('sorts by owner nickname (boards without owner go last)', async () => {
    mockedBoardsGetAll.mockResolvedValue([
      makeBoard({ id: 'a', name: 'A', ownerNickname: 'carol' }),
      makeBoard({ id: 'b', name: 'B', ownerNickname: 'alice', isOwner: true }),
      makeBoard({ id: 'c', name: 'C', ownerNickname: '' }),
    ]);

    renderBoardsPage();
    await waitFor(() => {
      expect(screen.getAllByTestId('board-card-meta')).toHaveLength(3);
    });

    fireEvent.change(screen.getByTestId('boards-sort-select'), { target: { value: 'owner' } });
    fireEvent.click(screen.getByTestId('boards-sort-order'));
    expect(visibleBoardNames()).toEqual(['B', 'A', 'C']);
  });

  it('sorts by name alphabetically', async () => {
    mockedBoardsGetAll.mockResolvedValue([
      makeBoard({ id: 'a', name: 'Charlie' }),
      makeBoard({ id: 'b', name: 'Alpha' }),
      makeBoard({ id: 'c', name: 'Bravo' }),
    ]);

    renderBoardsPage();
    await waitFor(() => {
      expect(screen.getAllByTestId('board-card-meta')).toHaveLength(3);
    });

    fireEvent.change(screen.getByTestId('boards-sort-select'), { target: { value: 'name' } });
    fireEvent.click(screen.getByTestId('boards-sort-order'));
    expect(visibleBoardNames()).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('renders last active, task count, and owner nickname on each card', async () => {
    mockedBoardsGetAll.mockResolvedValue([
      makeBoard({
        id: 'a',
        name: 'Alpha',
        taskCount: 12,
        lastActiveAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        ownerNickname: 'alice',
      }),
    ]);

    renderBoardsPage();

    await waitFor(() => {
      expect(screen.getByTestId('board-task-count')).toHaveTextContent('12 board.taskCount');
    });
    expect(screen.getByTestId('board-last-active')).toHaveTextContent('taskModal.minutesAgo');
    expect(screen.getByTestId('board-owner-nickname')).toHaveTextContent('alice');
  });

  it('handles 20+ boards: search responds in well under 200ms', async () => {
    const bigList = Array.from({ length: 25 }, (_, i) =>
      makeBoard({
        id: `board-${i.toString().padStart(2, '0')}`,
        name: i % 2 === 0 ? `Engineering Sprint ${i}` : `Marketing Plan ${i}`,
        description: `description for ${i}`,
        ownerNickname: i % 3 === 0 ? 'carol' : 'bob',
        taskCount: i * 3,
        lastActiveAt: new Date(2024, 5, 1 + i).toISOString(),
        createdAt: new Date(2024, 0, 1 + i).toISOString(),
      }),
    );
    mockedBoardsGetAll.mockResolvedValue(bigList);

    renderBoardsPage();
    await waitFor(() => {
      expect(screen.getAllByTestId('board-card-meta')).toHaveLength(25);
    });

    const input = screen.getByTestId('boards-search-input') as HTMLInputElement;
    const start = performance.now();
    fireEvent.change(input, { target: { value: 'engineering' } });
    await waitFor(() => {
      expect(screen.getAllByTestId('board-card-meta')).toHaveLength(13);
    });
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(200);
  });
});
