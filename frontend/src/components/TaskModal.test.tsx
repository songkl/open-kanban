import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TaskModal } from './TaskModal';
import { commentsApi } from '@/services/api';
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
  dueAt: null,
  published: true,
  createdBy: 'user-1',
  createdByUsername: 'creatorlogin',
  createdByNickname: 'Creator Nick',
  createdByAvatar: 'https://example.com/avatar.png',
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

// useTaskRun is mocked per-test inside the "run status badge (s-1190)"
// describe block so other tests can rely on the real hook returning
// `null` (no row → no run badge).
const useTaskRunMock = vi.fn(() => ({ run: null, loading: false, error: null }));
vi.mock('@/hooks/useTaskRun', () => ({
  useTaskRun: (...args: unknown[]) => useTaskRunMock(...args),
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
      const closeButton = screen.getByRole('button', { name: /common\.close/i });
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

    it('preserves existing comments when adding a new one to a paginated task', async () => {
      const manyComments = Array.from({ length: 12 }, (_, i) => ({
        id: `comment-${i + 1}`,
        content: `Comment ${i + 1}`,
        author: 'Jane',
        taskId: 'task-1',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      }));
      const paginatedTask = { ...mockTask, comments: manyComments };
      render(<TaskModal {...defaultProps} task={paginatedTask} />);

      expect(screen.getByText(/taskModal\.comments/)).toHaveTextContent(/\(12\)/);

      const textarea = screen.getByPlaceholderText(/taskModal\.addComment/);
      await userEvent.type(textarea, 'Brand new comment');
      const sendButton = screen.getByText('taskModal.send');
      await act(async () => {
        fireEvent.click(sendButton);
      });

      await waitFor(() => {
        expect(screen.getByText(/taskModal\.comments/)).toHaveTextContent(/\(13\)/);
      });
      expect(screen.getByText('Brand new comment')).toBeInTheDocument();
    });

    it('keeps optimistic comment visible when parent updates task.comments to an empty array', async () => {
      const manyComments = Array.from({ length: 12 }, (_, i) => ({
        id: `comment-${i + 1}`,
        content: `Comment ${i + 1}`,
        author: 'Jane',
        taskId: 'task-1',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      }));
      const paginatedTask = { ...mockTask, comments: manyComments };
      const { rerender } = render(<TaskModal {...defaultProps} task={paginatedTask} />);

      const textarea = screen.getByPlaceholderText(/taskModal\.addComment/);
      await userEvent.type(textarea, 'Optimistic comment');
      const sendButton = screen.getByText('taskModal.send');
      await act(async () => {
        fireEvent.click(sendButton);
      });

      await waitFor(() => {
        expect(screen.getByText(/taskModal\.comments/)).toHaveTextContent(/\(13\)/);
      });

      rerender(<TaskModal {...defaultProps} task={{ ...paginatedTask, comments: [] }} />);

      expect(screen.getByText(/taskModal\.comments/)).toHaveTextContent(/\(13\)/);
      expect(screen.getByText('Optimistic comment')).toBeInTheDocument();
    });

    it('does not refetch comments when parent updates the task with the same id', async () => {
      const { rerender } = render(<TaskModal {...defaultProps} />);
      const initialCalls = (commentsApi.getByTask as ReturnType<typeof vi.fn>).mock.calls.length;
      rerender(<TaskModal {...defaultProps} task={{ ...mockTask, title: 'Updated Title' }} />);
      await waitFor(() => {
        expect((commentsApi.getByTask as ReturnType<typeof vi.fn>).mock.calls.length).toBe(initialCalls);
      });
    });

    it('does not overwrite existing comments when parent updates task.comments with only the new comment', async () => {
      const serverComments = Array.from({ length: 12 }, (_, i) => ({
        id: `comment-${i + 1}`,
        content: `Comment ${i + 1}`,
        author: 'Jane',
        taskId: 'task-1',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      }));
      vi.mocked(commentsApi.getByTask).mockResolvedValue(serverComments);

      const taskWithoutComments = { ...mockTask, comments: [] };
      const { rerender } = render(<TaskModal {...defaultProps} task={taskWithoutComments} />);

      await waitFor(() => {
        expect(screen.getByText(/taskModal\.comments/)).toHaveTextContent(/\(12\)/);
      });

      const textarea = screen.getByPlaceholderText(/taskModal\.addComment/);
      await userEvent.type(textarea, 'My optimistic comment');
      const sendButton = screen.getByText('taskModal.send');
      await act(async () => {
        fireEvent.click(sendButton);
      });

      await waitFor(() => {
        expect(screen.getByText(/taskModal\.comments/)).toHaveTextContent(/\(13\)/);
      });

      rerender(
        <TaskModal
          {...defaultProps}
          task={{
            ...taskWithoutComments,
            comments: [{ id: 'server-new', content: 'My optimistic comment', author: 'TestUser', taskId: 'task-1', createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' }],
          }}
        />
      );

      expect(screen.getByText(/taskModal\.comments/)).toHaveTextContent(/\(13\)/);
      expect(screen.getByText('My optimistic comment')).toBeInTheDocument();
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

  describe('creator display', () => {
    it('renders creator nickname in header', () => {
      render(<TaskModal {...defaultProps} />);
      expect(screen.getByText('Creator Nick')).toBeInTheDocument();
    });

    it('renders creator avatar image when URL is provided', () => {
      render(<TaskModal {...defaultProps} />);
      const avatarImg = screen.getByAltText('Creator Nick');
      expect(avatarImg).toBeInTheDocument();
      expect(avatarImg).toHaveAttribute('src', 'https://example.com/avatar.png');
    });

    it('falls back to username when nickname is missing', () => {
      const taskOnlyUsername = {
        ...mockTask,
        createdByNickname: undefined,
        createdByAvatar: undefined,
      };
      render(<TaskModal {...defaultProps} task={taskOnlyUsername} />);
      expect(screen.getByText('creatorlogin')).toBeInTheDocument();
    });

    it('shows initial-based avatar when avatar URL is missing', () => {
      const taskNoAvatar = { ...mockTask, createdByAvatar: undefined };
      render(<TaskModal {...defaultProps} task={taskNoAvatar} />);
      const initial = screen.getByText('C');
      expect(initial).toBeInTheDocument();
    });
  });

  describe('a11y attributes (s-1199)', () => {
    it('exposes dialog role with aria-modal and aria-labelledby', () => {
      render(<TaskModal {...defaultProps} />);
      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(dialog).toHaveAttribute('aria-labelledby', 'task-modal-title');
    });

    it('labels the close button for screen readers', () => {
      render(<TaskModal {...defaultProps} />);
      const closeButton = screen.getByRole('button', { name: /common\.close/i });
      expect(closeButton).toBeInTheDocument();
    });

    it('labels the copy task id button for screen readers', () => {
      render(<TaskModal {...defaultProps} />);
      const copyButton = screen.getByRole('button', { name: /taskModal\.copyTaskId/i });
      expect(copyButton).toBeInTheDocument();
    });

    it('exposes aria-pressed on the fullscreen toggle', () => {
      render(<TaskModal {...defaultProps} />);
      const fullscreen = screen.getByRole('button', { name: /taskModal\.fullscreen/i });
      expect(fullscreen).toHaveAttribute('aria-pressed', 'false');
    });

    it('traps Tab key within the dialog when the last element is active', () => {
      render(<TaskModal {...defaultProps} />);
      fireEvent.keyDown(document, { key: 'Tab' });
      const dialog = screen.getByRole('dialog');
      expect(dialog.contains(document.activeElement)).toBe(true);
    });

    it('closes the dialog when Escape is pressed via the focus trap', () => {
      render(<TaskModal {...defaultProps} />);
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(defaultProps.onClose).toHaveBeenCalled();
    });

    it('renders the delete confirmation as an alertdialog', async () => {
      render(<TaskModal {...defaultProps} />);
      fireEvent.click(screen.getByText('taskModal.delete'));
      await waitFor(() => {
        const alertDialog = screen.getByRole('alertdialog');
        expect(alertDialog).toHaveAttribute('aria-modal', 'true');
        expect(alertDialog).toHaveAttribute('aria-labelledby', 'task-modal-delete-title');
        expect(alertDialog).toHaveAttribute('aria-describedby', 'task-modal-delete-desc');
      });
    });

    it('hides creator block when both username and nickname are missing', () => {
      const taskAnon = {
        ...mockTask,
        createdByUsername: undefined,
        createdByNickname: undefined,
        createdByAvatar: undefined,
      };
      render(<TaskModal {...defaultProps} task={taskAnon} />);
      expect(screen.queryByText('Creator Nick')).not.toBeInTheDocument();
      expect(screen.queryByText('creatorlogin')).not.toBeInTheDocument();
    });
  });

  /**
   * PM_REVIEW_2026-09-17 §3.6 finding #1 (s-1190): the drawer used to
   * show "🤖 运行中" and "已完成" on the same row. The fix routes the
   * status badge through `task_runs` (single source of truth) and
   * suppresses the column-name pill whenever a run row exists, so
   * exactly one of {Running, Completed, Failed, Queued} renders.
   *
   * `useTaskRun` is mocked at the top of the file so other tests can
   * rely on the real hook returning `null` (no row → no run badge).
   */
  describe('run status badge (s-1190, PM_REVIEW §3.6)', () => {
    const liveRun = {
      id: 'run-1',
      taskId: 'task-1',
      runnerId: 'runner-mac-66681-9abc',
      agentId: 'agent-claude',
      status: 'running',
      claimedAt: '2026-09-17T10:00:00.000Z',
      lastHeartbeatAt: '2026-09-17T10:00:30.000Z',
      expiresAt: '2026-09-17T10:02:00.000Z',
      finishedAt: null,
      exitCode: null,
      error: null,
    } as const;

    beforeEach(() => {
      useTaskRunMock.mockReset();
      useTaskRunMock.mockReturnValue({ run: null, loading: false, error: null });
    });

    it('renders the column name when no run row exists', () => {
      useTaskRunMock.mockReturnValue({ run: null, loading: false, error: null });
      render(<TaskModal {...defaultProps} columnName="已完成" />);
      expect(screen.getByText('已完成')).toBeInTheDocument();
      expect(screen.queryByTestId('task-run-info')).not.toBeInTheDocument();
    });

    it('suppresses the column name when a live run row exists (s-1190 core fix)', async () => {
      useTaskRunMock.mockReturnValue({ run: liveRun, loading: false, error: null });
      render(<TaskModal {...defaultProps} columnName="已完成" />);
      await waitFor(() => {
        expect(screen.queryByText('已完成')).not.toBeInTheDocument();
      });
      expect(screen.getByTestId('task-run-info')).toBeInTheDocument();
      expect(screen.getByTestId('run-status')).toHaveTextContent('taskModal.runStatus.running');
    });

    it('shows exactly one Completed badge when the latest run is completed', async () => {
      useTaskRunMock.mockReturnValue({
        run: { ...liveRun, status: 'completed', finishedAt: '2026-09-17T10:01:00.000Z', exitCode: 0 },
        loading: false,
        error: null,
      });
      render(<TaskModal {...defaultProps} columnName="已完成" />);
      await waitFor(() => {
        expect(screen.queryByText('已完成')).not.toBeInTheDocument();
      });
      const statusBadge = screen.getByTestId('run-status');
      expect(statusBadge).toHaveTextContent('taskModal.runStatus.completed');
    });

    it('shows exactly one Failed badge when the latest run is failed', async () => {
      useTaskRunMock.mockReturnValue({
        run: { ...liveRun, status: 'failed', finishedAt: '2026-09-17T10:01:00.000Z', exitCode: 1, error: 'boom' },
        loading: false,
        error: null,
      });
      render(<TaskModal {...defaultProps} columnName="已完成" />);
      await waitFor(() => {
        expect(screen.queryByText('已完成')).not.toBeInTheDocument();
      });
      const statusBadge = screen.getByTestId('run-status');
      expect(statusBadge).toHaveTextContent('taskModal.runStatus.failed');
    });

    it('shows exactly one Queued badge when the latest run was released', async () => {
      useTaskRunMock.mockReturnValue({
        run: { ...liveRun, status: 'released', finishedAt: '2026-09-17T10:01:00.000Z' },
        loading: false,
        error: null,
      });
      render(<TaskModal {...defaultProps} columnName="已完成" />);
      await waitFor(() => {
        expect(screen.queryByText('已完成')).not.toBeInTheDocument();
      });
      const statusBadge = screen.getByTestId('run-status');
      expect(statusBadge).toHaveTextContent('taskModal.runStatus.released');
    });
  });

  /**
   * s-1202 (PM_REVIEW §3.2 finding #3): the drawer must surface both
   * `tasks.assignee` and `task_runs.runner` explicitly in read-only mode
   * so operators can see who owns the task vs. who last ran it without
   * hunting through the run-info panel. The chip rendered in the card
   * footer is the visual twin of the row rendered here.
   */
  describe('assignee + last runner people section (s-1202)', () => {
    beforeEach(() => {
      useTaskRunMock.mockReset();
      useTaskRunMock.mockReturnValue({ run: null, loading: false, error: null });
    });

    it('renders the assignee row with the explicit field label', () => {
      render(<TaskModal {...defaultProps} />);
      expect(screen.getByTestId('task-modal-assignee')).toHaveTextContent('John');
      // The label key should also be visible so translators can verify
      // localisation without re-reading the implementation.
      expect(screen.getByText('taskModal.assigneeFieldLabel')).toBeInTheDocument();
    });

    it('renders the last-runner row when a run row exists', () => {
      useTaskRunMock.mockReturnValue({
        run: {
          id: 'run-1',
          taskId: 'task-1',
          runnerId: 'Mac-66681-9abc',
          agentId: null,
          status: 'running',
          claimedAt: '2026-09-17T10:00:00.000Z',
          lastHeartbeatAt: '2026-09-17T10:00:30.000Z',
          expiresAt: '2026-09-17T10:02:00.000Z',
          finishedAt: null,
          exitCode: null,
          error: null,
        },
        loading: false,
        error: null,
      });
      render(<TaskModal {...defaultProps} />);
      const lastRunner = screen.getByTestId('task-modal-last-runner');
      expect(lastRunner).toHaveTextContent('Mac-66681-9abc');
      expect(lastRunner).toHaveAttribute('title', 'Mac-66681-9abc');
      expect(screen.getByText('taskModal.lastRunnerFieldLabel')).toBeInTheDocument();
    });

    it('omits the last-runner row when no run row exists', () => {
      render(<TaskModal {...defaultProps} />);
      expect(screen.queryByTestId('task-modal-last-runner')).not.toBeInTheDocument();
    });

    it('omits the whole people section when the task has no assignee and no run', () => {
      const taskUnassigned = { ...mockTask, assignee: null };
      render(<TaskModal {...defaultProps} task={taskUnassigned} />);
      expect(screen.queryByTestId('task-modal-people')).not.toBeInTheDocument();
      expect(screen.queryByTestId('task-modal-assignee')).not.toBeInTheDocument();
    });
  });

  describe('due date display (T-1207 / s-1207)', () => {
    beforeEach(() => {
      useTaskRunMock.mockReset();
      useTaskRunMock.mockReturnValue({ run: null, loading: false, error: null });
    });

    it('renders the due-date row when task.dueAt is set', () => {
      const taskWithDue = { ...mockTask, assignee: null, dueAt: '2026-12-31T08:00:00.000Z' };
      render(<TaskModal {...defaultProps} task={taskWithDue} />);
      expect(screen.getByTestId('task-modal-people')).toBeInTheDocument();
      expect(screen.getByTestId('task-modal-due-at')).toBeInTheDocument();
      expect(screen.getByText('taskModal.dueDate')).toBeInTheDocument();
    });

    it('omits the due-date row when task.dueAt is null', () => {
      const taskNoDue = { ...mockTask, assignee: null, dueAt: null };
      render(<TaskModal {...defaultProps} task={taskNoDue} />);
      expect(screen.queryByTestId('task-modal-people')).not.toBeInTheDocument();
      expect(screen.queryByTestId('task-modal-due-at')).not.toBeInTheDocument();
    });

    it('exposes a due-date picker in the edit grid that round-trips the saved value', async () => {
      const taskWithDue = { ...mockTask, dueAt: '2026-12-31T08:00:00.000Z' };
      const user = userEvent.setup();
      render(<TaskModal {...defaultProps} task={taskWithDue} startEditing={true} />);
      const dueInput = document.getElementById('task-modal-due-at') as HTMLInputElement;
      expect(dueInput).toBeInTheDocument();
      // value is the local-time representation of 2026-12-31T08:00:00Z;
      // we just check the year/month so the test isn't timezone-sensitive.
      expect(dueInput.value).toMatch(/^2026-12-31T/);
      await user.clear(dueInput);
      await user.type(dueInput, '2027-01-15T09:30');
      const saveButton = await screen.findByText('taskModal.save');
      await user.click(saveButton);
      const onUpdate = defaultProps.onUpdate;
      const lastCall = onUpdate.mock.calls[onUpdate.mock.calls.length - 1];
      expect(lastCall[0].dueAt).toBeTruthy();
      expect(lastCall[0].dueAt.startsWith('2027-01-15')).toBe(true);
    });

    it('exposes a Clear button that nulls the due date before save', async () => {
      const taskWithDue = { ...mockTask, dueAt: '2026-12-31T08:00:00.000Z' };
      const user = userEvent.setup();
      render(<TaskModal {...defaultProps} task={taskWithDue} startEditing={true} />);
      const dueInput = document.getElementById('task-modal-due-at') as HTMLInputElement;
      expect(dueInput.value).toMatch(/^2026-12-31T/);
      const clearButton = screen.getByRole('button', { name: 'taskModal.dueDateClear' });
      await user.click(clearButton);
      expect(dueInput.value).toBe('');
      const saveButton = await screen.findByText('taskModal.save');
      await user.click(saveButton);
      const lastCall = defaultProps.onUpdate.mock.calls[defaultProps.onUpdate.mock.calls.length - 1];
      expect(lastCall[0].dueAt).toBeNull();
    });
  });
});
