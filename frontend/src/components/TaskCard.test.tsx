import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TaskCard } from './TaskCard';
import type { Task } from '@/types/kanban';

vi.mock('@dnd-kit/sortable', () => ({
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: null,
    isDragging: false,
  }),
  CSS: {
    Transform: {
      toString: () => '',
    },
  },
}));

const mockTask: Task = {
  id: 'task-1',
  title: 'Test Task',
  description: 'This is a test task description',
  position: 0,
  priority: 'medium',
  assignee: 'John Doe',
  meta: null,
  columnId: 'col-1',
  archived: false,
  archivedAt: null,
  published: true,
  agentId: null,
  agentPrompt: null,
  createdBy: 'user-1',
  createdByUsername: 'creatorlogin',
  createdByNickname: 'Creator Nick',
  createdByAvatar: 'https://example.com/avatar.png',
  createdAt: '2024-01-01',
  updatedAt: '2024-01-01',
  comments: [],
  subtasks: [],
};

describe('TaskCard', () => {
  const defaultProps = {
    task: mockTask,
    onClick: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders task title', () => {
    render(<TaskCard {...defaultProps} />);
    expect(screen.getByText('Test Task')).toBeInTheDocument();
  });

  it('renders task description', () => {
    render(<TaskCard {...defaultProps} />);
    expect(screen.getByText('This is a test task description')).toBeInTheDocument();
  });

  it('renders priority badge', () => {
    render(<TaskCard {...defaultProps} />);
    expect(screen.getByText('task.priority.medium')).toBeInTheDocument();
  });

  it('renders assignee', () => {
    render(<TaskCard {...defaultProps} />);
    expect(screen.getByText('John Doe')).toBeInTheDocument();
  });

  // s-1202: assignee badge carries an explicit tooltip and aria-label so
  // it cannot be confused with the runner chip (PM_REVIEW_2026-09-17
  // §3.2 finding #1). We assert the badge container via its data-testid
  // and the human/agent icon prefix that the previous plain text didn't
  // have.
  it('renders assignee badge with explicit Assignee tooltip', () => {
    render(<TaskCard {...defaultProps} />);
    const badge = screen.getByTestId('task-card-assignee-badge');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute('title', 'taskCard.assigneeBadgeTitle');
    expect(badge).toHaveAttribute('aria-label', 'taskCard.assigneeBadgeAria');
  });

  it('renders last-runner badge with explicit Runner tooltip when run is provided', () => {
    const run = {
      id: 'run-1',
      taskId: 'task-1',
      runnerId: 'Mac-66681-9af0',
      agentId: null,
      status: 'running' as const,
      claimedAt: '2024-01-01T00:00:00Z',
      lastHeartbeatAt: '2024-01-01T00:00:00Z',
      expiresAt: '2024-01-01T00:10:00Z',
      finishedAt: null,
      exitCode: null,
      error: null,
    };
    render(<TaskCard {...defaultProps} run={run} />);
    const badge = screen.getByTestId('task-card-last-runner-badge');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute('title', 'taskCard.lastRunnerBadgeTitle');
    expect(badge).toHaveAttribute('aria-label', 'taskCard.lastRunnerBadgeAria');
    expect(badge.textContent).toContain('Mac-66681-9');
  });

  it('omits the last-runner badge when no run is provided', () => {
    render(<TaskCard {...defaultProps} />);
    expect(screen.queryByTestId('task-card-last-runner-badge')).not.toBeInTheDocument();
  });

  it('labels the creator avatar with an explicit Created-by tooltip', () => {
    render(<TaskCard {...defaultProps} />);
    const createdBy = screen.getByTestId('task-card-created-by');
    expect(createdBy).toHaveAttribute('title', 'taskCard.createdByTooltip');
    expect(createdBy).toHaveAttribute('aria-label', 'taskCard.createdByTooltip');
  });

  it('calls onClick when view details button is clicked', () => {
    render(<TaskCard {...defaultProps} />);
    fireEvent.click(screen.getByTitle('taskCard.viewDetails'));
    expect(defaultProps.onClick).toHaveBeenCalledTimes(1);
  });

  it('shows more menu when more actions button is clicked', () => {
    render(<TaskCard {...defaultProps} onArchive={vi.fn()} onDelete={vi.fn()} />);
    fireEvent.click(screen.getByTitle('taskCard.moreActions'));
    expect(screen.getByText('taskCard.archiveTask')).toBeInTheDocument();
    expect(screen.getByText('taskCard.deleteTask')).toBeInTheDocument();
  });

  it('calls onArchive when archive is clicked', () => {
    const onArchive = vi.fn();
    render(<TaskCard {...defaultProps} onArchive={onArchive} onDelete={vi.fn()} />);
    fireEvent.click(screen.getByTitle('taskCard.moreActions'));
    fireEvent.click(screen.getByText('taskCard.archiveTask'));
    expect(onArchive).toHaveBeenCalledWith('task-1');
  });

  it('renders with high priority', () => {
    const highPriorityTask = { ...mockTask, priority: 'high' as const };
    render(<TaskCard {...defaultProps} task={highPriorityTask} />);
    expect(screen.getByText('task.priority.high')).toBeInTheDocument();
  });

  it('renders with low priority', () => {
    const lowPriorityTask = { ...mockTask, priority: 'low' as const };
    render(<TaskCard {...defaultProps} task={lowPriorityTask} />);
    expect(screen.getByText('task.priority.low')).toBeInTheDocument();
  });

  it('renders subtasks when present', () => {
    const taskWithSubtasks = {
      ...mockTask,
      subtasks: [
        { id: 'sub-1', title: 'Subtask 1', completed: false, taskId: 'task-1', createdAt: '2024-01-01', updatedAt: '2024-01-01' },
        { id: 'sub-2', title: 'Subtask 2', completed: true, taskId: 'task-1', createdAt: '2024-01-01', updatedAt: '2024-01-01' },
      ],
    };
    render(<TaskCard {...defaultProps} task={taskWithSubtasks} />);
    expect(screen.getByText('Subtask 1')).toBeInTheDocument();
    expect(screen.getByText('Subtask 2')).toBeInTheDocument();
  });

  it('renders comments count when comments exist', () => {
    const taskWithComments = {
      ...mockTask,
      comments: [
        { id: 'comment-1', content: 'Comment 1', author: 'User 1', taskId: 'task-1', createdAt: '2024-01-01', updatedAt: '2024-01-01' },
        { id: 'comment-2', content: 'Comment 2', author: 'User 2', taskId: 'task-1', createdAt: '2024-01-01', updatedAt: '2024-01-01' },
      ],
    };
    render(<TaskCard {...defaultProps} task={taskWithComments} />);
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('highlights search query in title', () => {
    render(<TaskCard {...defaultProps} searchQuery="Test" />);
    const mark = document.querySelector('mark');
    expect(mark).toBeInTheDocument();
  });

  it('highlights search query in description', () => {
    render(<TaskCard {...defaultProps} searchQuery="test" />);
    const marks = document.querySelectorAll('mark');
    expect(marks.length).toBeGreaterThan(0);
  });

  it('renders selection checkbox when onSelect is provided', () => {
    const onSelect = vi.fn();
    render(<TaskCard {...defaultProps} onSelect={onSelect} />);
    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).toBeInTheDocument();
  });

  it('calls onSelect when checkbox is clicked', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<TaskCard {...defaultProps} onSelect={onSelect} />);
    const checkbox = screen.getByRole('checkbox');
    await user.click(checkbox);
    expect(onSelect).toHaveBeenCalled();
  });

  it('renders without description', () => {
    const taskWithoutDesc = { ...mockTask, description: null };
    render(<TaskCard {...defaultProps} task={taskWithoutDesc} />);
    expect(screen.getByText('Test Task')).toBeInTheDocument();
  });

  it('renders without assignee', () => {
    const taskWithoutAssignee = { ...mockTask, assignee: null };
    render(<TaskCard {...defaultProps} task={taskWithoutAssignee} />);
    expect(screen.getByText('Test Task')).toBeInTheDocument();
  });

  it('shows completed checkmark when columnName is task.status.done', () => {
    render(<TaskCard {...defaultProps} columnName="task.status.done" />);
    expect(screen.getByText('✓')).toBeInTheDocument();
  });

  it('truncates long description with expand button', () => {
    const longDesc = 'A'.repeat(100);
    const taskWithLongDesc = { ...mockTask, description: longDesc };
    render(<TaskCard {...defaultProps} task={taskWithLongDesc} />);
    expect(screen.getByText('taskCard.expand')).toBeInTheDocument();
  });

  it('shows more subtasks indicator when more than 3 subtasks', () => {
    const manySubtasks = Array.from({ length: 5 }, (_, i) => ({
      id: `sub-${i}`,
      title: `Subtask ${i}`,
      completed: false,
      taskId: 'task-1',
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
    }));
    const taskWithManySubtasks = { ...mockTask, subtasks: manySubtasks };
    render(<TaskCard {...defaultProps} task={taskWithManySubtasks} />);
    expect(screen.getByText(/taskCard.moreSubtasks/)).toBeInTheDocument();
  });

  describe('creator avatar', () => {
    it('renders avatar image when creator avatar URL is provided', () => {
      render(<TaskCard {...defaultProps} />);
      const avatar = screen.getByAltText('Creator Nick');
      expect(avatar).toBeInTheDocument();
      expect(avatar).toHaveAttribute('src', 'https://example.com/avatar.png');
    });

    it('renders creator nickname next to avatar', () => {
      render(<TaskCard {...defaultProps} />);
      expect(screen.getByText('Creator Nick')).toBeInTheDocument();
    });

    it('falls back to username when creator nickname is missing', () => {
      const taskOnlyUsername = {
        ...mockTask,
        createdByNickname: undefined,
      };
      render(<TaskCard {...defaultProps} task={taskOnlyUsername} />);
      expect(screen.getByText('creatorlogin')).toBeInTheDocument();
    });

    it('falls back to initial avatar when creator avatar URL is missing', () => {
      const taskNoAvatar = { ...mockTask, createdByAvatar: undefined };
      render(<TaskCard {...defaultProps} task={taskNoAvatar} />);
      const initial = screen.getByText('C');
      expect(initial).toBeInTheDocument();
    });

    it('hides creator avatar when no creator info is available', () => {
      const taskAnon = {
        ...mockTask,
        createdByUsername: undefined,
        createdByNickname: undefined,
        createdByAvatar: undefined,
      };
      const { container } = render(<TaskCard {...defaultProps} task={taskAnon} />);
      expect(container.querySelectorAll('img').length).toBe(0);
      expect(screen.queryByText('creatorlogin')).not.toBeInTheDocument();
    });
  });
});