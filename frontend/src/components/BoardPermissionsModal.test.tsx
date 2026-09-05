import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BoardPermissionsModal } from './BoardPermissionsModal';
import type { Board } from '@/types/kanban';

vi.mock('@/services/api', () => ({
  authApi: {
    getUsers: vi.fn().mockResolvedValue([
      { id: 'user-1', nickname: 'Alice', type: 'HUMAN', role: 'MEMBER' },
      { id: 'user-2', nickname: 'Bob', type: 'AGENT', role: 'MEMBER' },
    ]),
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
});