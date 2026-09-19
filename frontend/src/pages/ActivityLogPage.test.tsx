import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { ActivityLogPage } from './ActivityLogPage';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (key === 'filter.appliedCount_other' && params) {
        const count = params.count as number;
        return `${count} ${count === 1 ? 'filter' : 'filters'} applied`;
      }
      if (key === 'filter.appliedCount_one' && params) {
        const count = params.count as number;
        return `${count} filter applied`;
      }
      if (key === 'filter.removeFilter' && params) {
        return `Remove ${params.label}`;
      }
      return key;
    },
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/services/api', () => ({
  authApi: {
    me: vi.fn().mockResolvedValue({
      user: { id: 'user-1', username: 'alice', nickname: 'Alice', avatar: null, type: 'HUMAN', role: 'ADMIN', enabled: true },
    }),
    getUsers: vi.fn().mockResolvedValue([]),
  },
  tasksApi: {
    getById: vi.fn(),
    getByColumn: vi.fn().mockResolvedValue({ data: [] }),
  },
  commentsApi: {
    getById: vi.fn(),
  },
  boardsApi: {
    getAll: vi.fn().mockResolvedValue([
      { id: 'board-1', name: 'Board One', createdAt: '2024-01-01', updatedAt: '2024-01-01' },
    ]),
  },
  columnsApi: {
    getByBoard: vi.fn().mockResolvedValue([
      { id: 'col-1', name: 'Todo', boardId: 'board-1', status: 'todo', position: 0, color: '#3b82f6', tasks: [], createdAt: '2024-01-01', updatedAt: '2024-01-01' },
    ]),
  },
  activitiesApi: {
    getAll: vi.fn().mockResolvedValue({ activities: [], total: 0 }),
    exportCsv: vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'content-disposition'
            ? 'attachment; filename=activity_log_test.csv'
            : null,
      },
      blob: () => Promise.resolve(new Blob(['col\nval\n'])),
    }),
  },
  ApiError: class ApiError extends Error {},
  setGlobalErrorHandler: vi.fn(),
}));

// jsdom does not implement anchor.click() for downloads; provide a
// stub so the export flow can run without errors.
if (typeof HTMLAnchorElement !== 'undefined') {
  HTMLAnchorElement.prototype.click = vi.fn();
}

const renderPage = () =>
  render(
    <BrowserRouter>
      <ActivityLogPage />
    </BrowserRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ActivityLogPage scope filters + CSV export (s-1208)', () => {
  it('renders the CSV export button next to the record count', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('activity-log-export-csv')).toBeInTheDocument();
    });
    expect(screen.getByTestId('activity-log-export-csv')).toHaveTextContent(
      'activityLog.exportCsv',
    );
  });

  it('does not render the applied-filter chip row when no filter is set', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('activity-log-export-csv')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('activity-log-applied-filters')).toBeNull();
  });

  it('passes the selected board/column/task filters to the activities API', async () => {
    const apiModule = await import('@/services/api');
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('activity-log-export-csv')).toBeInTheDocument();
    });

    const boardSelect = screen.getByTestId('activity-log-filter-board') as HTMLSelectElement;
    await userEvent.selectOptions(boardSelect, 'board-1');
    const columnSelect = screen.getByTestId('activity-log-filter-column') as HTMLSelectElement;
    await userEvent.selectOptions(columnSelect, 'col-1');

    await waitFor(() => {
      const lastCall = vi.mocked(apiModule.activitiesApi.getAll).mock.calls.at(-1)?.[0] || {};
      expect(lastCall).toMatchObject({ boardId: 'board-1', columnId: 'col-1' });
    });
  });

  it('renders the applied-filter chip row with the correct count', async () => {
    const apiModule = await import('@/services/api');
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('activity-log-export-csv')).toBeInTheDocument();
    });

    const boardSelect = screen.getByTestId('activity-log-filter-board') as HTMLSelectElement;
    await userEvent.selectOptions(boardSelect, 'board-1');

    await waitFor(() => {
      expect(screen.getByTestId('activity-log-applied-filters')).toBeInTheDocument();
    });
    expect(screen.getByText('1 filter applied')).toBeInTheDocument();

    vi.mocked(apiModule.activitiesApi.getAll).mockClear();
    const columnSelect = screen.getByTestId('activity-log-filter-column') as HTMLSelectElement;
    await userEvent.selectOptions(columnSelect, 'col-1');
    await waitFor(() => {
      expect(screen.getByText('2 filters applied')).toBeInTheDocument();
    });
  });

  it('triggers the CSV export with the active filters when the export button is clicked', async () => {
    const apiModule = await import('@/services/api');
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('activity-log-export-csv')).toBeInTheDocument();
    });

    const boardSelect = screen.getByTestId('activity-log-filter-board') as HTMLSelectElement;
    await userEvent.selectOptions(boardSelect, 'board-1');
    await waitFor(() => {
      expect(screen.getByTestId('activity-log-applied-filters')).toBeInTheDocument();
    });

    const exportBtn = screen.getByTestId('activity-log-export-csv');
    await userEvent.click(exportBtn);

    await waitFor(() => {
      expect(apiModule.activitiesApi.exportCsv).toHaveBeenCalledWith(
        expect.objectContaining({ boardId: 'board-1' }),
      );
    });
  });
});
