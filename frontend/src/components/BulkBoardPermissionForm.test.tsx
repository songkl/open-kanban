import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BulkBoardPermissionForm } from './BulkBoardPermissionForm';

vi.mock('@/services/api', () => {
  class ApiErrorMock extends Error {
    status?: number;
    isNetworkError: boolean;
    isAbortError: boolean;
    data?: unknown;
    constructor(
      message: string,
      status?: number,
      isNetworkError = false,
      isAbortError = false,
      data?: unknown
    ) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.isNetworkError = isNetworkError;
      this.isAbortError = isAbortError;
      this.data = data;
    }
  }
  return {
    ApiError: ApiErrorMock,
    authApi: {
      getUsers: vi.fn(),
      bulkSetPermissions: vi.fn(),
    },
  };
});

vi.mock('@/components/ErrorToast', () => ({
  showErrorToast: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (!params) return key;
      return Object.entries(params).reduce(
        (acc, [k, v]) => acc.replace(`{${k}}`, String(v)),
        key
      );
    },
  }),
}));

import { authApi, ApiError } from '@/services/api';
import { showErrorToast } from '@/components/ErrorToast';

const mockUsers = [
  { id: 'user-1', nickname: 'Alice', type: 'AGENT', role: 'MEMBER', avatar: null, enabled: true, createdAt: '', updatedAt: '' },
  { id: 'user-2', nickname: 'Bob', type: 'HUMAN', role: 'MEMBER', avatar: null, enabled: true, createdAt: '', updatedAt: '' },
  { id: 'user-3', nickname: 'Carol', type: 'HUMAN', role: 'ADMIN', avatar: null, enabled: true, createdAt: '', updatedAt: '' },
  { id: 'user-4', nickname: 'Dave', type: 'AGENT', role: 'VIEWER', avatar: null, enabled: true, createdAt: '', updatedAt: '' },
];

const existingPermissionUserIds = ['user-2'];

const renderForm = (
  overrides: Partial<React.ComponentProps<typeof BulkBoardPermissionForm>> = {}
) => {
  const onGranted = vi.fn();
  const utils = render(
    <BulkBoardPermissionForm
      boardId="board-1"
      onGranted={onGranted}
      existingPermissionUserIds={existingPermissionUserIds}
      {...overrides}
    />
  );
  return { ...utils, onGranted };
};

const waitForUsers = async () => {
  await waitFor(() => {
    expect(screen.getByText('Alice')).toBeInTheDocument();
  });
};

