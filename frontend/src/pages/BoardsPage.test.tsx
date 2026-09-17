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
