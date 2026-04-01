import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TaskModal } from './TaskModal';
import type { Task } from '@/types/kanban';

const mockTask: Task = {
  id: 'task-1',
  title: 'Test Task',
  description: 'Test Description',
  position: 0,
  priority: 'high',
  assignee: 'John',
  meta: null,
  columnId: 'col-1',
  archived: false,
  archivedAt: null,
  published: true,
  createdBy: 'user-1',
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  comments: [
    {
      id: 'comment-1',
      content: 'Test comment',
      author: 'Jane',
      taskId: 'task-1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    },
  ],
  subtasks: [
    {
      id: 'subtask-1',
      title: 'Subtask 1',
      completed: false,
      taskId: 'task-1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    },
  ],
};

vi.mock('@/services/api', () => ({
  columnsApi: {
    getByBoard: vi.fn().mockResolvedValue([
      { id: 'col-1', name: 'To Do' },
      { id: 'col-2', name: 'In Progress' },
    ]),
  },
  subtasksApi: {
    update: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  },
  attachmentsApi: {
    getByTask: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue({}),
  },
  authApi: {
    me: vi.fn().mockResolvedValue({ user: { nickname: 'TestUser' } }),
    getAgents: vi.fn().mockResolvedValue([]),
  },
}));

describe('TaskModal', () => {
  const defaultProps = {
    task: mockTask,
    columnName: 'To Do',
    onClose: vi.fn(),
    onUpdate: vi.fn(),
    onDelete: vi.fn(),
    onArchive: vi.fn(),
    onAddComment: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('renders task title', () => {
    render(<TaskModal {...defaultProps} />);
    expect(screen.getByText('Test Task')).toBeInTheDocument();
  });

  it('renders column name badge', () => {
    render(<TaskModal {...defaultProps} />);
    expect(screen.getByText('To Do')).toBeInTheDocument();
  });

  it('renders task description', () => {
    render(<TaskModal {...defaultProps} />);
    expect(screen.getByText('Test Description')).toBeInTheDocument();
  });

  it('renders edit button when canEdit is true', () => {
    render(<TaskModal {...defaultProps} canEdit={true} />);
    expect(screen.getByText('taskModal.editTask')).toBeInTheDocument();
  });

  it('does not render edit button when canEdit is false', () => {
    render(<TaskModal {...defaultProps} canEdit={false} />);
    expect(screen.queryByText('taskModal.editTask')).not.toBeInTheDocument();
  });

  it('calls onClose when close button is clicked', async () => {
    render(<TaskModal {...defaultProps} />);
    const closeButton = screen.getByRole('button', { name: '' });
    await userEvent.click(closeButton);
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it('renders comments section with count', () => {
    render(<TaskModal {...defaultProps} />);
    expect(screen.getByText(/taskModal\.comments/)).toBeInTheDocument();
  });

  it('renders subtasks section with count', () => {
    render(<TaskModal {...defaultProps} />);
    expect(screen.getByText(/taskModal\.subtasks/)).toBeInTheDocument();
  });

  it('renders delete button when canEdit is true', () => {
    render(<TaskModal {...defaultProps} canEdit={true} />);
    expect(screen.getByText('taskModal.delete')).toBeInTheDocument();
  });

  it('renders archive button when canEdit is true', () => {
    render(<TaskModal {...defaultProps} canEdit={true} />);
    expect(screen.getByText('taskModal.archive')).toBeInTheDocument();
  });

  it('shows no description text when description is empty', () => {
    const taskNoDesc = { ...mockTask, description: null };
    render(<TaskModal {...defaultProps} task={taskNoDesc} />);
    expect(screen.getByText('taskModal.noDescription')).toBeInTheDocument();
  });

  it('shows no subtasks text when subtasks are empty', () => {
    const taskNoSubtasks = { ...mockTask, subtasks: [] };
    render(<TaskModal {...defaultProps} task={taskNoSubtasks} />);
    expect(screen.getByText('taskModal.noSubtasks')).toBeInTheDocument();
  });
});
