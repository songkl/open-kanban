import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { BrowserRouter, useNavigate } from 'react-router-dom';
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

// s-1218: cross-column drag-and-drop must persist the active task's
// new column_id. The earlier BoardPage.updateTaskPosition filter
// `task.id !== activeId` on the destination-column payload silently
// dropped the dragged task from the reorder request, so the next
// refresh (WebSocket or manual reload) snapped the card back to its
// original column. Capture the `updateTaskPosition` callback the page
// wires into ColumnBoard and assert the request body it builds for a
// cross-column move includes every task in the destination column —
// most importantly, the dragged task with its new columnId.
describe('BoardPage cross-column reorder (s-1218)', () => {
  const buildTask = (overrides: Partial<Task>): Task => ({
    id: 't',
    title: 'T',
    columnId: 'col-source',
    position: 0,
    published: true,
    archived: false,
    priority: 'medium',
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
    meta: null,
    ...overrides,
  });

  const sourceColumn: ColumnType = {
    ...defaultColumn,
    id: 'col-source',
    tasks: [
      buildTask({ id: 't1', title: 'T1', position: 0 }),
      buildTask({ id: 't2', title: 'T2', position: 1 }),
      buildTask({ id: 't3', title: 'T3', position: 2 }),
    ],
  };

  const destColumn: ColumnType = {
    ...defaultColumn,
    id: 'col-dest',
    name: 'Dest',
    tasks: [buildTask({ id: 't4', title: 'T4', position: 0, columnId: 'col-dest' })],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    capturedColumnBoardProps.current = null;
    boardStateMock.current = buildBoardStateMock({
      columns: [sourceColumn, destColumn],
    });
  });

  it('includes the dragged task in the reorder payload with the new columnId', async () => {
    const { tasksApi } = await import('../services/api');
    renderBoardPage();

    const props = capturedColumnBoardProps.current;
    expect(props?.updateTaskPosition).toBeDefined();
    const updateTaskPosition = props!.updateTaskPosition as unknown as (
      activeId: string,
      overId: string,
      activeColumn: ColumnType,
      overColumn: ColumnType,
      activeTask: Task,
    ) => Promise<void>;

    const draggedTask = buildTask({ id: 't3', title: 'T3', columnId: 'col-source', position: 2 });
    await updateTaskPosition('t3', 't4', sourceColumn, destColumn, draggedTask);

    expect(tasksApi.reorder).toHaveBeenCalledTimes(1);
    const payload = (tasksApi.reorder as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as Array<{
      id: string;
      columnId: string;
      position: number;
    }>;

    // The dragged task must show up in the destination column.
    const t3 = payload.find((item) => item.id === 't3');
    expect(t3).toBeDefined();
    expect(t3?.columnId).toBe('col-dest');

    // Tasks that stayed in the source column must still be reported.
    const t1 = payload.find((item) => item.id === 't1');
    const t2 = payload.find((item) => item.id === 't2');
    expect(t1?.columnId).toBe('col-source');
    expect(t2?.columnId).toBe('col-source');

    // The pre-existing destination task must remain in the destination column.
    const t4 = payload.find((item) => item.id === 't4');
    expect(t4?.columnId).toBe('col-dest');

    // No duplicates / no missing tasks.
    const payloadIds = payload.map((item) => item.id).sort();
    expect(payloadIds).toEqual(['t1', 't2', 't3', 't4']);
  });
});

void useNavigate;
