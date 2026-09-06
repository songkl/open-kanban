import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AddBoardPermissionForm } from './AddBoardPermissionForm';
import { authApi } from '@/services/api';

vi.mock('@/services/api', () => ({
  authApi: {
    listVisibleUsers: vi.fn(),
    getUsers: vi.fn(),
    setPermission: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const visibleUsers = [
  { userId: 'u-1', username: 'alice', nickname: 'Alice', type: 'HUMAN' as const, role: 'MEMBER' as const },
  { userId: 'u-2', username: 'bob', nickname: 'Bob', type: 'AGENT' as const, role: 'MEMBER' as const },
];

describe('AddBoardPermissionForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authApi.listVisibleUsers).mockResolvedValue(
      visibleUsers.map((u) => ({
        id: u.userId,
        nickname: u.nickname,
        type: u.type,
        role: u.role,
        avatar: null,
        enabled: true,
        createdAt: '',
        updatedAt: '',
      }))
    );
    vi.mocked(authApi.getUsers).mockResolvedValue([]);
    vi.mocked(authApi.setPermission).mockResolvedValue({} as never);
  });

  it('prefers authApi.listVisibleUsers(boardId) so non-admin owners can populate the picker', async () => {
    render(<AddBoardPermissionForm boardId="board-42" onPermissionAdded={vi.fn()} />);

    await waitFor(() => {
      expect(authApi.listVisibleUsers).toHaveBeenCalledWith('board-42');
    });

    await waitFor(() => {
      expect(screen.getByRole('option', { name: /Alice/ })).toBeInTheDocument();
    });
    expect(screen.getByRole('option', { name: /Bob/ })).toBeInTheDocument();
    expect(authApi.getUsers).not.toHaveBeenCalled();
  });

  it('falls back to authApi.getUsers when listVisibleUsers rejects (e.g. legacy deployment)', async () => {
    vi.mocked(authApi.listVisibleUsers).mockRejectedValueOnce(new Error('boom'));
    vi.mocked(authApi.getUsers).mockResolvedValue([
      {
        id: 'admin-1',
        nickname: 'Root',
        type: 'HUMAN',
        role: 'ADMIN',
        avatar: null,
        enabled: true,
        createdAt: '',
        updatedAt: '',
      },
    ]);

    render(<AddBoardPermissionForm boardId="board-42" onPermissionAdded={vi.fn()} />);

    await waitFor(() => {
      expect(authApi.getUsers).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.getByRole('option', { name: /Root/ })).toBeInTheDocument();
    });
  });

  it('submits the chosen user to authApi.setPermission and fires onPermissionAdded', async () => {
    const onPermissionAdded = vi.fn();
    render(<AddBoardPermissionForm boardId="board-42" onPermissionAdded={onPermissionAdded} />);

    await waitFor(() => {
      expect(screen.getByRole('option', { name: /Alice/ })).toBeInTheDocument();
    });

    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'u-1' } });
    fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: 'ADMIN' } });
    fireEvent.click(screen.getByRole('button', { name: 'board.add' }));

    await waitFor(() => {
      expect(authApi.setPermission).toHaveBeenCalledWith('u-1', 'board-42', 'ADMIN');
    });
    expect(onPermissionAdded).toHaveBeenCalledTimes(1);
  });
});
