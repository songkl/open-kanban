import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { RunHistoryPage } from './RunHistoryPage';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const translations: Record<string, string> = {
        'app.loading': 'Loading...',
        'app.error.loadFailed': 'Failed to load',
        'app.error.retry': 'Retry',
        'app.error.unauthorized': 'Please login first',
        'common.back': 'Back',
        'filter.filter': 'Filter',
        'filter.all': 'All',
        'filter.today': 'Today',
        'filter.thisWeek': 'This Week',
        'filter.thisMonth': 'This Month',
        'filter.clear': 'Clear',
        'runs.title': 'Run History',
        'runs.empty': 'No terminal runs yet.',
        'runs.emptyFiltered': 'No runs match the current filters.',
        'runs.searchPlaceholder': 'Search task title / id / runner',
        'runs.refresh': 'Refresh',
        'runs.runner': 'Runner',
        'runs.status': 'Status',
        'runs.statusCompleted': 'Completed',
        'runs.statusFailed': 'Failed',
        'runs.statusReleased': 'Released',
        'runs.count': '{{shown}} / {{total}} runs',
        'runs.column.time': 'Time',
        'runs.column.taskTitle': 'Task Title',
        'runs.column.runner': 'Runner',
        'runs.column.status': 'Status',
        'runs.column.duration': 'Duration',
        'runs.column.error': 'Error',
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

const sampleRuns = [
  {
    taskId: 'task-1',
    runnerId: 'runner-A',
    agentId: 'opencoder',
    boardId: 'sys',
    columnId: 'col-1',
    status: 'completed' as const,
    claimedAt: '2024-05-15T10:00:00Z',
    lastHeartbeatAt: '2024-05-15T10:01:30Z',
    expiresAt: '2024-05-15T10:05:00Z',
    finishedAt: '2024-05-15T10:01:30Z',
    exitCode: 0,
    error: null,
  },
  {
    taskId: 'task-2',
    runnerId: 'runner-B',
    agentId: 'opencoder',
    boardId: 'sys',
    columnId: 'col-1',
    status: 'failed' as const,
    claimedAt: '2024-05-15T11:00:00Z',
    lastHeartbeatAt: '2024-05-15T11:02:00Z',
    expiresAt: '2024-05-15T11:05:00Z',
    finishedAt: '2024-05-15T11:02:00Z',
    exitCode: 1,
    error: 'boom: agent exited with code 1',
  },
  {
    taskId: 'task-3',
    runnerId: 'runner-A',
    agentId: 'opencoder',
    boardId: 'sys',
    columnId: 'col-1',
    status: 'released' as const,
    claimedAt: '2024-05-15T12:00:00Z',
    lastHeartbeatAt: '2024-05-15T12:00:30Z',
    expiresAt: '2024-05-15T12:02:00Z',
    finishedAt: '2024-05-15T12:02:00Z',
    exitCode: null,
    error: 'lock expired',
  },
];

const mockList = vi.fn();
const mockGetById = vi.fn();

vi.mock('@/services/api', () => ({
  runsApi: {
    list: (...args: unknown[]) => mockList(...args),
    getByTask: vi.fn(),
  },
  tasksApi: {
    getById: (...args: unknown[]) => mockGetById(...args),
  },
  authApi: {
    me: vi.fn().mockResolvedValue({
      user: { id: 'u1', nickname: 'admin', role: 'ADMIN', type: 'HUMAN', enabled: true },
      needsSetup: false,
    }),
  },
}));

vi.mock('@/hooks/useSetupGuard', () => ({
  useSetupGuard: () => undefined,
}));

type Listener<T> = (event: { data: T }) => void;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  url: string;
  readyState: number = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: Listener<string> | null = null;
  sentFrames: string[] = [];

  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (this.onopen) this.onopen();
    });
  }

  send(data: string): void {
    this.sentFrames.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    if (this.onclose) this.onclose();
  }

  // Test helpers -----------------------------------------------------
  emit(data: string): void {
    if (this.onmessage) this.onmessage({ data });
  }

  emitJson(payload: unknown): void {
    this.emit(JSON.stringify(payload));
  }

  emitError(): void {
    if (this.onerror) this.onerror();
  }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWebSocket.instances = [];
});

const renderPage = () =>
  render(
    <BrowserRouter>
      <RunHistoryPage />
    </BrowserRouter>
  );

