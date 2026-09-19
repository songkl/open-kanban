import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ColumnPermissionsModal } from './ColumnPermissionsModal';
import type { Column, ColumnPermission } from '@/types/kanban';

vi.mock('@/components/AddColumnPermissionForm', () => ({
  AddColumnPermissionForm: () => <div data-testid="add-column-permission-form" />,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const mockColumn: Column = {
  id: 'col-1',
  name: 'Todo',
  color: '#6b7280',
  position: 0,
  status: null,
  description: '',
  ownerAgentId: null,
  tasks: [],
  createdAt: '2024-01-01',
  updatedAt: '2024-01-01',
};

const basePermissions: ColumnPermission[] = [
  {
    id: 'cp-1',
    userId: 'user-1',
    userNickname: 'Alice',
    username: 'alice_login',
    userType: 'HUMAN',
    userRole: 'MEMBER',
    columnId: 'col-1',
    columnName: 'Todo',
    access: 'READ',
    grantedByUserId: 'admin-1',
    grantedByUsername: 'admin_user',
    grantedByNickname: 'Admin One',
    grantedAt: '2024-06-15T08:30:00.000Z',
    expiresAt: null,
    revokedAt: null,
  },
];

describe('ColumnPermissionsModal', () => {
  const defaultProps = {
    isOpen: true,
    column: mockColumn,
    permissions: basePermissions,
    loading: false,
    onClose: vi.fn(),
    onDeletePermission: vi.fn(),
    onPermissionAdded: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing when isOpen is false', () => {
    const { container } = render(
      <ColumnPermissionsModal {...defaultProps} isOpen={false} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when column is null', () => {
    const { container } = render(<ColumnPermissionsModal {...defaultProps} column={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the modal header and column name when open', () => {
    render(<ColumnPermissionsModal {...defaultProps} />);
    expect(screen.getByText('column.columnPermissions')).toBeInTheDocument();
    expect(screen.getByText('Todo')).toBeInTheDocument();
  });

  it('renders the list of current permissions with data-testid for test scoping', () => {
    render(<ColumnPermissionsModal {...defaultProps} />);
    const list = screen.getByTestId('column-permissions-list');
    expect(list).toBeInTheDocument();
    expect(screen.getByTestId('column-permission-row')).toBeInTheDocument();
  });

  it('renders the user nickname in the permission row', () => {
    render(<ColumnPermissionsModal {...defaultProps} />);
    expect(screen.getByText('Alice')).toBeInTheDocument();
  });

  it('renders the access label via the i18n key', () => {
    render(<ColumnPermissionsModal {...defaultProps} />);
    expect(screen.getByText('column.permission.READ')).toBeInTheDocument();
  });

  it('renders the audit line when grantedByUsername is set', () => {
    render(<ColumnPermissionsModal {...defaultProps} />);
    expect(screen.getByTestId('column-permission-audit')).toBeInTheDocument();
  });

  it('hides the audit line when no audit metadata is present', () => {
    const noAudit: ColumnPermission[] = [
      {
        ...basePermissions[0],
        grantedByUserId: null,
        grantedByUsername: null,
        grantedByNickname: null,
        grantedAt: null,
        expiresAt: null,
      },
    ];
    render(<ColumnPermissionsModal {...defaultProps} permissions={noAudit} />);
    expect(screen.queryByTestId('column-permission-audit')).not.toBeInTheDocument();
  });

  it('shows the empty state when no permissions exist', () => {
    render(<ColumnPermissionsModal {...defaultProps} permissions={[]} />);
    expect(screen.getByText('column.noPermissions')).toBeInTheDocument();
  });

  it('shows the loading state when loading is true', () => {
    render(<ColumnPermissionsModal {...defaultProps} loading={true} />);
    expect(screen.getByText('common.loading')).toBeInTheDocument();
  });

  it('calls onDeletePermission with the row id when remove is clicked', () => {
    render(<ColumnPermissionsModal {...defaultProps} />);
    screen.getByText('column.remove').click();
    expect(defaultProps.onDeletePermission).toHaveBeenCalledWith('cp-1');
  });

  it('renders the add permission form inside the modal', () => {
    render(<ColumnPermissionsModal {...defaultProps} />);
    expect(screen.getByTestId('add-column-permission-form')).toBeInTheDocument();
  });

  it('tolerates the legacy nickname field on rows that have not been migrated', () => {
    // Older callers may pass rows that only carry userNickname
    // (the pre-s-1054 shape). The helper falls back to that key
    // when nickname is absent, so the row still renders.
    const legacy: ColumnPermission[] = [
      {
        id: 'cp-legacy',
        userId: 'user-99',
        userNickname: 'Legacy User',
        userType: 'HUMAN',
        columnId: 'col-1',
        columnName: 'Todo',
        access: 'WRITE',
        grantedByUserId: null,
        grantedByUsername: null,
        grantedByNickname: null,
        grantedAt: null,
        expiresAt: null,
      } as ColumnPermission,
    ];
    render(<ColumnPermissionsModal {...defaultProps} permissions={legacy} />);
    expect(screen.getByText('Legacy User')).toBeInTheDocument();
  });
});
