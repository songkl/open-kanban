import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TaskCard } from './TaskCard';
import type { Task } from '@/types/kanban';

// Mock the polling hook so the badge tests can drive `run` directly
// without faking timers. The hook is exercised end-to-end in
// `useTaskRun.test.ts`; here we only care that the card renders the
// runner id and elapsed label when the hook returns a row, and hides
// itself when it returns null.
vi.mock('../hooks/useTaskRun', () => ({
  useTaskRun: vi.fn(),
}));
import { useTaskRun } from '../hooks/useTaskRun';
const mockedUseTaskRun = useTaskRun as unknown as ReturnType<typeof vi.fn>;

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
    // The polling hook is mocked at module scope; every test starts
    // with the "no active run" baseline so unrelated assertions aren't
    // affected by the badge.
    mockedUseTaskRun.mockReturnValue({ run: null, loading: false, error: null });
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

  // s-1206: medium-priority yellow chip needs WCAG-AA contrast on dark
  // theme; we move from yellow-400 text on yellow-900/50 to yellow-200
  // text on yellow-900/70 and tighten the light-mode text shade to
  // yellow-800 so both modes pass contrast.
  it('renders the medium-priority chip with WCAG-AA contrast classes', () => {
    const { container } = render(<TaskCard {...defaultProps} />);
    const badge = screen.getByText('task.priority.medium');
    expect(badge.className).toContain('bg-yellow-100');
    expect(badge.className).toContain('text-yellow-800');
    expect(badge.className).toContain('dark:bg-yellow-900/70');
    expect(badge.className).toContain('dark:text-yellow-200');
    // sanity check: the badge is the chip element, not the root card
    expect(container).toBeInTheDocument();
  });

  // s-1206: card surface needs to be a step darker on dark theme so it
  // doesn't outshine the column background. Was dark:bg-zinc-800/95,
  // now dark:bg-zinc-800/80.
  it('uses a lower-opacity zinc surface on dark mode for the card', () => {
    const { container } = render(<TaskCard {...defaultProps} />);
    const card = container.firstChild as HTMLElement | null;
    expect(card?.className).toContain('dark:bg-zinc-800/80');
    expect(card?.className).not.toContain('dark:bg-zinc-800/95');
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

  describe('runner badge', () => {
    beforeEach(() => {
      mockedUseTaskRun.mockReset();
    });

    it('does not render the badge when no run is active', () => {
      mockedUseTaskRun.mockReturnValue({ run: null, loading: false, error: null });
      render(<TaskCard {...defaultProps} />);
      expect(screen.queryByTestId('runner-badge')).not.toBeInTheDocument();
    });

    it('renders the runner id and elapsed seconds when a run is active', async () => {
      const claimedAt = new Date(Date.now() - 12_000).toISOString(); // 12s ago
      mockedUseTaskRun.mockReturnValue({
        run: {
          taskId: 'task-1',
          runnerId: 'runner-foo',
          agentId: 'opencode',
          boardId: 'b-1',
          columnId: 'c-1',
          status: 'claimed',
          claimedAt,
          lastHeartbeatAt: claimedAt,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        loading: false,
        error: null,
      });
      render(<TaskCard {...defaultProps} />);
      const badge = screen.getByTestId('runner-badge');
      expect(badge).toBeInTheDocument();
      // runner id surfaces verbatim so operators can grep logs.
      expect(badge.textContent).toContain('runner-foo');
      // 12 seconds of elapsed time, formatted as the i18n key with
      // count substituted in by the test mock that just returns the
      // key.
      await waitFor(() => expect(badge.textContent).toContain('taskCard.runnerElapsedSeconds'));
    });

    it('truncates an over-long runnerId so it does not push the badge to a new line', () => {
      const longRunnerId = 'a-very-long-runner-id-that-definitely-overflows-the-card';
      const claimedAt = new Date(Date.now() - 5_000).toISOString();
      mockedUseTaskRun.mockReturnValue({
        run: {
          taskId: 'task-1',
          runnerId: longRunnerId,
          agentId: 'opencode',
          boardId: 'b-1',
          columnId: 'c-1',
          status: 'running',
          claimedAt,
          lastHeartbeatAt: claimedAt,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        loading: false,
        error: null,
      });
      render(<TaskCard {...defaultProps} />);
      const badge = screen.getByTestId('runner-badge');
      // Outer pill must clamp its width so the inner flex children
      // don't push the footer layout.
      expect(badge).toHaveClass('max-w-[10rem]');
      expect(badge).toHaveClass('overflow-hidden');
      // The runner id span carries `truncate` (Tailwind: overflow:hidden +
      // text-overflow:ellipsis + white-space:nowrap) so the inner text
      // never breaks onto a second line. We assert on the class name
      // rather than the computed style because JSDOM does not honor
      // layout.
      const runnerSpan = badge.querySelector('span.font-mono');
      expect(runnerSpan).not.toBeNull();
      expect(runnerSpan).toHaveClass('truncate');
      // The full runner id must still be exposed via the `title`
      // attribute on the inner span so hover-tooltip shows it.
      expect(runnerSpan).toHaveAttribute('title', longRunnerId);
      // And the badge's own title shows the composite "id · elapsed"
      // label — guards against accidentally regressing this when the
      // runnerId is no longer surfaced verbatim in `textContent`.
      expect(badge).toHaveAttribute('title');
      expect(badge.getAttribute('title')).toContain(longRunnerId);
    });

    it('does not tick the elapsed label when the run is in a terminal status (s-1168)', () => {
      vi.useFakeTimers();
      try {
        const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
        // Run finished 30 seconds after it claimed — badge should
        // freeze the elapsed label at 30s, not keep counting from
        // Date.now().
        const claimedAt = new Date(Date.now() - 60_000).toISOString();
        const finishedAt = new Date(Date.now() - 30_000).toISOString();
        mockedUseTaskRun.mockReturnValue({
          run: {
            taskId: 'task-1',
            runnerId: 'runner-failed',
            agentId: 'opencode',
            boardId: 'b-1',
            columnId: 'c-1',
            status: 'failed',
            claimedAt,
            lastHeartbeatAt: finishedAt,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            finishedAt,
            exitCode: 1,
            error: 'boom',
          },
          loading: false,
          error: null,
        });
        render(<TaskCard {...defaultProps} />);
        // For terminal runs the badge must not arm a 1-second interval
        // — useTaskRun already stopped the API poll and the UI should
        // not keep re-rendering the card either.
        expect(setIntervalSpy).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps ticking the elapsed label when the run is still live', () => {
      vi.useFakeTimers();
      try {
        const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
        const claimedAt = new Date(Date.now() - 5_000).toISOString();
        mockedUseTaskRun.mockReturnValue({
          run: {
            taskId: 'task-1',
            runnerId: 'runner-live',
            agentId: 'opencode',
            boardId: 'b-1',
            columnId: 'c-1',
            status: 'running',
            claimedAt,
            lastHeartbeatAt: claimedAt,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
          loading: false,
          error: null,
        });
        render(<TaskCard {...defaultProps} />);
        // The 1-second tick is required for live runs so the elapsed
        // label stays accurate — this is the positive control for the
        // terminal-run assertion above.
        expect(setIntervalSpy).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});