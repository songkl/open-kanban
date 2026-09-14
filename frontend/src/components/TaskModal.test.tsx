import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TaskModal } from './TaskModal';
import type { Task } from '@/types/kanban';

// Mock the polling hook so the run info section tests can drive `run`
// directly without faking timers. The hook is exercised end-to-end in
// `useTaskRun.test.ts`; here we only care that the modal renders the
// expected fields (runner, agent, status, timestamps) when a run is
// present and stays hidden when it isn't.
vi.mock('../hooks/useTaskRun', () => ({
  useTaskRun: vi.fn(),
}));
import { useTaskRun } from '../hooks/useTaskRun';
const mockedUseTaskRun = useTaskRun as unknown as ReturnType<typeof vi.fn>;

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
    {
      id: 'subtask-2',
      title: 'Subtask 2',
      completed: true,
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
    create: vi.fn().mockResolvedValue({ id: 'new-subtask', title: 'New Subtask', completed: false }),
  },
  attachmentsApi: {
    getByTask: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue({}),
    upload: vi.fn().mockReturnValue({ promise: Promise.resolve({ id: 'att-1', url: 'http://test.com/file.png' }) }),
  },
  commentsApi: {
    getByTask: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({ id: 'comment-new', content: 'New comment', author: 'TestUser' }),
  },
  authApi: {
    me: vi.fn().mockResolvedValue({ user: { nickname: 'TestUser' } }),
    getAgents: vi.fn().mockResolvedValue([
      { id: 'agent-1', nickname: 'Agent1', role: 'AGENT', type: 'AGENT', enabled: true, createdAt: '', updatedAt: '', tokenCount: 0 },
    ]),
  },
}));

