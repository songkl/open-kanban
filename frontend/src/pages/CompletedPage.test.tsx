import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { CompletedPage } from './CompletedPage';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'task.status.done': 'Done',
        'common.search': 'Search...',
      };
      return translations[key] || key;
    },
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/services/api', () => ({
  boardsApi: {
    getAll: vi.fn().mockResolvedValue([
      { id: 'board-1', name: 'Board One', description: '', createdAt: '2024-01-01', updatedAt: '2024-01-01' },
      { id: 'board-2', name: 'Board Two', description: '', createdAt: '2024-01-01', updatedAt: '2024-01-01' },
    ]),
  },
  columnsApi: {
    getByBoard: vi.fn().mockImplementation((boardId: string) => {
      if (boardId === 'board-1') {
        return Promise.resolve([{
          id: 'col-1',
          boardId: 'board-1',
          name: 'Done',
          status: 'done',
          position: 0,
          color: '#3b82f6',
          tasks: [
            { id: 'task-1', title: 'Task 1', description: '', position: 0, priority: 'high', assignee: null, meta: null, columnId: 'todo', archived: false, archivedAt: null, published: true, createdBy: 'user-1', createdAt: '2024-01-01', updatedAt: '2024-01-01', comments: [], subtasks: [] },
          ],
          createdAt: '2024-01-01',
          updatedAt: '2024-01-01',
        }]);
      }
      if (boardId === 'board-2') {
        return Promise.resolve([{
          id: 'col-2',
          boardId: 'board-2',
          name: 'Done',
          status: 'done',
          position: 1,
          color: '#10b981',
          tasks: [
            { id: 'task-2', title: 'Task 2', description: '', position: 0, priority: 'medium', assignee: null, meta: null, columnId: 'in-progress', archived: false, archivedAt: null, published: true, createdBy: 'user-1', createdAt: '2024-01-01', updatedAt: '2024-01-01', comments: [], subtasks: [] },
          ],
          createdAt: '2024-01-01',
          updatedAt: '2024-01-01',
        }]);
      }
      return Promise.resolve([]);
    }),
  },
  tasksApi: {
    update: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
    create: vi.fn().mockResolvedValue({}),
    archive: vi.fn().mockResolvedValue({}),
    getById: vi.fn().mockResolvedValue({}),
  },
  setGlobalErrorHandler: vi.fn(),
}));

const renderCompletedPage = () => {
  return render(
    <BrowserRouter>
      <CompletedPage />
    </BrowserRouter>
  );
};

describe('CompletedPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders tasks with correct boardId from column.boardId when board is selected', async () => {
    renderCompletedPage();

    await waitFor(() => {
      expect(screen.getByText('Board One')).toBeInTheDocument();
    });

    const boardSelect = screen.getByRole('combobox');
    await userEvent.selectOptions(boardSelect, 'board-1');

    await waitFor(() => {
      expect(screen.getByText('Task 1')).toBeInTheDocument();
    });
  });

  it('uses column.boardId instead of parsing task.columnId', async () => {
    renderCompletedPage();

    await waitFor(() => {
      expect(screen.getByText('Board One')).toBeInTheDocument();
    });

    const boardSelect = screen.getByRole('combobox');
    await userEvent.selectOptions(boardSelect, 'board-1');

    await waitFor(() => {
      expect(screen.getByText('Task 1')).toBeInTheDocument();
    });

    const taskCard = screen.getByText('Task 1').closest('[class*="bg-white"]');
    expect(taskCard).toBeInTheDocument();
    expect(taskCard?.textContent).toContain('Board One');
  });

  it('renders tasks from multiple boards correctly', async () => {
    renderCompletedPage();

    await waitFor(() => {
      expect(screen.getByText('Board One')).toBeInTheDocument();
    });

    const boardSelect = screen.getByRole('combobox');

    await userEvent.selectOptions(boardSelect, 'board-1');
    await waitFor(() => {
      expect(screen.getByText('Task 1')).toBeInTheDocument();
    });

    await userEvent.selectOptions(boardSelect, 'board-2');
    await waitFor(() => {
      expect(screen.getByText('Task 2')).toBeInTheDocument();
    });
  });
});
