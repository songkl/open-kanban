import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { BoardPage } from './BoardPage';
import type { Board, Column as ColumnType, Task, User } from '../types/kanban';

class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
window.ResizeObserver = MockResizeObserver;

const mockNavigate = vi.fn();

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
    reset: vi.fn().mockResolvedValue({}),
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
    reorder: vi.fn().mockResolvedValue({}),
  },
  commentsApi: {
    create: vi.fn().mockResolvedValue({}),
  },
  authApi: {
    me: vi.fn().mockResolvedValue({ user: null, needsSetup: false }),
  },
  setGlobalErrorHandler: vi.fn(),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useParams: () => ({ boardId: 'board-1' }),
  };
});

vi.mock('../hooks/useSetupGuard', () => ({
  useSetupGuard: vi.fn(),
}));

// s-1218: capture the `updateTaskPosition` callback that BoardPage
// wires into ColumnBoard so we can drive it directly in unit tests
// without rendering the full DnD tree.
const capturedColumnBoardProps = vi.hoisted(() => ({
  current: null as null | { updateTaskPosition?: (...args: unknown[]) => Promise<void> },
}));

vi.mock('../components/ColumnBoard', () => ({
  ColumnBoard: (props: { updateTaskPosition?: (...args: unknown[]) => Promise<void> }) => {
    capturedColumnBoardProps.current = props;
    return <div data-testid="column-board-stub" />;
  },
}));

const defaultBoard: Board = {
  id: 'board-1',
  name: 'Test Board',
  description: 'A test board',
  createdAt: '2024-01-01',
  updatedAt: '2024-01-01',
  effectiveAccess: 'WRITE',
  isOwner: false,
};

const defaultUser: User = {
  id: 'user-1',
  nickname: 'Test User',
  avatar: null,
  role: 'MEMBER',
  type: 'HUMAN',
  enabled: true,
  createdAt: '2024-01-01',
  updatedAt: '2024-01-01',
};

const defaultColumn: ColumnType = {
  id: 'col-1',
  name: 'Todo',
  position: 0,
  color: '#cccccc',
  boardId: 'board-1',
  tasks: [] as Task[],
  createdAt: '2024-01-01',
  updatedAt: '2024-01-01',
};

const buildBoardStateMock = (overrides: Record<string, unknown> = {}) => {
  const noop = () => {};
  const noopAsync = async () => {};
  return {
    boards: [defaultBoard],
    currentBoard: defaultBoard,
    hasAccess: true,
    columns: [defaultColumn],
    activeTask: null,
    selectedTask: null,
    selectedTasks: new Set<string>(),
    lastSelectedTaskId: null,
    loading: false,
    boardSwitching: false,
    loadError: null,
    wsStatus: 'disconnected' as const,
    reconnectCount: 0,
    currentUser: defaultUser,
    filters: {
      priority: '',
      assignee: '',
      searchQuery: '',
      dateRange: '',
      tag: '',
      customField: { fieldId: '', value: '' },
      runStatus: '',
      hasComments: '',
      hasSubtasks: '',
    },
    filterPresets: [],
    columnPagination: {},
    searchQuery: '',
    uniqueAssignees: [] as string[],
    uniqueTags: [] as string[],
    uniqueCustomFieldValues: {},
    isInDateRange: () => true,
    getFilteredColumns: () => [defaultColumn],
    fetchBoards: vi.fn(noopAsync),
    fetchColumns: vi.fn(noopAsync),
    handleLoadMoreTasks: vi.fn(noopAsync),
    updateTask: vi.fn(noopAsync),
    deleteTask: vi.fn(noopAsync),
    archiveTask: vi.fn(noopAsync),
    addTask: vi.fn(noopAsync),
    addComment: vi.fn(noopAsync),
    handleTaskSelect: vi.fn(noop),
    selectAllInColumn: vi.fn(noop),
    clearSelection: vi.fn(noop),
    batchDelete: vi.fn(noopAsync),
    batchArchive: vi.fn(noopAsync),
    batchMove: vi.fn(noopAsync),
    batchUpdatePriority: vi.fn(noopAsync),
    batchUpdateAssignee: vi.fn(noopAsync),
    handleColumnRename: vi.fn(noopAsync),
    setSelectedTask: vi.fn(noop),
    setActiveTask: vi.fn(noop),
    setFilters: vi.fn(noop),
    setFilterPresets: vi.fn(noop),
    setSearchQuery: vi.fn(noop),
    setColumnPagination: vi.fn(noop),
    saveCurrentAsPreset: vi.fn(noop),
    applyPreset: vi.fn(noop),
    deletePreset: vi.fn(noop),
    clearFilters: vi.fn(noop),
    clearSingleFilter: vi.fn(noop),
    hasActiveFilters: false,
    activeFilterCount: 0,
    handleTaskNotificationUpdate: vi.fn(noopAsync),
    lastLocalUpdateRef: { current: 0 },
    offlineQueueRef: { current: [] },
    isProcessingQueueRef: { current: false },
    processOfflineQueue: vi.fn(noopAsync),
    setColumns: vi.fn(noop),
    ...overrides,
  };
};

const { boardStateMock } = vi.hoisted(() => ({
  boardStateMock: { current: null as unknown },
}));

vi.mock('../hooks/useBoardState', () => ({
  useBoardState: () => boardStateMock.current,
}));