vi.mock('@/components/MarkdownEditor', () => ({
  default: function MockMarkdownEditor({ value, onChange }: { value: string; onChange: (val: string) => void }) {
    return (
      <textarea
        data-testid="markdown-editor"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  },
}));

vi.mock('@/components/SafeMarkdown', () => ({
  SafeMarkdown: ({ children }: { children: string }) => <div data-testid="safe-markdown">{children}</div>,
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
    // Default: no active run, so unrelated assertions aren't affected
    // by the run info section.
    mockedUseTaskRun.mockReturnValue({ run: null, loading: false, error: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('basic rendering', () => {
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

    it('renders comments section', () => {
      render(<TaskModal {...defaultProps} />);
      expect(screen.getByText(/taskModal\.comments/)).toBeInTheDocument();
    });

    it('renders subtasks section', () => {
      render(<TaskModal {...defaultProps} />);
      expect(screen.getByText(/taskModal\.subtasks/)).toBeInTheDocument();
    });

    it('renders delete button when canEdit is true', () => {
      render(<TaskModal {...defaultProps} canEdit={true} />);
      const deleteButtons = screen.getAllByText('taskModal.delete');
      expect(deleteButtons.length).toBeGreaterThan(0);
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

  describe('edit mode', () => {
    it('enters edit mode when edit button is clicked', async () => {
      render(<TaskModal {...defaultProps} canEdit={true} />);
      await act(async () => {
        fireEvent.click(screen.getByText('taskModal.editTask'));
      });
      await waitFor(() => {
        expect(screen.queryByText('taskModal.editTask')).not.toBeInTheDocument();
      });
    });

    it('shows save and cancel buttons in edit mode', async () => {
      render(<TaskModal {...defaultProps} canEdit={true} />);
      await act(async () => {
        fireEvent.click(screen.getByText('taskModal.editTask'));
      });
      await waitFor(() => {
        expect(screen.getByText('taskModal.save')).toBeInTheDocument();
        expect(screen.getByText('taskModal.cancel')).toBeInTheDocument();
      });
    });

    it('exits edit mode when cancel is clicked', async () => {
      render(<TaskModal {...defaultProps} canEdit={true} />);
      await act(async () => {
        fireEvent.click(screen.getByText('taskModal.editTask'));
      });
      await waitFor(() => {
        expect(screen.getByText('taskModal.save')).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.click(screen.getByText('taskModal.cancel'));
      });
      await waitFor(() => {
        expect(screen.queryByText('taskModal.save')).not.toBeInTheDocument();
        expect(screen.getByText('taskModal.editTask')).toBeInTheDocument();
      });
    });

    it('calls onUpdate when save is clicked', async () => {
      render(<TaskModal {...defaultProps} canEdit={true} />);
      await act(async () => {
        fireEvent.click(screen.getByText('taskModal.editTask'));
      });
      await waitFor(() => {
        expect(screen.getByText('taskModal.save')).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.click(screen.getByText('taskModal.save'));
      });
      await waitFor(() => {
        expect(defaultProps.onUpdate).toHaveBeenCalled();
      });
    });
  });

  describe('subtasks', () => {
    it('renders subtask checkbox', () => {
      render(<TaskModal {...defaultProps} />);
      const checkboxes = screen.getAllByRole('checkbox');
      expect(checkboxes.length).toBeGreaterThan(0);
    });

    it('renders subtask titles', () => {
      render(<TaskModal {...defaultProps} />);
      expect(screen.getByText('Subtask 1')).toBeInTheDocument();
      expect(screen.getByText('Subtask 2')).toBeInTheDocument();
    });

    it('shows completed subtask with strikethrough', () => {
      render(<TaskModal {...defaultProps} />);
      const subtask2 = screen.getByText('Subtask 2');
      expect(subtask2).toHaveClass('line-through');
    });

    it('renders add subtask button in edit mode', async () => {
      render(<TaskModal {...defaultProps} canEdit={true} />);
      await act(async () => {
        fireEvent.click(screen.getByText('taskModal.editTask'));
      });
      await waitFor(() => {
        expect(screen.getByText('+ taskModal.addSubtask')).toBeInTheDocument();
      });
    });
  });

  describe('comments', () => {
    it('renders comment author and content', () => {
      render(<TaskModal {...defaultProps} />);
      expect(screen.getByText('Jane')).toBeInTheDocument();
      expect(screen.getByText('Test comment')).toBeInTheDocument();
    });

    it('renders comment input when not editing', () => {
      render(<TaskModal {...defaultProps} />);
      const textarea = screen.getByPlaceholderText(/taskModal\.addComment/);
      expect(textarea).toBeInTheDocument();
    });

    it('calls onAddComment when send button is clicked', async () => {
      render(<TaskModal {...defaultProps} />);
      const textarea = screen.getByPlaceholderText(/taskModal\.addComment/);
      await userEvent.type(textarea, 'New comment');
      const sendButton = screen.getByText('taskModal.send');
      await act(async () => {
        fireEvent.click(sendButton);
      });
      expect(defaultProps.onAddComment).toHaveBeenCalledWith('task-1', 'New comment', 'TestUser');
    });
  });

  describe('archive action', () => {
    it('calls onArchive when archive button is clicked', async () => {
      render(<TaskModal {...defaultProps} canEdit={true} />);
      await act(async () => {
        fireEvent.click(screen.getByText('taskModal.archive'));
      });
      expect(defaultProps.onArchive).toHaveBeenCalledWith('task-1');
    });
  });

  describe('delete action', () => {
    it('shows delete confirmation modal when delete is clicked', async () => {
      render(<TaskModal {...defaultProps} canEdit={true} />);
      const deleteButton = screen.getByText('taskModal.delete');
      await act(async () => {
        fireEvent.click(deleteButton);
      });
      await waitFor(() => {
        expect(screen.getByText('taskModal.confirmDeleteTitle')).toBeInTheDocument();
      });
    });

    it('does not call onDelete when cancel is clicked in confirmation', async () => {
      render(<TaskModal {...defaultProps} canEdit={true} />);
      await act(async () => {
        fireEvent.click(screen.getByText('taskModal.delete'));
      });
      await waitFor(() => {
        expect(screen.getByText('taskModal.confirmDeleteTitle')).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.click(screen.getByText('taskModal.cancel'));
      });
      expect(defaultProps.onDelete).not.toHaveBeenCalled();
    });

    it('calls onDelete when confirm is clicked in confirmation', async () => {
      render(<TaskModal {...defaultProps} canEdit={true} />);
      await act(async () => {
        fireEvent.click(screen.getByText('taskModal.delete'));
      });
      await waitFor(() => {
        expect(screen.getByText('taskModal.confirmDeleteTitle')).toBeInTheDocument();
      });
      const confirmButtons = screen.getAllByText('taskModal.delete');
      const confirmDeleteButton = confirmButtons.find(
        (btn) => btn.className.includes('bg-red-500')
      );
      await act(async () => {
        fireEvent.click(confirmDeleteButton!);
      });
      expect(defaultProps.onDelete).toHaveBeenCalledWith('task-1');
    });
  });

  describe('meta fields', () => {
    it('renders meta section when task has meta', () => {
      const taskWithMeta = { ...mockTask, meta: { Key1: 'Value1', Key2: 'Value2' } };
      render(<TaskModal {...defaultProps} task={taskWithMeta} />);
      expect(screen.getByText('Key1:')).toBeInTheDocument();
      expect(screen.getByText('Value1')).toBeInTheDocument();
    });

    it('shows add meta button in edit mode', async () => {
      render(<TaskModal {...defaultProps} canEdit={true} />);
      await act(async () => {
        fireEvent.click(screen.getByText('taskModal.editTask'));
      });
      await waitFor(() => {
        expect(screen.getByPlaceholderText('taskModal.metaKey')).toBeInTheDocument();
      });
    });
  });

  describe('keyboard shortcuts', () => {
    it('closes modal on Escape key', async () => {
      render(<TaskModal {...defaultProps} />);
      await act(async () => {
        fireEvent.keyDown(document, { key: 'Escape' });
      });
      expect(defaultProps.onClose).toHaveBeenCalled();
    });
  });

  describe('timestamps', () => {
    it('renders created at timestamp', () => {
      render(<TaskModal {...defaultProps} />);
      expect(screen.getByText(/taskModal\.publishedAt/)).toBeInTheDocument();
    });
  });

  describe('attachments section', () => {
    it('renders attachments section', () => {
      render(<TaskModal {...defaultProps} />);
      expect(screen.getByText(/taskModal\.attachments/)).toBeInTheDocument();
    });
  });

  describe('agent fields', () => {
    it('renders agent dropdown in edit mode', async () => {
      render(<TaskModal {...defaultProps} canEdit={true} />);
      await act(async () => {
        fireEvent.click(screen.getByText('taskModal.editTask'));
      });
      await waitFor(() => {
        expect(screen.getByText('taskModal.agentId')).toBeInTheDocument();
      });
    });
  });

  describe('columns dropdown', () => {
    it('renders status/column dropdown in edit mode', async () => {
      render(<TaskModal {...defaultProps} canEdit={true} />);
      await act(async () => {
        fireEvent.click(screen.getByText('taskModal.editTask'));
      });
      await waitFor(() => {
        expect(screen.getByText('taskModal.status')).toBeInTheDocument();
      });
    });
  });

  describe('startEditing prop', () => {
    it('starts in edit mode when startEditing is true', async () => {
      render(<TaskModal {...defaultProps} canEdit={true} startEditing={true} />);
      await waitFor(() => {
        expect(screen.getByText('taskModal.save')).toBeInTheDocument();
      });
    });
  });

  describe('task without comments or subtasks', () => {
    it('renders empty comments list', () => {
      const taskNoComments = { ...mockTask, comments: [] };
      render(<TaskModal {...defaultProps} task={taskNoComments} />);
      expect(screen.queryByText('Jane')).not.toBeInTheDocument();
    });
  });

  describe('run info section', () => {
    beforeEach(() => {
      mockedUseTaskRun.mockReset();
    });

    it('does not render the section when no run is active', () => {
      mockedUseTaskRun.mockReturnValue({ run: null, loading: false, error: null });
      render(<TaskModal {...defaultProps} />);
      expect(screen.queryByTestId('task-run-info')).not.toBeInTheDocument();
    });

    it('renders runner id, agent id, status and timestamps when a run is active', () => {
      const claimedAt = new Date('2026-09-15T10:30:00Z').toISOString();
      const lastHeartbeatAt = new Date('2026-09-15T10:32:00Z').toISOString();
      const expiresAt = new Date('2026-09-15T10:35:00Z').toISOString();
      mockedUseTaskRun.mockReturnValue({
        run: {
          taskId: 'task-1',
          runnerId: 'runner-bar',
          agentId: 'opencode',
          boardId: 'b-1',
          columnId: 'c-1',
          status: 'running',
          claimedAt,
          lastHeartbeatAt,
          expiresAt,
        },
        loading: false,
        error: null,
      });
      render(<TaskModal {...defaultProps} />);
      const section = screen.getByTestId('task-run-info');
      expect(section).toBeInTheDocument();
      // Section title is translated.
      expect(section.textContent).toContain('taskModal.runInfo');
      // Runner id and agent id surfaces verbatim.
      expect(section.textContent).toContain('runner-bar');
      expect(section.textContent).toContain('opencode');
      // Status badge.
      const statusBadge = screen.getByTestId('run-status');
      expect(statusBadge.textContent).toBe('taskModal.runStatus.running');
      // Labels for the timestamp rows.
      expect(section.textContent).toContain('taskModal.runRunner');
      expect(section.textContent).toContain('taskModal.runAgent');
      expect(section.textContent).toContain('taskModal.runClaimedAt');
      expect(section.textContent).toContain('taskModal.runLastHeartbeat');
      expect(section.textContent).toContain('taskModal.runExpiresAt');
      // Elapsed label is present.
      expect(section.textContent).toContain('taskModal.runElapsed');
    });

    it('renders the finished at / exit code / error fields when present', () => {
      mockedUseTaskRun.mockReturnValue({
        run: {
          taskId: 'task-1',
          runnerId: 'runner-failed',
          agentId: 'opencode',
          boardId: 'b-1',
          columnId: 'c-1',
          status: 'failed',
          claimedAt: new Date('2026-09-15T10:30:00Z').toISOString(),
          lastHeartbeatAt: new Date('2026-09-15T10:32:00Z').toISOString(),
          expiresAt: new Date('2026-09-15T10:35:00Z').toISOString(),
          finishedAt: new Date('2026-09-15T10:33:00Z').toISOString(),
          exitCode: 1,
          error: 'boom: agent crashed',
        },
        loading: false,
        error: null,
      });
      render(<TaskModal {...defaultProps} />);
      const section = screen.getByTestId('task-run-info');
      expect(section.textContent).toContain('taskModal.runFinishedAt');
      expect(section.textContent).toContain('taskModal.runExitCode');
      expect(section.textContent).toContain('taskModal.runError');
      expect(section.textContent).toContain('boom: agent crashed');
    });

    it('survives a long runnerId without breaking layout', () => {
      const longRunnerId = 'a-very-long-runner-id-that-definitely-overflows-the-card';
      mockedUseTaskRun.mockReturnValue({
        run: {
          taskId: 'task-1',
          runnerId: longRunnerId,
          agentId: 'opencode',
          boardId: 'b-1',
          columnId: 'c-1',
          status: 'claimed',
          claimedAt: new Date(Date.now() - 5_000).toISOString(),
          lastHeartbeatAt: new Date(Date.now() - 1_000).toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        loading: false,
        error: null,
      });
      render(<TaskModal {...defaultProps} />);
      const section = screen.getByTestId('task-run-info');
      // The dd for runner id carries `break-all` so the long id wraps
      // rather than pushing sibling columns.
      const dd = section.querySelector('dd.break-all');
      expect(dd).not.toBeNull();
      expect(dd?.textContent).toContain(longRunnerId);
    });

    it('does not tick the elapsed label when the run is in a terminal status (s-1168)', () => {
      vi.useFakeTimers();
      try {
        const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
        mockedUseTaskRun.mockReturnValue({
          run: {
            taskId: 'task-1',
            runnerId: 'runner-failed',
            agentId: 'opencode',
            boardId: 'b-1',
            columnId: 'c-1',
            status: 'failed',
            claimedAt: new Date('2026-09-15T10:30:00Z').toISOString(),
            lastHeartbeatAt: new Date('2026-09-15T10:32:00Z').toISOString(),
            expiresAt: new Date('2026-09-15T10:35:00Z').toISOString(),
            finishedAt: new Date('2026-09-15T10:33:00Z').toISOString(),
            exitCode: 1,
            error: 'boom',
          },
          loading: false,
          error: null,
        });
        render(<TaskModal {...defaultProps} />);
        // For terminal runs the modal must not arm a 1-second interval
        // — useTaskRun already stopped the API poll and the UI should
        // not keep re-rendering the modal banner either.
        expect(setIntervalSpy).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps ticking the elapsed label while the run is still live', () => {
      vi.useFakeTimers();
      try {
        const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
        mockedUseTaskRun.mockReturnValue({
          run: {
            taskId: 'task-1',
            runnerId: 'runner-live',
            agentId: 'opencode',
            boardId: 'b-1',
            columnId: 'c-1',
            status: 'running',
            claimedAt: new Date(Date.now() - 5_000).toISOString(),
            lastHeartbeatAt: new Date(Date.now() - 1_000).toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
          loading: false,
          error: null,
        });
        render(<TaskModal {...defaultProps} />);
        // Live runs must arm the 1-second tick — positive control for
        // the terminal-run assertion above.
        expect(setIntervalSpy).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
