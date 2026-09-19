import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BoardPermissionsModal } from './BoardPermissionsModal';
import { authApi } from '@/services/api';
import type { Board } from '@/types/kanban';

const candidateUsers = [
  { userId: 'cand-1', username: 'dave', nickname: 'Dave', type: 'HUMAN' as const, role: 'MEMBER' as const },
  { userId: 'cand-2', username: 'erin_agent', nickname: 'Erin', type: 'AGENT' as const, role: 'MEMBER' as const },
  { userId: 'cand-3', username: 'frank', nickname: 'Frank', type: 'HUMAN' as const, role: 'VIEWER' as const },
];

vi.mock('@/services/api', () => ({
  authApi: {
    getUsers: vi.fn().mockResolvedValue([
      { id: 'user-1', nickname: 'Alice', type: 'HUMAN', role: 'MEMBER' },
      { id: 'user-2', nickname: 'Bob', type: 'AGENT', role: 'MEMBER' },
    ]),
    listVisibleUsers: vi.fn().mockImplementation((boardId?: string) => {
      const users = [
        { id: 'user-1', nickname: 'Alice', type: 'HUMAN', role: 'MEMBER', avatar: null, enabled: true, createdAt: '', updatedAt: '' },
        { id: 'user-2', nickname: 'Bob', type: 'AGENT', role: 'MEMBER', avatar: null, enabled: true, createdAt: '', updatedAt: '' },
        { id: 'user-3', nickname: 'Carol', type: 'HUMAN', role: 'MEMBER', avatar: null, enabled: true, createdAt: '', updatedAt: '' },
      ];
      return Promise.resolve(boardId ? users : users);
    }),
    getBoardPermissions: vi.fn().mockImplementation(() =>
      Promise.resolve({ permissions: [], candidates: candidateUsers })
    ),
    setPermission: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const mockBoard: Board = {
  id: 'board-1',
  name: 'Test Board',
  createdAt: '2024-01-01',
  updatedAt: '2024-01-01',
};

const mockPermissions = [
  {
    id: 'perm-1',
    boardId: 'board-1',
    boardName: 'Test Board',
    access: 'ADMIN',
    userId: 'user-1',
    userNickname: 'Alice',
  },
  {
    id: 'perm-2',
    boardId: 'board-1',
    boardName: 'Test Board',
    access: 'READ',
    userId: 'user-2',
    userNickname: 'Bob',
  },
];

describe('BoardPermissionsModal', () => {
  const defaultProps = {
    isOpen: true,
    board: mockBoard,
    permissions: mockPermissions,
    loading: false,
    onClose: vi.fn(),
    onDeletePermission: vi.fn(),
    onPermissionAdded: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing when isOpen is false', () => {
    const { container } = render(<BoardPermissionsModal {...defaultProps} isOpen={false} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when board is null', () => {
    const { container } = render(<BoardPermissionsModal {...defaultProps} board={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the modal header and board name when open', () => {
    render(<BoardPermissionsModal {...defaultProps} />);
    expect(screen.getByText('board.permissions')).toBeInTheDocument();
    expect(screen.getByText('Test Board')).toBeInTheDocument();
  });

  it('renders the list of current permissions', () => {
    render(<BoardPermissionsModal {...defaultProps} />);
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getAllByText('column.permission.ADMIN').length).toBeGreaterThan(0);
    expect(screen.getAllByText('column.permission.READ').length).toBeGreaterThan(0);
  });

  it('shows the empty state when no permissions exist', () => {
    render(<BoardPermissionsModal {...defaultProps} permissions={[]} />);
    expect(screen.getByText('board.noPermissions')).toBeInTheDocument();
  });

  it('shows the loading state when loading is true', () => {
    render(<BoardPermissionsModal {...defaultProps} loading={true} />);
    expect(screen.getByText('common.loading')).toBeInTheDocument();
  });

  it('calls onClose when backdrop is clicked', () => {
    const { container } = render(<BoardPermissionsModal {...defaultProps} />);
    const backdrop = container.firstChild as HTMLElement;
    fireEvent.click(backdrop);
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it('does not call onClose when modal content is clicked', () => {
    render(<BoardPermissionsModal {...defaultProps} />);
    fireEvent.click(screen.getByText('board.permissions'));
    expect(defaultProps.onClose).not.toHaveBeenCalled();
  });

  it('calls onClose when close button is clicked', () => {
    render(<BoardPermissionsModal {...defaultProps} />);
    fireEvent.click(screen.getByText('common.close'));
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it('calls onDeletePermission with the right id when remove is clicked', () => {
    render(<BoardPermissionsModal {...defaultProps} />);
    const removeButtons = screen.getAllByText('column.remove');
    fireEvent.click(removeButtons[0]);
    expect(defaultProps.onDeletePermission).toHaveBeenCalledWith('perm-1');
  });

  it('renders the add permission form', async () => {
    render(<BoardPermissionsModal {...defaultProps} />);
    expect(screen.getByText('board.currentPermissions')).toBeInTheDocument();
    expect(screen.getByText('board.addPermission')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('Alice')).toBeInTheDocument();
    });
  });

  describe('candidates list and search / access filters', () => {
    const candidateNames = () =>
      screen
        .queryAllByTestId('board-permission-candidate-row')
        .map((row) => row.textContent || '');

    const permissionNames = () =>
      screen.queryAllByTestId('board-permission-row').map((row) => row.textContent || '');

    it('loads candidates from getBoardPermissions(boardId)', async () => {
      render(<BoardPermissionsModal {...defaultProps} />);
      await waitFor(() => {
        expect(vi.mocked(authApi.getBoardPermissions)).toHaveBeenCalledWith('board-1');
      });
    });

    it('renders the invitable users section with the candidates returned by the API', async () => {
      render(<BoardPermissionsModal {...defaultProps} />);
      expect(screen.getByText('board.invitableUsers')).toBeInTheDocument();
      await waitFor(() => {
        expect(screen.getAllByTestId('board-permission-candidate-row')).toHaveLength(3);
      });
      const names = candidateNames();
      expect(names.some((n) => n.includes('Dave'))).toBe(true);
      expect(names.some((n) => n.includes('Erin'))).toBe(true);
      expect(names.some((n) => n.includes('Frank'))).toBe(true);
    });

    it('shows the empty state when the API returns no candidates', async () => {
      vi.mocked(authApi.getBoardPermissions).mockResolvedValueOnce({
        permissions: [],
        candidates: [],
      });
      render(<BoardPermissionsModal {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText('board.noInvitableUsers')).toBeInTheDocument();
      });
      expect(screen.queryAllByTestId('board-permission-candidate-row')).toHaveLength(0);
    });

    it('tolerates a response without a candidates array', async () => {
      vi.mocked(authApi.getBoardPermissions).mockResolvedValueOnce({ permissions: [] });
      render(<BoardPermissionsModal {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText('board.noInvitableUsers')).toBeInTheDocument();
      });
    });

    it('keeps the modal usable when the candidates request fails', async () => {
      vi.mocked(authApi.getBoardPermissions).mockRejectedValueOnce(new Error('boom'));
      render(<BoardPermissionsModal {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText('board.noInvitableUsers')).toBeInTheDocument();
      });
      expect(screen.getByText('board.permissions')).toBeInTheDocument();
      expect(screen.getAllByTestId('board-permission-row')).toHaveLength(2);
    });

    it('filters candidates by nickname through the search box', async () => {
      render(<BoardPermissionsModal {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getAllByTestId('board-permission-candidate-row')).toHaveLength(3);
      });

      fireEvent.change(screen.getByTestId('board-permission-search'), {
        target: { value: 'dav' },
      });

      const names = candidateNames();
      expect(names).toHaveLength(1);
      expect(names[0]).toContain('Dave');
    });

    it('filters candidates by username through the search box', async () => {
      render(<BoardPermissionsModal {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getAllByTestId('board-permission-candidate-row')).toHaveLength(3);
      });

      fireEvent.change(screen.getByTestId('board-permission-search'), {
        target: { value: 'erin_agent' },
      });

      const names = candidateNames();
      expect(names).toHaveLength(1);
      expect(names[0]).toContain('Erin');
    });

    it('filters granted permissions by nickname through the search box', async () => {
      render(<BoardPermissionsModal {...defaultProps} />);
      expect(screen.getAllByTestId('board-permission-row')).toHaveLength(2);

      fireEvent.change(screen.getByTestId('board-permission-search'), {
        target: { value: 'ali' },
      });

      const names = permissionNames();
      expect(names).toHaveLength(1);
      expect(names[0]).toContain('Alice');
    });

    it('filters granted permissions by username through the search box', async () => {
      const permissionsWithUsernames = [
        { ...mockPermissions[0], username: 'alice_login' },
        { ...mockPermissions[1], username: 'bob_login' },
      ];
      render(
        <BoardPermissionsModal {...defaultProps} permissions={permissionsWithUsernames} />
      );

      fireEvent.change(screen.getByTestId('board-permission-search'), {
        target: { value: 'bob_login' },
      });

      const names = permissionNames();
      expect(names).toHaveLength(1);
      expect(names[0]).toContain('Bob');
    });

    it('filters granted permissions by access level', async () => {
      render(<BoardPermissionsModal {...defaultProps} />);
      expect(screen.getAllByTestId('board-permission-row')).toHaveLength(2);

      fireEvent.change(screen.getByTestId('board-permission-access-filter'), {
        target: { value: 'READ' },
      });

      const names = permissionNames();
      expect(names).toHaveLength(1);
      expect(names[0]).toContain('Bob');

      fireEvent.change(screen.getByTestId('board-permission-access-filter'), {
        target: { value: 'ALL' },
      });
      expect(screen.getAllByTestId('board-permission-row')).toHaveLength(2);
    });

    it('hides candidates while a specific access level is selected', async () => {
      render(<BoardPermissionsModal {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getAllByTestId('board-permission-candidate-row')).toHaveLength(3);
      });

      fireEvent.change(screen.getByTestId('board-permission-access-filter'), {
        target: { value: 'ADMIN' },
      });

      expect(screen.queryAllByTestId('board-permission-candidate-row')).toHaveLength(0);
      expect(screen.getByText('board.noInvitableUsers')).toBeInTheDocument();
    });

    it('shows the no-match state when the filters exclude every granted row', async () => {
      render(<BoardPermissionsModal {...defaultProps} />);
      fireEvent.change(screen.getByTestId('board-permission-search'), {
        target: { value: 'nobody-matches-this' },
      });

      expect(screen.getByText('board.noMatchingPermissions')).toBeInTheDocument();
      expect(screen.queryAllByTestId('board-permission-row')).toHaveLength(0);
      expect(screen.queryByText('board.noPermissions')).not.toBeInTheDocument();
    });

    it('does not fetch candidates when the modal is closed', () => {
      render(<BoardPermissionsModal {...defaultProps} isOpen={false} />);
      expect(vi.mocked(authApi.getBoardPermissions)).not.toHaveBeenCalled();
    });

    it('refetches candidates when the granted permission set changes', async () => {
      const { rerender } = render(<BoardPermissionsModal {...defaultProps} />);
      await waitFor(() => {
        expect(vi.mocked(authApi.getBoardPermissions)).toHaveBeenCalledTimes(1);
      });

      rerender(
        <BoardPermissionsModal {...defaultProps} permissions={[mockPermissions[0]]} />
      );

      await waitFor(() => {
        expect(vi.mocked(authApi.getBoardPermissions)).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('non-admin board owner', () => {
    const ownerPermissions = [
      {
        id: 'perm-owner',
        boardId: 'board-1',
        boardName: 'Test Board',
        access: 'ADMIN' as const,
        userId: 'owner-1',
        userNickname: 'Owner',
        userType: 'HUMAN' as const,
        ownerAgentId: 'owner-1',
      },
      {
        id: 'perm-2',
        boardId: 'board-1',
        boardName: 'Test Board',
        access: 'READ' as const,
        userId: 'user-2',
        userNickname: 'Bob',
        userType: 'AGENT' as const,
      },
    ];

    const ownerProps = {
      ...defaultProps,
      permissions: ownerPermissions,
      currentUser: { id: 'owner-1', role: 'MEMBER' },
      canManageBoardPermissions: true,
    };

    it('renders the modal for a non-admin owner and shows the transfer button', async () => {
      render(<BoardPermissionsModal {...ownerProps} />);
      expect(screen.getByText('board.permissions')).toBeInTheDocument();
      // "Owner" appears twice: once in the current-owner banner and once in the
      // permissions list. The presence of two matches is what proves the
      // non-admin owner view is wired up.
      expect(screen.getAllByText('Owner')).toHaveLength(2);
      expect(screen.getByText('board.transferOwnership')).toBeInTheDocument();
      // Wait for the AddBoardPermissionForm's async user fetch to flush so we
      // don't leak an act() warning into the test output.
      await waitFor(() => {
        expect(vi.mocked(authApi.listVisibleUsers)).toHaveBeenCalled();
      });
    });

    it('shows the transfer button for a non-admin owner even when canManageBoardPermissions is undefined', async () => {
      // Regression guard: before the fix, canTransfer was gated on
      // canManageBoardPermissions AND owner/admin role. A stale
      // canManageBoardPermissions=undefined (e.g. the hook hasn't
      // resolved yet, or the BoardHeader didn't pass it) used to
      // hide the button even from the recorded owner.
      render(
        <BoardPermissionsModal
          {...ownerProps}
          canManageBoardPermissions={undefined}
        />
      );
      expect(screen.getByText('board.transferOwnership')).toBeInTheDocument();
      await waitFor(() => {
        expect(vi.mocked(authApi.listVisibleUsers)).toHaveBeenCalled();
      });
    });

    it('hides the transfer button for a non-owner who is not a global admin', async () => {
      const nonOwnerProps = {
        ...defaultProps,
        permissions: ownerPermissions,
        currentUser: { id: 'random-user', role: 'MEMBER' },
        canManageBoardPermissions: false,
      };
      render(<BoardPermissionsModal {...nonOwnerProps} />);
      expect(screen.queryByText('board.transferOwnership')).not.toBeInTheDocument();
    });

    it('loads the candidate picker via authApi.listVisibleUsers(boardId) for the add form', async () => {
      const listSpy = vi.mocked(authApi.listVisibleUsers);
      listSpy.mockClear();

      render(<BoardPermissionsModal {...ownerProps} />);

      await waitFor(() => {
        expect(listSpy).toHaveBeenCalledWith('board-1');
      });
    });

    it('falls back to authApi.getUsers when listVisibleUsers rejects', async () => {
      vi.mocked(authApi.listVisibleUsers).mockRejectedValueOnce(new Error('boom'));
      const getSpy = vi.mocked(authApi.getUsers);
      getSpy.mockClear();

      render(<BoardPermissionsModal {...ownerProps} />);

      await waitFor(() => {
        expect(getSpy).toHaveBeenCalled();
      });
      // Both AddBoardPermissionForm (fallback) and BulkBoardPermissionForm
      // render Alice after getUsers resolves, so multiple matches are expected.
      await waitFor(() => {
        expect(screen.getAllByText('Alice').length).toBeGreaterThan(0);
      });
    });

    it('does not call getUsers for the add form when listVisibleUsers succeeds', async () => {
      vi.mocked(authApi.listVisibleUsers).mockClear();
      const getSpy = vi.mocked(authApi.getUsers);
      getSpy.mockClear();

      render(<BoardPermissionsModal {...ownerProps} />);

      await waitFor(() => {
        expect(vi.mocked(authApi.listVisibleUsers)).toHaveBeenCalledWith('board-1');
      });
      // BulkBoardPermissionForm always calls getUsers on mount, so the
      // assertion is now "exactly one caller" — the AddBoardPermissionForm
      // did not have to fall back to getUsers.
      expect(getSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('BulkBoardPermissionForm gating by canManageBoardPermissions', () => {
    it('renders BulkBoardPermissionForm when canManageBoardPermissions is true', async () => {
      render(<BoardPermissionsModal {...defaultProps} canManageBoardPermissions={true} />);

      await waitFor(() => {
        expect(screen.getByText('board.bulkAddTitle')).toBeInTheDocument();
      });
      expect(screen.getByRole('button', { name: 'board.bulkAddSubmit' })).toBeInTheDocument();
    });

    it('hides BulkBoardPermissionForm when canManageBoardPermissions is false', () => {
      render(<BoardPermissionsModal {...defaultProps} canManageBoardPermissions={false} />);

      expect(screen.queryByText('board.bulkAddTitle')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'board.bulkAddSubmit' })).not.toBeInTheDocument();
    });

    it('hides BulkBoardPermissionForm when canManageBoardPermissions is undefined', () => {
      render(<BoardPermissionsModal {...defaultProps} />);

      expect(screen.queryByText('board.bulkAddTitle')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'board.bulkAddSubmit' })).not.toBeInTheDocument();
    });
  });

  describe('audit information (grantedBy / grantedAt / expiresAt / revokedAt)', () => {
    const pastDate = '2024-01-01T00:00:00.000Z';
    const futureDate = '2999-01-01T00:00:00.000Z';
    const grantedAt = '2024-06-15T08:30:00.000Z';
    const revokedAt = '2024-07-20T10:00:00.000Z';

    const auditPermissions = [
      {
        id: 'perm-granted',
        boardId: 'board-1',
        boardName: 'Test Board',
        access: 'WRITE' as const,
        userId: 'user-1',
        userNickname: 'Alice',
        username: 'alice_login',
        userType: 'HUMAN' as const,
        userRole: 'MEMBER' as const,
        grantedByUserId: 'admin-1',
        grantedByUsername: 'admin_user',
        grantedByNickname: 'Admin One',
        grantedAt,
        expiresAt: futureDate,
        revokedAt: null,
      },
      {
        id: 'perm-expired',
        boardId: 'board-1',
        boardName: 'Test Board',
        access: 'READ' as const,
        userId: 'user-2',
        userNickname: 'Bob',
        username: 'bob_login',
        userType: 'AGENT' as const,
        userRole: 'MEMBER' as const,
        grantedByUserId: 'admin-1',
        grantedByUsername: 'admin_user',
        grantedByNickname: 'Admin One',
        grantedAt,
        expiresAt: pastDate,
        revokedAt: null,
      },
      {
        id: 'perm-revoked',
        boardId: 'board-1',
        boardName: 'Test Board',
        access: 'ADMIN' as const,
        userId: 'user-3',
        userNickname: 'Carol',
        username: 'carol_login',
        userType: 'HUMAN' as const,
        userRole: 'MEMBER' as const,
        grantedByUserId: 'admin-1',
        grantedByUsername: 'admin_user',
        grantedByNickname: 'Admin One',
        grantedAt,
        expiresAt: null,
        revokedAt,
      },
      {
        id: 'perm-anonymous',
        boardId: 'board-1',
        boardName: 'Test Board',
        access: 'READ' as const,
        userId: 'user-4',
        userNickname: 'Dave',
        username: 'dave_login',
        userType: 'HUMAN' as const,
        userRole: 'MEMBER' as const,
        grantedByUserId: null,
        grantedByUsername: null,
        grantedByNickname: null,
        grantedAt: null,
        expiresAt: null,
        revokedAt: null,
      },
    ];

    const auditProps = {
      ...defaultProps,
      permissions: auditPermissions,
    };

    it('renders the grantor username for every row that has one', () => {
      render(<BoardPermissionsModal {...auditProps} />);

      const grantorRows = screen.getAllByTestId('board-permission-grantor');
      expect(grantorRows).toHaveLength(3);
      const usernames = screen.getAllByTestId('board-permission-grantor-username');
      expect(usernames).toHaveLength(3);
      usernames.forEach((el) => {
        expect(el.textContent).toBe('@admin_user');
        expect(el.getAttribute('data-username')).toBe('admin_user');
      });
    });

    it('renders the granted-at timestamp for each row', () => {
      render(<BoardPermissionsModal {...auditProps} />);

      const grantedAtRows = screen.getAllByTestId('board-permission-granted-at');
      expect(grantedAtRows).toHaveLength(3);
      grantedAtRows.forEach((el) => {
        expect(el.textContent).toContain('board.grantedAt');
        expect(el.textContent).not.toBe('');
      });
    });

    it('marks rows past their expires_at as expired with a red indicator', () => {
      render(<BoardPermissionsModal {...auditProps} />);

      const expiresRows = screen.getAllByTestId('board-permission-expires-at');
      expect(expiresRows).toHaveLength(2);

      const [grantedRow, expiredRow] = expiresRows;
      expect(grantedRow.getAttribute('data-expired')).toBe('false');
      expect(expiredRow.getAttribute('data-expired')).toBe('true');

      expect(grantedRow.className).not.toMatch(/text-red-600/);
      expect(expiredRow.className).toMatch(/text-red-600/);
    });

    it('renders the revoked-at timestamp for rows that have been revoked', () => {
      render(<BoardPermissionsModal {...auditProps} />);

      const revokedRows = screen.getAllByTestId('board-permission-revoked-at');
      expect(revokedRows).toHaveLength(1);
      expect(revokedRows[0].textContent).toContain('board.revokedAt');
      expect(revokedRows[0].textContent).not.toBe('');
    });

    it('hides the audit line when a row carries no audit metadata', () => {
      const onlyAnonymous = [auditPermissions[3]];
      render(<BoardPermissionsModal {...defaultProps} permissions={onlyAnonymous} />);

      expect(screen.queryByTestId('board-permission-audit')).not.toBeInTheDocument();
      expect(screen.queryByTestId('board-permission-grantor')).not.toBeInTheDocument();
      expect(screen.queryByTestId('board-permission-granted-at')).not.toBeInTheDocument();
      expect(screen.queryByTestId('board-permission-expires-at')).not.toBeInTheDocument();
      expect(screen.queryByTestId('board-permission-revoked-at')).not.toBeInTheDocument();
    });

    it('falls back to the grantor nickname when the username is missing', () => {
      const onlyNickname = [
        {
          ...auditPermissions[0],
          id: 'perm-nick',
          grantedByUsername: null,
          grantedByNickname: 'Admin One',
          expiresAt: null,
          revokedAt: null,
        },
      ];
      render(<BoardPermissionsModal {...defaultProps} permissions={onlyNickname} />);

      expect(screen.getByTestId('board-permission-grantor')).toHaveTextContent('Admin One');
      expect(screen.queryByTestId('board-permission-grantor-username')).not.toBeInTheDocument();
    });
  });
});