const renderBoardPage = () =>
  render(
    <BrowserRouter>
      <BoardPage />
    </BrowserRouter>,
  );

describe('BoardPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    boardStateMock.current = buildBoardStateMock();
  });

  it('renders loading skeleton while loading', () => {
    boardStateMock.current = buildBoardStateMock({
      loading: true,
      currentBoard: null,
      hasAccess: false,
      columns: [],
    });

    renderBoardPage();

    expect(document.body.querySelector('[class*="animate-pulse"]')).toBeInTheDocument();
  });

  it('renders normal board content when user has access', () => {
    boardStateMock.current = buildBoardStateMock({
      hasAccess: true,
      currentBoard: defaultBoard,
    });

    renderBoardPage();

    expect(screen.queryByText('board.noAccess')).not.toBeInTheDocument();
    expect(screen.queryByText('board.noAccessHint')).not.toBeInTheDocument();
    expect(screen.queryByText('board.goBackToList')).not.toBeInTheDocument();
  });

  it('renders no-access prompt when currentBoard has empty effectiveAccess', () => {
    const noAccessBoard: Board = {
      ...defaultBoard,
      id: 'board-locked',
      name: 'Locked Board',
      effectiveAccess: '',
      isOwner: false,
    };
    boardStateMock.current = buildBoardStateMock({
      currentBoard: noAccessBoard,
      hasAccess: false,
      boards: [noAccessBoard],
      columns: [],
    });

    renderBoardPage();

    expect(screen.getByText('board.noAccess')).toBeInTheDocument();
    expect(screen.getByText('board.noAccessHint')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'board.goBackToList' })).toBeInTheDocument();
  });

  it('renders no-access prompt when currentBoard is non-owner without effective access', () => {
    const noAccessBoard: Board = {
      ...defaultBoard,
      effectiveAccess: '',
      isOwner: false,
    };
    boardStateMock.current = buildBoardStateMock({
      currentBoard: noAccessBoard,
      hasAccess: false,
      columns: [],
    });

    renderBoardPage();

    expect(screen.getByText('board.noAccess')).toBeInTheDocument();
  });

  it('navigates to /boards when back button is clicked in no-access state', async () => {
    const noAccessBoard: Board = {
      ...defaultBoard,
      effectiveAccess: '',
      isOwner: false,
    };
    boardStateMock.current = buildBoardStateMock({
      currentBoard: noAccessBoard,
      hasAccess: false,
      columns: [],
    });

    renderBoardPage();

    const backButton = screen.getByRole('button', { name: 'board.goBackToList' });
    fireEvent.click(backButton);

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/boards');
    });
  });

  it('does not show no-access prompt while loading (avoids flash)', () => {
    const noAccessBoard: Board = {
      ...defaultBoard,
      effectiveAccess: '',
      isOwner: false,
    };
    boardStateMock.current = buildBoardStateMock({
      loading: true,
      currentBoard: noAccessBoard,
      hasAccess: false,
      columns: [],
    });

    renderBoardPage();

    expect(document.body.querySelector('[class*="animate-pulse"]')).toBeInTheDocument();
    expect(screen.queryByText('board.noAccess')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'board.goBackToList' })).not.toBeInTheDocument();
  });

  it('renders without crashing when all required state is provided', () => {
    renderBoardPage();
    expect(document.body).toBeInTheDocument();
  });

  // s-1226: the AppShell renders the dark-mode toggle and notification
  // bell at top-4 right-4 over the page content. The board header is
  // dense (BoardSelector + BoardToolbar + user menu) and the create
  // button lives in the toolbar, so without right padding the toolbar
  // would slide under the floating overlay. Reserve enough right padding
  // on the header so the page-level controls stay clear of the overlay.
  // s-1230: bumped mobile right padding from pr-20 (80px) to pr-24
  // (96px) and desktop from sm:pr-24 (96px) to sm:pr-32 (128px) so the
  // create button + right-side action group stop crowding the floating
  // overlay (theme toggle + notification bell) above them.
  it('reserves right padding on the board header to clear the AppShell overlay (s-1226)', () => {
    renderBoardPage();

    const banner = screen.getByRole('banner');
    expect(banner).toBeInTheDocument();
    const className = banner.className;
    // Mobile (< 640px) — no AppShell sidebar, but the overlay is still
    // there, so we still need padding.
    expect(className).toMatch(/\bpr-24\b/);
    // Desktop (>= 640px) — need a bit more room because the BoardToolbar
    // (search / filter / density / create button) also lives in the
    // header on the same row as the overlay.
    expect(className).toMatch(/\bsm:pr-32\b/);
  });

  it('invokes fetchBoards when retry button is clicked in loadError state', async () => {
    const fetchBoards = vi.fn().mockResolvedValue(undefined);
    boardStateMock.current = buildBoardStateMock({
      loadError: 'Failed to load board',
      currentBoard: null,
      hasAccess: false,
      columns: [],
      fetchBoards,
    });

    renderBoardPage();

    const retryButton = screen.getByRole('button', { name: 'app.error.retry' });
    expect(retryButton).toBeInTheDocument();

    fireEvent.click(retryButton);

    await waitFor(() => {
      expect(fetchBoards).toHaveBeenCalledTimes(1);
    });
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