describe('RunHistoryPage', () => {
  beforeEach(() => {
    mockList.mockReset();
    mockGetById.mockReset();
    mockList.mockResolvedValue(sampleRuns);
    mockGetById.mockImplementation((id: string) => {
      if (id === 'task-1') return Promise.resolve({ id, title: 'Implement login page' });
      if (id === 'task-2') return Promise.resolve({ id, title: 'Fix flaky test' });
      if (id === 'task-3') return Promise.resolve({ id, title: 'Refactor runner loop' });
      return Promise.reject(new Error('not found'));
    });
  });

  it('renders loading state initially', () => {
    mockList.mockImplementation(() => new Promise(() => undefined));
    renderPage();
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('renders table rows with task titles, runner, status, duration, and error', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Implement login page')).toBeInTheDocument();
    });

    const table = screen.getByRole('table');
    const rows = within(table).getAllByRole('row');
    expect(rows.length).toBe(4);

    const bodyRow1 = rows[1];
    expect(within(bodyRow1).getByText('Implement login page')).toBeInTheDocument();
    expect(within(bodyRow1).getByText('runner-A')).toBeInTheDocument();
    expect(within(bodyRow1).getByText('Completed')).toBeInTheDocument();

    const bodyRow2 = rows[2];
    expect(within(bodyRow2).getByText('Fix flaky test')).toBeInTheDocument();
    expect(within(bodyRow2).getByText('runner-B')).toBeInTheDocument();
    expect(within(bodyRow2).getByText('Failed')).toBeInTheDocument();
    expect(within(bodyRow2).getByText('boom: agent exited with code 1')).toBeInTheDocument();
  });

  it('shows count of runs shown and total', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('3 / 3 runs')).toBeInTheDocument();
    });
  });

  it('filters runs by status when selecting a status filter', async () => {
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Implement login page')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /Filter/i }));

    const statusFilter = await screen.findByLabelText('Status');
    await user.click(statusFilter);
    const failedOption = await screen.findByRole('option', { name: 'Failed' });
    await user.click(failedOption);

    await waitFor(() => {
      expect(screen.getByText('1 / 3 runs')).toBeInTheDocument();
    });
    expect(screen.queryByText('Implement login page')).not.toBeInTheDocument();
    expect(screen.getByText('Fix flaky test')).toBeInTheDocument();
  });

  it('filters runs by search query', async () => {
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Implement login page')).toBeInTheDocument();
    });

    const search = screen.getByPlaceholderText('Search task title / id / runner');
    await user.type(search, 'runner-B');

    await waitFor(() => {
      expect(screen.getByText('1 / 3 runs')).toBeInTheDocument();
    });
    expect(screen.getByText('Fix flaky test')).toBeInTheDocument();
    expect(screen.queryByText('Implement login page')).not.toBeInTheDocument();
  });

  it('shows the empty state when there are no runs', async () => {
    mockList.mockResolvedValue([]);
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('No terminal runs yet.')).toBeInTheDocument();
    });
    expect(screen.getByText('0 / 0 runs')).toBeInTheDocument();
  });

  it('shows filtered empty state when filters hide everything', async () => {
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Implement login page')).toBeInTheDocument();
    });

    const search = screen.getByPlaceholderText('Search task title / id / runner');
    await user.type(search, 'no-such-thing');

    await waitFor(() => {
      expect(screen.getByText('No runs match the current filters.')).toBeInTheDocument();
    });
  });

  it('renders an error state with retry when the API call fails', async () => {
    mockList.mockRejectedValueOnce(new Error('boom'));
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Failed to load')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('renders a back link to the root', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Back' })).toBeInTheDocument();
    });
  });

  it('opens a WebSocket on mount and refreshes when a finish notification arrives', async () => {
    renderPage();

    // First fetch happens in the mount effect.
    await waitFor(() => {
      expect(screen.getByText('Implement login page')).toBeInTheDocument();
    });
    const initialCalls = mockList.mock.calls.length;

    // The page should have opened exactly one WebSocket.
    expect(FakeWebSocket.instances).toHaveLength(1);
    const ws = FakeWebSocket.instances[0];

    // Simulate the backend broadcasting a finish notification.
    ws.emitJson({ type: 'task_notification', boardId: 'sys', taskId: 'task-X', action: 'finish' });

    // Debounced refresh should trigger another list call within ~500ms.
    await waitFor(() => {
      expect(mockList.mock.calls.length).toBeGreaterThan(initialCalls);
    });
  });

  it('refreshes when a release notification arrives', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Implement login page')).toBeInTheDocument();
    });
    const initialCalls = mockList.mock.calls.length;
    const ws = FakeWebSocket.instances[0];

    ws.emitJson({ type: 'task_notification', boardId: 'sys', taskId: 'task-Y', action: 'release' });

    await waitFor(() => {
      expect(mockList.mock.calls.length).toBeGreaterThan(initialCalls);
    });
  });

  it('ignores task_notification actions that do not represent a terminal run', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Implement login page')).toBeInTheDocument();
    });
    const initialCalls = mockList.mock.calls.length;
    const ws = FakeWebSocket.instances[0];

    ws.emitJson({ type: 'task_notification', boardId: 'sys', taskId: 'task-Z', action: 'update_status' });
    ws.emitJson({ type: 'task_notification', boardId: 'sys', taskId: 'task-Z', action: 'attach' });
    ws.emitJson({ type: 'heartbeat_ack' });

    // Allow microtasks + any debounced timers to flush.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockList.mock.calls.length).toBe(initialCalls);
  });

  it('ignores malformed WebSocket frames', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Implement login page')).toBeInTheDocument();
    });
    const initialCalls = mockList.mock.calls.length;
    const ws = FakeWebSocket.instances[0];

    ws.emit('not-json');
    ws.emitJson({ type: 'unknown' });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockList.mock.calls.length).toBe(initialCalls);
  });
});