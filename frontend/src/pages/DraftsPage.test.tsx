import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { DraftsPage } from './DraftsPage';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const translations: Record<string, string> = {
        'drafts.title': 'Drafts',
        'drafts.backToBoard': 'Back to Board',
        'drafts.newTask': 'New Task',
        'drafts.draftCount': '{{count}} drafts',
        'drafts.loading': 'Loading...',
        'drafts.empty': 'No drafts yet',
        'drafts.loadFailed': 'Failed to load',
        'drafts.retry': 'Retry',
        'drafts.edit': 'Edit',
        'drafts.publish': 'Publish',
        'drafts.delete': 'Delete',
        'drafts.createdAt': 'Created:',
        'drafts.titlePlaceholder': 'Task title...',
        'drafts.descriptionPlaceholder': 'Description (optional)',
        'drafts.targetColumn': 'Target Column',
        'drafts.cancel': 'Cancel',
        'drafts.saveDraft': 'Save Draft',
        'drafts.editDraft': 'Edit Draft',
        'drafts.saveChanges': 'Save Changes',
        'drafts.publishToBoard': 'Publish to Board',
        'drafts.selectBoard': 'Select Board',
        'drafts.selectColumn': 'Select Column',
        'drafts.noColumns': 'No columns available',
        'toast.saveFailed': 'Failed to save',
        'toast.publishFailed': 'Failed to publish',
        'toast.deleteFailed': 'Failed to delete',
        'drafts.confirmDeleteTitle': 'Delete Draft?',
        'drafts.confirmDelete': 'Are you sure you want to delete this draft?',
        'drafts.moreSubtasks': '+{{count}} more',
        'modal.deleteConfirmTitle': 'Confirm Delete',
        'task.priority.high': 'High',
        'task.priority.medium': 'Medium',
        'task.priority.low': 'Low',
      };
      let result = translations[key] || key;
      if (params) {
        Object.entries(params).forEach(([k, v]) => {
          result = result.replace(new RegExp(`{{${k}}}`, 'g'), String(v));
        });
      }
      return result;
    },
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/services/api', () => {
  const mockTask = {
    id: 'draft-1',
    title: 'Test Draft Task',
    description: 'Test description',
    position: 0,
    priority: 'high',
    assignee: null,
    meta: null,
    columnId: 'col-1',
    archived: false,
    archivedAt: null,
    published: false,
    createdBy: 'user-1',
    createdAt: '2024-01-15T10:00:00Z',
    updatedAt: '2024-01-15T10:00:00Z',
    comments: [],
    subtasks: [],
  };

  return {
    boardsApi: {
      getAll: vi.fn().mockResolvedValue([
        { id: 'board-1', name: 'Board One', description: '', createdAt: '2024-01-01', updatedAt: '2024-01-01' },
        { id: 'board-2', name: 'Board Two', description: '', createdAt: '2024-01-01', updatedAt: '2024-01-01' },
      ]),
    },
    columnsApi: {
      getByBoard: vi.fn().mockResolvedValue([
        { id: 'col-1', name: 'To Do', position: 0 },
        { id: 'col-2', name: 'In Progress', position: 1 },
      ]),
    },
    draftsApi: {
      getByBoard: vi.fn().mockImplementation((boardId: string) => {
        if (boardId === 'board-1') {
          return Promise.resolve([mockTask]);
        }
        return Promise.resolve([]);
      }),
    },
    tasksApi: {
      create: vi.fn().mockResolvedValue({ id: 'new-draft', title: 'New Draft' }),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    setGlobalErrorHandler: vi.fn(),
  };
});

vi.mock('@/components/ErrorToast', () => ({
  showErrorToast: vi.fn(),
}));

vi.mock('@/components/ConfirmDialog', () => ({
  ConfirmDialog: ({ isOpen, onConfirm, onCancel }: { isOpen: boolean; onConfirm: () => void; onCancel: () => void }) => {
    if (!isOpen) return null;
    return (
      <div data-testid="confirm-dialog">
        <button onClick={onCancel}>Cancel</button>
        <button onClick={onConfirm}>Confirm</button>
      </div>
    );
  },
}));

const renderDraftsPage = () => {
  return render(
    <BrowserRouter>
      <DraftsPage />
    </BrowserRouter>
  );
};

describe('DraftsPage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders loading state initially', () => {
    renderDraftsPage();
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('renders board selector after boards load', async () => {
    renderDraftsPage();

    await waitFor(() => {
      expect(screen.getByText('Board One')).toBeInTheDocument();
    });

    const boardSelect = screen.getByRole('combobox');
    expect(boardSelect).toBeInTheDocument();
  });

  it('renders page header with title and new task button', async () => {
    renderDraftsPage();

    await waitFor(() => {
      expect(screen.getByText('Drafts')).toBeInTheDocument();
    });

    const newTaskButton = screen.getByRole('button', { name: /New Task/i });
    expect(newTaskButton).toBeInTheDocument();
  });

  it('opens add modal when clicking new task button', async () => {
    renderDraftsPage();

    await waitFor(() => {
      expect(screen.getByText('Board One')).toBeInTheDocument();
    });

    const newTaskButton = screen.getByRole('button', { name: /New Task/i });
    await userEvent.click(newTaskButton);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Task title...')).toBeInTheDocument();
    });
  });

  it('closes add modal when cancel is clicked', async () => {
    renderDraftsPage();

    await waitFor(() => {
      expect(screen.getByText('Board One')).toBeInTheDocument();
    });

    const newTaskButton = screen.getByRole('button', { name: /New Task/i });
    await userEvent.click(newTaskButton);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Task title...')).toBeInTheDocument();
    });

    const cancelButton = screen.getByRole('button', { name: 'Cancel' });
    await userEvent.click(cancelButton);

    await waitFor(() => {
      expect(screen.queryByPlaceholderText('Task title...')).not.toBeInTheDocument();
    });
  });

  it('renders back to board link', async () => {
    renderDraftsPage();

    await waitFor(() => {
      const backLink = screen.getByRole('link', { name: 'Back to Board' });
      expect(backLink).toBeInTheDocument();
    });
  });
});
