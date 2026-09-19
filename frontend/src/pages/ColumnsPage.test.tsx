import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ColumnsPage } from './ColumnsPage';

vi.mock('@/hooks/useBoardPermission', () => ({
  useBoardPermission: vi.fn(),
}));

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    boardsApi: {
      getAll: vi.fn(),
      export: vi.fn(),
    },
    columnsApi: {
      getByBoard: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      reorder: vi.fn(),
    },
    authApi: {
      me: vi.fn(),
      getPermissions: vi.fn(),
      getAgents: vi.fn(),
      getColumnPermissions: vi.fn(),
      setColumnPermission: vi.fn(),
      deleteColumnPermission: vi.fn(),
      getUsers: vi.fn(),
    },
  },
}));

vi.mock('@/services/api', () => apiMock);

import { useBoardPermission } from '@/hooks/useBoardPermission';
import { boardsApi, columnsApi, authApi } from '@/services/api';

const mockedUseBoardPermission = vi.mocked(useBoardPermission);
const mockedBoardsGetAll = vi.mocked(boardsApi.getAll);
const mockedColumnsGetByBoard = vi.mocked(columnsApi.getByBoard);
const mockedAuthMe = vi.mocked(authApi.me);
const mockedAuthGetPermissions = vi.mocked(authApi.getPermissions);
const mockedAuthGetAgents = vi.mocked(authApi.getAgents);
const mockedGetColumnPermissions = vi.mocked(authApi.getColumnPermissions);
const mockedSetColumnPermission = vi.mocked(authApi.setColumnPermission);
const mockedDeleteColumnPermission = vi.mocked(authApi.deleteColumnPermission);
const mockedGetUsers = vi.mocked(authApi.getUsers);

const board = {
  id: 'board-1',
  name: 'Sprint Board',
  isPublic: false,
};

const columns = [
  {
    id: 'col-1',
    boardId: 'board-1',
    name: 'Todo',
    color: '#6b7280',
    position: 0,
    status: '',
    description: '',
    ownerAgentId: null,
    tasks: [],
  },
  {
    id: 'col-2',
    boardId: 'board-1',
    name: 'Doing',
    color: '#3b82f6',
    position: 1,
    status: '',
    description: '',
    ownerAgentId: null,
    tasks: [],
  },
];

const ownerUser = {
  id: 'owner-1',
  nickname: 'Owner',
  role: 'MEMBER',
  type: 'HUMAN',
};

const memberUser = {
  id: 'member-1',
  nickname: 'Member',
  role: 'MEMBER',
  type: 'HUMAN',
};

function renderColumnsPage(initialEntries: string[] = ['/columns?boardId=board-1']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <ColumnsPage />
    </MemoryRouter>
  );
}

function setupOwnerPermissionState() {
  mockedUseBoardPermission.mockReturnValue({
    effectiveAccess: 'ADMIN',
    isOwner: true,
    canManageBoardPermissions: true,
    canManageColumnPermissions: true,
    loading: false,
    error: null,
  });
}

function setupMemberPermissionState() {
  mockedUseBoardPermission.mockReturnValue({
    effectiveAccess: 'READ',
    isOwner: false,
    canManageBoardPermissions: false,
    canManageColumnPermissions: false,
    loading: false,
    error: null,
  });
}

