import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { BoardPage } from './BoardPage';

class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
window.ResizeObserver = MockResizeObserver;

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/services/api', () => ({
  boardsApi: {
    getAll: vi.fn().mockResolvedValue([]),
    export: vi.fn().mockResolvedValue({ ok: true, blob: () => Promise.resolve(new Blob()) }),
  },
  columnsApi: {
    getByBoard: vi.fn().mockResolvedValue([]),
  },
  tasksApi: {
    update: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
    create: vi.fn().mockResolvedValue({}),
    archive: vi.fn().mockResolvedValue({}),
    getById: vi.fn().mockResolvedValue({}),
    getByColumn: vi.fn().mockResolvedValue({ data: [], pageCount: 1 }),
  },
  commentsApi: {
    create: vi.fn().mockResolvedValue({}),
  },
  authApi: {
    me: vi.fn().mockResolvedValue({ user: null, needsSetup: false }),
  },
  setGlobalErrorHandler: vi.fn(),
}));

vi.mock('@/hooks/useBoardWebSocket', () => ({
  useBoardWebSocket: () => ({
    wsStatus: 'disconnected' as const,
    reconnectCount: 0,
    connectWebSocket: vi.fn(),
  }),
}));

describe('BoardPage', () => {
  it('renders loading skeleton initially', () => {
    render(
      <BrowserRouter>
        <BoardPage />
      </BrowserRouter>
    );
    expect(document.body.querySelector('[class*="animate-pulse"]')).toBeInTheDocument();
  });

  it('renders without crashing', () => {
    render(
      <BrowserRouter>
        <BoardPage />
      </BrowserRouter>
    );
    expect(document.body).toBeInTheDocument();
  });
});

describe('BoardPage error state', () => {
  it('wires retry button onClick to fetchBoards when loadError is set', async () => {
    vi.resetModules();
    const fetchBoardsMock = vi.fn();
    vi.doMock('@/hooks/useBoardState', () => ({
      useBoardState: () => ({
        boards: [],
        currentBoard: null,
        columns: [],
        activeTask: null,
        selectedTask: null,
        selectedTasks: new Set(),
        lastSelectedTaskId: null,
        loading: false,
        boardSwitching: false,
        loadError: 'network down',
        wsStatus: 'disconnected',
        reconnectCount: 0,
        currentUser: null,
        filters: {},
        filterPresets: [],
        columnPagination: {},
        searchQuery: '',
        uniqueAssignees: [],
        uniqueTags: [],
        getFilteredColumns: () => [],
        fetchBoards: fetchBoardsMock,
        fetchColumns: vi.fn(),
        handleLoadMoreTasks: vi.fn(),
        updateTask: vi.fn(),
        deleteTask: vi.fn(),
        archiveTask: vi.fn(),
        addTask: vi.fn(),
        addComment: vi.fn(),
        handleTaskSelect: vi.fn(),
        selectAllInColumn: vi.fn(),
        clearSelection: vi.fn(),
        batchDelete: vi.fn(),
        batchArchive: vi.fn(),
        batchMove: vi.fn(),
        batchUpdatePriority: vi.fn(),
        batchUpdateAssignee: vi.fn(),
        handleColumnRename: vi.fn(),
        setSelectedTask: vi.fn(),
        setActiveTask: vi.fn(),
        setFilters: vi.fn(),
        setSearchQuery: vi.fn(),
        saveCurrentAsPreset: vi.fn(),
        applyPreset: vi.fn(),
        deletePreset: vi.fn(),
        clearFilters: vi.fn(),
        hasActiveFilters: false,
        lastLocalUpdateRef: { current: 0 },
        setColumns: vi.fn(),
      }),
    }));
    const { BoardPage: BoardPageWithError } = await import('./BoardPage');
    render(
      <BrowserRouter>
        <BoardPageWithError />
      </BrowserRouter>
    );
    const retryButton = screen.getByText('app.error.retry');
    expect(retryButton).toBeInTheDocument();
    fireEvent.click(retryButton);
    expect(fetchBoardsMock).toHaveBeenCalledTimes(1);
  });
});
