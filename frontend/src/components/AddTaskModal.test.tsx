import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddTaskModal } from './AddTaskModal';

vi.mock('@/services/api', () => ({
  columnsApi: {
    getByBoard: vi.fn().mockResolvedValue([
      { id: 'col-1', name: 'To Do' },
      { id: 'col-2', name: 'In Progress' },
    ]),
  },
  attachmentsApi: {
    upload: vi.fn((file: File) => {
      const promise = Promise.resolve({
        id: `att-${file.name}`,
        filename: file.name,
        url: `/uploads/att-${file.name}`,
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
        taskId: undefined,
        commentId: undefined,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      return { promise, abort: vi.fn() };
    }),
  },
  authApi: {
    listVisibleUsers: vi.fn().mockResolvedValue([
      { id: 'u-alice', nickname: 'Alice' },
      { id: 'u-bob', nickname: 'Bob' },
    ]),
    getAgents: vi.fn().mockResolvedValue([
      { id: 'ag-claude', nickname: 'claude', avatar: null, role: 'MEMBER', type: 'AGENT', enabled: true, createdAt: '', updatedAt: '', tokenCount: 0, runsLast24h: 0, failsLast24h: 0, totalRuns: 0 },
    ]),
  },
}));

describe('AddTaskModal', () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    onSubmit: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders when isOpen is true', () => {
    render(<AddTaskModal {...defaultProps} />);
    expect(screen.getByPlaceholderText('task.titlePlaceholder')).toBeInTheDocument();
  });

  it('does not render when isOpen is false', () => {
    render(<AddTaskModal {...defaultProps} isOpen={false} />);
    expect(screen.queryByPlaceholderText('task.titlePlaceholder')).not.toBeInTheDocument();
  });

  it('calls onClose when Escape key is pressed', async () => {
    render(<AddTaskModal {...defaultProps} />);
    const input = screen.getByPlaceholderText('task.titlePlaceholder');
    input.focus();
    await userEvent.keyboard('{Escape}');
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it('calls onSubmit with correct data when form is submitted', async () => {
    render(<AddTaskModal {...defaultProps} />);
    const input = screen.getByPlaceholderText('task.titlePlaceholder');
    await userEvent.type(input, 'New Task Title');
    const submitButton = screen.getByRole('button', { name: 'task.add' });
    await userEvent.click(submitButton);
    expect(defaultProps.onSubmit).toHaveBeenCalledWith(
      'New Task Title',
      '',
      true,
      expect.any(String),
      expect.any(String),
      'medium',
      expect.objectContaining({
        dueAt: null,
        assignee: null,
        attachmentIds: expect.any(Array),
      }),
    );
  });

  it('does not submit when title is empty', async () => {
    render(<AddTaskModal {...defaultProps} />);
    const submitButton = screen.getByRole('button', { name: 'task.add' });
    expect(submitButton).toBeDisabled();
  });

  it('clears form after successful submission', async () => {
    render(<AddTaskModal {...defaultProps} />);
    const input = screen.getByPlaceholderText('task.titlePlaceholder');
    await userEvent.type(input, 'New Task');
    const submitButton = screen.getByRole('button', { name: 'task.add' });
    await userEvent.click(submitButton);
    expect(input).toHaveValue('');
  });

  it('renders priority dropdown and calls onSubmit with correct priority when changed', async () => {
    render(<AddTaskModal {...defaultProps} />);
    const priorityButton = screen.getByRole('button', { name: 'taskModal.priorityMedium' });
    expect(priorityButton).toBeInTheDocument();
    await userEvent.click(priorityButton);
    expect(screen.getByRole('option', { name: 'taskModal.priorityLow' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'taskModal.priorityMedium' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'taskModal.priorityHigh' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('option', { name: 'taskModal.priorityHigh' }));
    const input = screen.getByPlaceholderText('task.titlePlaceholder');
    await userEvent.type(input, 'New Task Title');
    const submitButton = screen.getByRole('button', { name: 'task.add' });
    await userEvent.click(submitButton);
    expect(defaultProps.onSubmit).toHaveBeenCalledWith(
      'New Task Title',
      '',
      true,
      expect.any(String),
      expect.any(String),
      'high',
      expect.objectContaining({
        dueAt: null,
        assignee: null,
        attachmentIds: expect.any(Array),
      }),
    );
  });

  it('renders publish checkbox', () => {
    render(<AddTaskModal {...defaultProps} />);
    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).toBeInTheDocument();
    expect(checkbox).toBeChecked();
  });

  it('calls onClose when cancel button is clicked', async () => {
    render(<AddTaskModal {...defaultProps} />);
    const cancelButton = screen.getByRole('button', { name: 'task.cancel' });
    await userEvent.click(cancelButton);
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it('keeps focus in description textarea while typing', async () => {
    render(<AddTaskModal {...defaultProps} />);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const textarea = document.querySelector('textarea');
    expect(textarea).not.toBeNull();
    textarea!.focus();
    await userEvent.click(textarea!);
    await userEvent.type(textarea!, 'hello');

    expect(document.activeElement).toBe(textarea);
  });

  describe('due date, assignee, and attachments (T-1207 / s-1207)', () => {
    it('persists a due date when the operator picks one', async () => {
      render(<AddTaskModal {...defaultProps} />);
      const titleInput = screen.getByPlaceholderText('task.titlePlaceholder');
      await userEvent.type(titleInput, 'Deadline task');
      const dueInput = document.getElementById('add-task-due-at') as HTMLInputElement;
      expect(dueInput).toBeInTheDocument();
      await userEvent.type(dueInput, '2026-12-31T08:00');
      const submitButton = screen.getByRole('button', { name: 'task.add' });
      await userEvent.click(submitButton);
      expect(defaultProps.onSubmit).toHaveBeenCalledTimes(1);
      const payload = defaultProps.onSubmit.mock.calls[0];
      expect(payload[6]).toMatchObject({
        assignee: null,
        attachmentIds: [],
      });
      expect(payload[6].dueAt).toBeTruthy();
      expect(typeof payload[6].dueAt).toBe('string');
      expect(payload[6].dueAt.startsWith('2026-12-31')).toBe(true);
    });

    it('clears the due date via the Clear button', async () => {
      render(<AddTaskModal {...defaultProps} />);
      const dueInput = document.getElementById('add-task-due-at') as HTMLInputElement;
      await userEvent.type(dueInput, '1226-12-31T08:00');
      const clearButton = screen.getByRole('button', { name: 'taskModal.dueDateClear' });
      await userEvent.click(clearButton);
      expect(dueInput.value).toBe('');
    });

    it('populates the assignee select with people + agents and submits the chosen id', async () => {
      render(<AddTaskModal {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByRole('option', { name: 'Alice' })).toBeInTheDocument();
        expect(screen.getByRole('option', { name: 'Bob' })).toBeInTheDocument();
        expect(screen.getByRole('option', { name: 'claude (agent)' })).toBeInTheDocument();
      });
      const titleInput = screen.getByPlaceholderText('task.titlePlaceholder');
      await userEvent.type(titleInput, 'Assigned task');
      const assigneeSelect = document.getElementById('add-task-assignee') as HTMLSelectElement;
      await userEvent.selectOptions(assigneeSelect, 'u-bob');
      const submitButton = screen.getByRole('button', { name: 'task.add' });
      await userEvent.click(submitButton);
      const payload = defaultProps.onSubmit.mock.calls[0];
      expect(payload[6]).toMatchObject({
        dueAt: null,
        assignee: 'u-bob',
        attachmentIds: [],
      });
    });

    it('uploads a chosen file via /api/upload and threads the returned id on submit', async () => {
      const { attachmentsApi } = await import('@/services/api');
      const file = new File(['hello'], 'spec.pdf', { type: 'application/pdf' });
      render(<AddTaskModal {...defaultProps} />);
      const fileInput = screen.getByTestId('add-task-attachments-input') as HTMLInputElement;
      await userEvent.upload(fileInput, file);
      await waitFor(() => {
        expect(screen.getByText('spec.pdf')).toBeInTheDocument();
      });
      expect(attachmentsApi.upload).toHaveBeenCalledWith(file);
      const titleInput = screen.getByPlaceholderText('task.titlePlaceholder');
      await userEvent.type(titleInput, 'With attachment');
      const submitButton = screen.getByRole('button', { name: 'task.add' });
      await userEvent.click(submitButton);
      const payload = defaultProps.onSubmit.mock.calls[0];
      expect(payload[6].attachmentIds).toEqual(['att-spec.pdf']);
    });

    it('removes a queued attachment before submit', async () => {
      render(<AddTaskModal {...defaultProps} />);
      const file = new File(['x'], 'mock.png', { type: 'image/png' });
      const fileInput = screen.getByTestId('add-task-attachments-input') as HTMLInputElement;
      await userEvent.upload(fileInput, file);
      await waitFor(() => {
        expect(screen.getByText('mock.png')).toBeInTheDocument();
      });
      const removeButton = screen.getByRole('button', { name: 'taskModal.removeAttachment' });
      await userEvent.click(removeButton);
      expect(screen.queryByText('mock.png')).not.toBeInTheDocument();
    });
  });

  describe('create-task permission gating (s-1053)', () => {
    const canCreateTaskInColumn = (columnId: string) => columnId !== 'col-2';

    it('enables submit when the selected column is allowed', async () => {
      render(
        <AddTaskModal
          {...defaultProps}
          currentBoardId="board-1"
          canCreateTaskInColumn={canCreateTaskInColumn}
        />
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      const input = screen.getByPlaceholderText('task.titlePlaceholder');
      await userEvent.type(input, 'New task');
      const submitButton = screen.getByRole('button', { name: 'task.add' });
      expect(submitButton).not.toBeDisabled();
    });

    it('disables submit when the selected column is forbidden by the permission gate', async () => {
      render(
        <AddTaskModal
          {...defaultProps}
          currentBoardId="board-1"
          defaultColumnId="col-2"
          canCreateTaskInColumn={canCreateTaskInColumn}
        />
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      const input = screen.getByPlaceholderText('task.titlePlaceholder');
      await userEvent.type(input, 'New task');
      const submitButton = screen.getByRole('button', { name: 'task.add' });
      expect(submitButton).toBeDisabled();
      expect(submitButton).toHaveAttribute('title', 'column.noAddPermission');
    });

    it('shows a permission warning when the selected column is forbidden', async () => {
      render(
        <AddTaskModal
          {...defaultProps}
          currentBoardId="board-1"
          defaultColumnId="col-2"
          canCreateTaskInColumn={canCreateTaskInColumn}
        />
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(screen.getByText('column.noAddPermission')).toBeInTheDocument();
    });

    it('does not call onSubmit when the submit button is disabled by the permission gate', async () => {
      render(
        <AddTaskModal
          {...defaultProps}
          currentBoardId="board-1"
          defaultColumnId="col-2"
          canCreateTaskInColumn={canCreateTaskInColumn}
        />
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      const input = screen.getByPlaceholderText('task.titlePlaceholder');
      await userEvent.type(input, 'New task');
      const submitButton = screen.getByRole('button', { name: 'task.add' });
      await userEvent.click(submitButton);
      expect(defaultProps.onSubmit).not.toHaveBeenCalled();
    });
  });
});