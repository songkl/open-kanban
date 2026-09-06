import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { BoardHeader } from './BoardHeader';
import type { Board } from '@/types/kanban';

vi.mock('@/hooks/useBoardPermission', () => ({
  useBoardPermission: vi.fn(),
}));

vi.mock('@/services/api', () => ({
  authApi: {
    getBoardPermissions: vi.fn().mockResolvedValue({ permissions: [] }),
    deletePermission: vi.fn(),
    getColumnPermissions: vi.fn().mockResolvedValue({ permissions: [] }),
    deleteColumnPermission: vi.fn(),
  },
  columnsApi: {
    getByBoard: vi.fn().mockResolvedValue([]),
  },
}));

import { useBoardPermission } from '@/hooks/useBoardPermission';

const mockedUseBoardPermission = vi.mocked(useBoardPermission);

const board: Board = {
  id: 'board-1',
  name: 'Sprint Board',
  description: '',
  createdAt: '2024-01-01',
  updatedAt: '2024-01-01',
};

function renderHeader(currentUser?: { id: string; role: string } | null) {
  return render(
    <MemoryRouter>
      <BoardHeader
        boards={[board]}
        currentBoard={board}
        boardIdFromUrl="board-1"
        currentUser={currentUser ?? null}
      />
    </MemoryRouter>
  );
}

describe('BoardHeader permission shield', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hides the shield while useBoardPermission is still loading', () => {
    mockedUseBoardPermission.mockReturnValue({
      effectiveAccess: '',
      isOwner: false,
      canManageBoardPermissions: false,
      loading: true,
      error: null,
    });

    const { container } = renderHeader({ id: 'u1', role: 'ADMIN' });
    expect(container.querySelector('[aria-label="board.permissions"]')).toBeNull();
    expect(container.querySelector('[title="board.permissions"]')).toBeNull();
  });

  it('shows the shield for a global ADMIN with the admin tooltip', async () => {
    mockedUseBoardPermission.mockReturnValue({
      effectiveAccess: 'ADMIN',
      isOwner: false,
      canManageBoardPermissions: true,
      loading: false,
      error: null,
    });

    renderHeader({ id: 'u1', role: 'ADMIN' });

    await waitFor(() => {
      expect(screen.getByLabelText('board.permissionsAdmin')).toBeInTheDocument();
    });
  });

  it('shows the shield for a MEMBER-as-owner with the owner tooltip', async () => {
    mockedUseBoardPermission.mockReturnValue({
      effectiveAccess: 'WRITE',
      isOwner: true,
      canManageBoardPermissions: true,
      loading: false,
      error: null,
    });

    renderHeader({ id: 'u2', role: 'MEMBER' });

    await waitFor(() => {
      expect(screen.getByLabelText('board.permissionsOwner')).toBeInTheDocument();
    });
  });

  it('hides the shield for a MEMBER who is not the owner', () => {
    mockedUseBoardPermission.mockReturnValue({
      effectiveAccess: 'READ',
      isOwner: false,
      canManageBoardPermissions: false,
      loading: false,
      error: null,
    });

    const { container } = renderHeader({ id: 'u3', role: 'MEMBER' });
    expect(container.querySelector('[aria-label^="board.permissions"]')).toBeNull();
  });

  it('hides the shield when the permission request errored', () => {
    mockedUseBoardPermission.mockReturnValue({
      effectiveAccess: '',
      isOwner: false,
      canManageBoardPermissions: false,
      loading: false,
      error: new Error('boom'),
    });

    const { container } = renderHeader({ id: 'u1', role: 'ADMIN' });
    expect(container.querySelector('[aria-label^="board.permissions"]')).toBeNull();
  });

  it('always renders the column-management link regardless of permissions', () => {
    mockedUseBoardPermission.mockReturnValue({
      effectiveAccess: 'READ',
      isOwner: false,
      canManageBoardPermissions: false,
      loading: false,
      error: null,
    });

    renderHeader({ id: 'u3', role: 'MEMBER' });
    expect(screen.getByTitle('column.manageColumns')).toBeInTheDocument();
  });

  it('hides the shield when no active board is selected', () => {
    mockedUseBoardPermission.mockReturnValue({
      effectiveAccess: '',
      isOwner: false,
      canManageBoardPermissions: false,
      loading: false,
      error: null,
    });

    render(
      <MemoryRouter>
        <BoardHeader
          boards={[]}
          currentBoard={null}
          boardIdFromUrl=""
          currentUser={{ id: 'u1', role: 'ADMIN' }}
        />
      </MemoryRouter>
    );

    expect(screen.queryByLabelText(/^board\.permissions/)).toBeNull();
  });
});

