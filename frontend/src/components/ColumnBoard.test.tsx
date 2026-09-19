import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { ColumnBoard } from './ColumnBoard';
import type { Board, Column as ColumnType, Task } from '@/types/kanban';

class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
if (typeof window !== 'undefined' && !window.ResizeObserver) {
  window.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
}

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => children,
  DragOverlay: ({ children }: { children: React.ReactNode }) => (children ? <>{children}</> : null),
  closestCenter: {},
  useSensor: () => ({}),
  useSensors: () => [],
  useDroppable: () => ({ setNodeRef: vi.fn(), isOver: false }),
  PointerSensor: {},
  TouchSensor: {},
  KeyboardSensor: {},
  DragStartEvent: class {},
  DragEndEvent: class {},
}));

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => children,
  verticalListSortingStrategy: {},
  sortableKeyboardCoordinates: {},
  arrayMove: <T,>(arr: T[], from: number, to: number): T[] => {
    const copy = [...arr];
    const [item] = copy.splice(from, 1);
    copy.splice(to, 0, item);
    return copy;
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (params?.count !== undefined) return `${key}:${String(params.count)}`;
      return key;
    },
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('@/services/api', () => ({
  boardsApi: { getAll: vi.fn().mockResolvedValue([]), export: vi.fn(), reset: vi.fn() },
  columnsApi: { getByBoard: vi.fn().mockResolvedValue([]) },
  tasksApi: {
    create: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
    archive: vi.fn().mockResolvedValue({}),
    getById: vi.fn().mockResolvedValue({}),
    getByColumn: vi.fn().mockResolvedValue({ data: [], pageCount: 1 }),
    reorder: vi.fn().mockResolvedValue({}),
  },
  commentsApi: { create: vi.fn().mockResolvedValue({}) },
  authApi: { me: vi.fn().mockResolvedValue({ user: null, needsSetup: false }) },
  setGlobalErrorHandler: vi.fn(),
}));

const buildColumns = (): ColumnType[] => [
  {
    id: 'col-1',
    name: 'Todo',
    position: 0,
    color: '#3b82f6',
    tasks: [] as Task[],
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
  },
  {
    id: 'col-2',
    name: 'In Progress',
    position: 1,
    color: '#f59e0b',
    tasks: [] as Task[],
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
  },
  {
    id: 'col-3',
    name: 'Done',
    position: 2,
    color: '#22c55e',
    tasks: [] as Task[],
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
  },
];

const defaultBoard: Board = {
  id: 'board-1',
  name: 'Test Board',
  createdAt: '2024-01-01',
  updatedAt: '2024-01-01',
};

const noopAsync = async () => {};
const noop = () => {};

const defaultProps = () => ({
  columns: buildColumns(),
  currentBoard: defaultBoard,
  boards: [defaultBoard],
  boardIdFromUrl: 'board-1',
  activeTask: null,
  selectedTask: null,
  selectedTasks: new Set<string>(),
  columnPagination: {},
  filters: { searchQuery: '', priority: '', assignee: '', dateRange: '', tag: '' },
  showAddTaskModal: false,
  defaultColumnIdForNewTask: undefined,
  editTaskId: null,
  onAddTask: vi.fn(noopAsync),
  onUpdateTask: vi.fn(noopAsync),
  onDeleteTask: vi.fn(noopAsync),
  onArchiveTask: vi.fn(noopAsync),
  onMoveToColumn: vi.fn(noopAsync),
  onAddComment: vi.fn(noopAsync),
  onTaskSelect: vi.fn(noop),
  onSelectAllTasks: vi.fn(noop),
  onLoadMoreTasks: vi.fn(noop),
  onColumnRename: vi.fn(noopAsync),
  onSetSelectedTask: vi.fn(noop),
  onSetActiveTask: vi.fn(noop),
  onSetShowAddTaskModal: vi.fn(noop),
  onSetDefaultColumnIdForNewTask: vi.fn(noop),
  onSetEditTaskId: vi.fn(noop),
  getFilteredColumns: () => buildColumns(),
  updateTaskPosition: vi.fn(noopAsync),
  canCreateTaskInColumn: () => true,
});

const renderWithRouter = (ui: React.ReactElement) =>
  render(<BrowserRouter>{ui}</BrowserRouter>);

describe('ColumnBoard mobile layout (s-1192)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a tab bar with each column name on mobile', () => {
    renderWithRouter(<ColumnBoard {...defaultProps()} isMobile={true} />);
    const tabs = screen.getAllByRole('button', { name: /Todo|In Progress|Done/ });
    expect(tabs.length).toBeGreaterThanOrEqual(3);
    expect(tabs[0]).toHaveTextContent('Todo');
    expect(tabs[1]).toHaveTextContent('In Progress');
    expect(tabs[2]).toHaveTextContent('Done');
  });

  it('marks only the first tab as active by default', () => {
    renderWithRouter(<ColumnBoard {...defaultProps()} isMobile={true} />);
    const tabs = screen.getAllByRole('button', { name: /Todo|In Progress|Done/ });
    expect(tabs[0]).toHaveAttribute('aria-pressed', 'true');
    expect(tabs[1]).toHaveAttribute('aria-pressed', 'false');
  });

  it('switches the active tab when a different column is tapped', () => {
    renderWithRouter(<ColumnBoard {...defaultProps()} isMobile={true} />);
    fireEvent.click(screen.getByRole('button', { name: 'In Progress' }));
    expect(screen.getByRole('button', { name: 'In Progress' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Todo' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('exposes >= 36px tap targets on each tab button', () => {
    renderWithRouter(<ColumnBoard {...defaultProps()} isMobile={true} />);
    const tab = screen.getByRole('button', { name: 'Todo' });
    expect(tab.className).toContain('min-h-[36px]');
    expect(tab.className).toContain('min-w-[44px]');
  });

  it('exposes a labelled toggle button to switch between tabs and slide views', () => {
    renderWithRouter(<ColumnBoard {...defaultProps()} isMobile={true} />);
    const toggle = screen.getByRole('button', { name: /mobile\.switchToSlideView/i });
    expect(toggle.className).toContain('min-h-[36px]');
    expect(toggle.className).toContain('min-w-[36px]');
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: /mobile\.switchToListView/i })).toBeInTheDocument();
  });

  it('does not render the mobile tab bar on desktop', () => {
    renderWithRouter(<ColumnBoard {...defaultProps()} isMobile={false} />);
    expect(screen.queryByRole('button', { name: /mobile\.switchToSlideView/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /mobile\.switchToListView/i })).not.toBeInTheDocument();
  });
});