describe('BulkBoardPermissionForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authApi.getUsers).mockResolvedValue([...mockUsers] as never);
    vi.mocked(authApi.bulkSetPermissions).mockResolvedValue({
      success: true,
      boardId: 'board-1',
      granted: [],
      count: 0,
    });
  });

  it('renders user list from authApi.getUsers and existing rows default unchecked', async () => {
    renderForm();

    await waitForUsers();

    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('Carol')).toBeInTheDocument();
    expect(screen.getByText('Dave')).toBeInTheDocument();

    const checkboxes = screen.getAllByRole('checkbox');
    checkboxes.forEach((cb) => {
      expect(cb).not.toBeChecked();
    });

    expect(screen.getByText('Bob').closest('label')?.textContent).toContain(
      'board.bulkAddAlreadyHasPermission'
    );
  });

  it('selectAll selects all visible users; deselectAll clears selection', async () => {
    const user = userEvent.setup();
    renderForm();

    await waitForUsers();

    await user.click(screen.getByRole('button', { name: 'board.bulkAddSelectAll' }));
    await waitFor(() => {
      screen.getAllByRole('checkbox').forEach((cb) => {
        expect(cb).toBeChecked();
      });
    });

    await user.click(screen.getByRole('button', { name: 'board.bulkAddDeselectAll' }));
    await waitFor(() => {
      screen.getAllByRole('checkbox').forEach((cb) => {
        expect(cb).not.toBeChecked();
      });
    });
  });

  it('submit button is disabled when no user selected', async () => {
    renderForm();
    await waitForUsers();

    const submit = screen.getByRole('button', { name: 'board.bulkAddSubmit' });
    expect(submit).toBeDisabled();

    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]);

    await waitFor(() => {
      expect(submit).not.toBeDisabled();
    });

    fireEvent.click(checkboxes[0]);
    await waitFor(() => {
      expect(submit).toBeDisabled();
    });
  });

  it('on submit calls authApi.bulkSetPermissions with { boardId, userIds, access }', async () => {
    const user = userEvent.setup();
    renderForm();

    await waitForUsers();

    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]);
    fireEvent.click(checkboxes[2]);

    const accessSelect = screen.getAllByRole('combobox').find(
      (el) => (el as HTMLSelectElement).options[0]?.text === 'column.permission.READ'
    ) as HTMLSelectElement;
    fireEvent.change(accessSelect, { target: { value: 'WRITE' } });

    await user.click(screen.getByRole('button', { name: 'board.bulkAddSubmit' }));

    await waitFor(() => {
      expect(authApi.bulkSetPermissions).toHaveBeenCalledTimes(1);
    });
    expect(authApi.bulkSetPermissions).toHaveBeenCalledWith(
      'board-1',
      expect.arrayContaining(['user-1', 'user-3']),
      'WRITE'
    );
    expect(authApi.bulkSetPermissions.mock.calls[0][1]).toHaveLength(2);
  });

  it('backend 200 → onGranted fires once and success toast is shown', async () => {
    vi.mocked(authApi.bulkSetPermissions).mockResolvedValue({
      success: true,
      boardId: 'board-1',
      granted: [{ userId: 'user-1', access: 'READ' }],
      count: 1,
    });

    const user = userEvent.setup();
    const { onGranted } = renderForm();

    await waitForUsers();

    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]);

    await user.click(screen.getByRole('button', { name: 'board.bulkAddSubmit' }));

    await waitFor(() => {
      expect(showErrorToast).toHaveBeenCalledWith('board.bulkAddSuccess', 'info');
    });
    expect(onGranted).toHaveBeenCalledTimes(1);
  });

  it('backend 400 unknownUserIds → partial failure message rendered, selection preserved', async () => {
    const apiErr = new ApiError('Unknown user ids', 400, false, false, {
      unknownUserIds: ['user-99'],
    });
    vi.mocked(authApi.bulkSetPermissions).mockRejectedValueOnce(apiErr);

    const user = userEvent.setup();
    const { onGranted } = renderForm();

    await waitForUsers();

    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]);

    await user.click(screen.getByRole('button', { name: 'board.bulkAddSubmit' }));

    await waitFor(() => {
      expect(screen.getByText('board.bulkAddPartialFailure')).toBeInTheDocument();
    });
    expect(onGranted).not.toHaveBeenCalled();
    expect(checkboxes[0]).toBeChecked();
  });

  it('backend 403 owner forbidden → owner forbidden message rendered, onGranted not called', async () => {
    const apiErr = new ApiError(
      "Cannot bulk-modify owner's permission row",
      403
    );
    vi.mocked(authApi.bulkSetPermissions).mockRejectedValueOnce(apiErr);

    const user = userEvent.setup();
    const { onGranted } = renderForm();

    await waitForUsers();

    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]);

    await user.click(screen.getByRole('button', { name: 'board.bulkAddSubmit' }));

    await waitFor(() => {
      expect(
        screen.getByText(/Cannot bulk-modify owner's permission row/)
      ).toBeInTheDocument();
    });
    expect(onGranted).not.toHaveBeenCalled();
  });

  it('backend 400 too many → bulkAddTooMany message rendered', async () => {
    const apiErr = new ApiError('Too many users in one request', 400);
    vi.mocked(authApi.bulkSetPermissions).mockRejectedValueOnce(apiErr);

    const user = userEvent.setup();
    const { onGranted } = renderForm();

    await waitForUsers();

    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]);

    await user.click(screen.getByRole('button', { name: 'board.bulkAddSubmit' }));

    await waitFor(() => {
      expect(screen.getByText('board.bulkAddTooMany')).toBeInTheDocument();
    });
    expect(onGranted).not.toHaveBeenCalled();
  });

  it('quick filter by role/type only filters the frontend and does not affect request payload', async () => {
    const user = userEvent.setup();
    renderForm();

    await waitForUsers();

    const selects = screen.getAllByRole('combobox');
    const roleFilter = selects.find(
      (el) =>
        (el as HTMLSelectElement).options[0]?.text === 'board.bulkAddAll' &&
        Array.from((el as HTMLSelectElement).options).some(
          (o) => o.text === 'board.role.admin'
        )
    ) as HTMLSelectElement;

    fireEvent.change(roleFilter, { target: { value: 'ADMIN' } });

    await waitFor(() => {
      expect(screen.queryByText('Alice')).not.toBeInTheDocument();
      expect(screen.queryByText('Bob')).not.toBeInTheDocument();
      expect(screen.getByText('Carol')).toBeInTheDocument();
    });

    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]);

    fireEvent.change(roleFilter, { target: { value: 'ALL' } });

    await waitForUsers();

    const accessSelect = screen.getAllByRole('combobox').find(
      (el) => (el as HTMLSelectElement).options[0]?.text === 'column.permission.READ'
    ) as HTMLSelectElement;
    fireEvent.change(accessSelect, { target: { value: 'READ' } });

    await user.click(screen.getByRole('button', { name: 'board.bulkAddSubmit' }));

    await waitFor(() => {
      expect(authApi.bulkSetPermissions).toHaveBeenCalledTimes(1);
    });
    const sentUserIds = authApi.bulkSetPermissions.mock.calls[0][1];
    expect(sentUserIds).toEqual(expect.arrayContaining(['user-3']));
    expect(sentUserIds).toHaveLength(1);
  });

  it('dark mode classes are present on the form container', async () => {
    const { container } = renderForm();
    await waitForUsers();
    const root = container.querySelector('[class*="dark:"]');
    expect(root).not.toBeNull();
  });
});