describe('BoardHeader column-permissions affordance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the column-permissions button with the admin tooltip for global ADMIN', async () => {
    mockedUseBoardPermission.mockReturnValue({
      effectiveAccess: 'ADMIN',
      isOwner: false,
      canManageBoardPermissions: true,
      canManageColumnPermissions: true,
      loading: false,
      error: null,
    });

    renderHeader({ id: 'u1', role: 'ADMIN' });

    await waitFor(() => {
      expect(screen.getByLabelText('board.columnPermissionsAdmin')).toBeInTheDocument();
    });
  });

  it('renders the column-permissions button with the owner tooltip for a MEMBER-as-owner', async () => {
    mockedUseBoardPermission.mockReturnValue({
      effectiveAccess: 'WRITE',
      isOwner: true,
      canManageBoardPermissions: true,
      canManageColumnPermissions: true,
      loading: false,
      error: null,
    });

    renderHeader({ id: 'u2', role: 'MEMBER' });

    await waitFor(() => {
      expect(screen.getByLabelText('board.columnPermissionsOwner')).toBeInTheDocument();
    });
  });

  it('hides the column-permissions button while useBoardPermission is still loading', () => {
    mockedUseBoardPermission.mockReturnValue({
      effectiveAccess: '',
      isOwner: false,
      canManageBoardPermissions: false,
      canManageColumnPermissions: false,
      loading: true,
      error: null,
    });

    const { container } = renderHeader({ id: 'u1', role: 'ADMIN' });
    expect(container.querySelector('[aria-label^="board.columnPermissions"]')).toBeNull();
  });

  it('hides the column-permissions button when canManageColumnPermissions is false', () => {
    mockedUseBoardPermission.mockReturnValue({
      effectiveAccess: 'READ',
      isOwner: false,
      canManageBoardPermissions: false,
      canManageColumnPermissions: false,
      loading: false,
      error: null,
    });

    const { container } = renderHeader({ id: 'u3', role: 'MEMBER' });
    expect(container.querySelector('[aria-label^="board.columnPermissions"]')).toBeNull();
  });

  it('hides the column-permissions button when the permission request errored', () => {
    mockedUseBoardPermission.mockReturnValue({
      effectiveAccess: '',
      isOwner: false,
      canManageBoardPermissions: false,
      canManageColumnPermissions: false,
      loading: false,
      error: new Error('boom'),
    });

    const { container } = renderHeader({ id: 'u1', role: 'ADMIN' });
    expect(container.querySelector('[aria-label^="board.columnPermissions"]')).toBeNull();
  });

  it('hides the column-permissions button when no active board is selected', () => {
    mockedUseBoardPermission.mockReturnValue({
      effectiveAccess: 'ADMIN',
      isOwner: false,
      canManageBoardPermissions: true,
      canManageColumnPermissions: true,
      loading: false,
      error: null,
    });

    render(
      <MemoryRouter>
        <BoardHeader
          boards={[]}
          currentBoard={null}
          boardIdFromUrl=""
          currentUser={{ id: 'u1', role: 'ADMIN' }}
        />
      </MemoryRouter>
    );

    expect(screen.queryByLabelText(/^board\.columnPermissions/)).toBeNull();
  });
});
