import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddTaskModal } from './AddTaskModal';

vi.mock('@/services/api', () => ({
  columnsApi: {
    getByBoard: vi.fn().mockResolvedValue([
      { id: 'col-1', name: 'To Do', status: 'todo' },
      { id: 'col-2', name: 'In Progress', status: 'in_progress' },
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
      'medium'
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

  it('renders priority select with three options', () => {
    render(<AddTaskModal {...defaultProps} />);
    const priorityButton = screen.getByRole('button', { name: 'taskModal.priorityMedium' });
    expect(priorityButton).toBeInTheDocument();
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
});