describe('ColumnsPage owner column-permission flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedBoardsGetAll.mockResolvedValue([board]);
    mockedColumnsGetByBoard.mockResolvedValue(columns);
    mockedAuthGetAgents.mockResolvedValue([]);
    mockedGetUsers.mockResolvedValue([
      { id: 'user-2', nickname: 'Bob', type: 'HUMAN', role: 'MEMBER', enabled: true },
    ]);
    mockedAuthMe.mockResolvedValue({ user: ownerUser, needsSetup: false });
    // Owner is recorded in board_permissions with access='ADMIN'.
    mockedAuthGetPermissions.mockResolvedValue({
      permissions: [
        {
          id: 'bp-owner',
          userId: ownerUser.id,
          boardId: board.id,
          boardName: board.name,
          access: 'ADMIN',
          ownerAgentId: ownerUser.id,
          grantedByUserId: null,
          expiresAt: null,
          revokedAt: null,
        },
      ],
    });
    mockedGetColumnPermissions.mockResolvedValue({ permissions: [] });
    mockedSetColumnPermission.mockResolvedValue({
      permission: {
        id: 'cp-1',
        columnId: 'col-1',
        columnName: 'Todo',
        access: 'READ',
        userId: 'user-2',
        userNickname: 'Bob',
      },
    });
    mockedDeleteColumnPermission.mockResolvedValue(undefined);
  });

  it('renders columns with the permission button visible to a board owner', async () => {
    setupOwnerPermissionState();

    renderColumnsPage();

    await waitFor(() => {
      expect(screen.getByText('Todo')).toBeInTheDocument();
    });

    const permissionButtons = screen.getAllByText('column.permissions');
    expect(permissionButtons.length).toBe(columns.length);
  });

  it('hides the permission button for a non-owner MEMBER viewer', async () => {
    mockedAuthMe.mockResolvedValue({ user: memberUser, needsSetup: false });
    mockedAuthGetPermissions.mockResolvedValue({
      permissions: [
        {
          id: 'bp-member',
          userId: memberUser.id,
          boardId: board.id,
          boardName: board.name,
          access: 'READ',
          ownerAgentId: null,
          grantedByUserId: null,
          expiresAt: null,
          revokedAt: null,
        },
      ],
    });
    setupMemberPermissionState();

    renderColumnsPage();

    await waitFor(() => {
      expect(screen.getByText('Todo')).toBeInTheDocument();
    });

    expect(screen.queryByText('column.permissions')).not.toBeInTheDocument();
  });

  it('opens the column-permission modal for an owner and lists column permissions', async () => {
    mockedGetColumnPermissions.mockResolvedValue({
      permissions: [
        {
          id: 'cp-1',
          columnId: 'col-1',
          columnName: 'Todo',
          access: 'READ',
          userId: 'user-2',
          userNickname: 'Bob',
        },
      ],
    });
    setupOwnerPermissionState();

    renderColumnsPage();

    await waitFor(() => {
      expect(screen.getByText('Todo')).toBeInTheDocument();
    });

    const [firstPermissionButton] = screen.getAllByText('column.permissions');
    fireEvent.click(firstPermissionButton);

    await waitFor(() => {
      expect(mockedGetColumnPermissions).toHaveBeenCalledWith(undefined, 'col-1');
    });

    await waitFor(() => {
      expect(screen.getByText('column.columnPermissions')).toBeInTheDocument();
    });

    // Bob appears in two places: the add-permission form's user
    // <select> option and the permission-list row. Scope to the
    // permission list via data-testid so we don't accidentally
    // match the form option or the access <select>.
    const permissionList = await screen.findByTestId('column-permissions-list');
    const permissionRow = within(permissionList).getByTestId('column-permission-row');
    expect(within(permissionRow).getByText('Bob')).toBeInTheDocument();
  });

  it('calls authApi.deleteColumnPermission when an owner removes a column permission', async () => {
    mockedGetColumnPermissions.mockResolvedValue({
      permissions: [
        {
          id: 'cp-1',
          columnId: 'col-1',
          columnName: 'Todo',
          access: 'READ',
          userId: 'user-2',
          userNickname: 'Bob',
        },
      ],
    });
    setupOwnerPermissionState();

    renderColumnsPage();

    await waitFor(() => {
      expect(screen.getByText('Todo')).toBeInTheDocument();
    });

    const [firstPermissionButton] = screen.getAllByText('column.permissions');
    fireEvent.click(firstPermissionButton);

    await waitFor(() => {
      expect(screen.getByText('column.columnPermissions')).toBeInTheDocument();
    });

    const removeButtons = screen.getAllByText('column.remove');
    fireEvent.click(removeButtons[0]);

    await waitFor(() => {
      expect(mockedDeleteColumnPermission).toHaveBeenCalledWith('cp-1');
    });
  });

  it('re-fetches column permissions after a delete so the owner sees the fresh list', async () => {
    let callCount = 0;
    mockedGetColumnPermissions.mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          permissions: [
            {
              id: 'cp-1',
              columnId: 'col-1',
              columnName: 'Todo',
              access: 'READ',
              userId: 'user-2',
              userNickname: 'Bob',
            },
          ],
        };
      }
      return { permissions: [] };
    });
    setupOwnerPermissionState();

    renderColumnsPage();

    await waitFor(() => {
      expect(screen.getByText('Todo')).toBeInTheDocument();
    });

    const [firstPermissionButton] = screen.getAllByText('column.permissions');
    fireEvent.click(firstPermissionButton);

    await waitFor(() => {
      expect(screen.getByText('column.columnPermissions')).toBeInTheDocument();
    });

    const removeButtons = screen.getAllByText('column.remove');
    fireEvent.click(removeButtons[0]);

    await waitFor(() => {
      expect(mockedDeleteColumnPermission).toHaveBeenCalledWith('cp-1');
    });

    await waitFor(() => {
      expect(callCount).toBeGreaterThanOrEqual(2);
    });
    expect(screen.getByText('column.noPermissions')).toBeInTheDocument();
  });

  it('renders the add-permission form inside the modal so owners can set new grants', async () => {
    setupOwnerPermissionState();

    renderColumnsPage();

    await waitFor(() => {
      expect(screen.getByText('Todo')).toBeInTheDocument();
    });

    const [firstPermissionButton] = screen.getAllByText('column.permissions');
    fireEvent.click(firstPermissionButton);

    await waitFor(() => {
      expect(screen.getByText('column.columnPermissions')).toBeInTheDocument();
    });

    // Walk up from the modal title until we find a container that has
    // both the permission list and the add-permission form. The modal
    // is the deepest <div> containing both.
    const modal = screen.getByText('column.columnPermissions').closest('.fixed') as HTMLElement;
    expect(modal).not.toBeNull();
    expect(within(modal).getByText('column.addPermission')).toBeInTheDocument();
    expect(within(modal).getByText('column.selectUser')).toBeInTheDocument();
  });
});
