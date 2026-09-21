import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RunsPage } from './RunsPage';
import { useRunStore } from '../store/runStore';
import type { TaskRun } from '../types/kanban';

vi.mock('@/services/api', () => ({
  runsApi: {
    getByTask: vi.fn().mockResolvedValue(null),
  },
}));

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = 0;
  url: string;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }
  send(): void {}
  close(): void {
    this.readyState = 3;
    if (this.onclose) this.onclose(new CloseEvent('close'));
  }
  triggerOpen(): void {
    this.readyState = 1;
    if (this.onopen) this.onopen(new Event('open'));
  }
}

const buildLiveRun = (overrides: Partial<TaskRun> = {}): TaskRun => ({
  id: 'run-1',
  taskId: 'task-1',
  runnerId: 'runner-1',
  agentId: 'agent-1',
  status: 'running',
  claimedAt: new Date().toISOString(),
  lastHeartbeatAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  finishedAt: null,
  exitCode: null,
  error: null,
  ...overrides,
});

describe('RunsPage fullscreen toggle (s-1281)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockWebSocket.instances = [];
    (globalThis as unknown as { WebSocket: typeof MockWebSocket }).WebSocket =
      MockWebSocket as unknown as typeof WebSocket;
    useRunStore.getState().clearAll();
  });

  afterEach(() => {
    useRunStore.getState().clearAll();
  });

  function renderPage() {
    return render(
      <MemoryRouter>
        <RunsPage />
      </MemoryRouter>
    );
  }

  it('renders the page chrome (title, subtitle, back link) by default', () => {
    renderPage();
    expect(screen.getByText('runs.pageTitle')).toBeInTheDocument();
    expect(screen.getByText('runs.subtitle')).toBeInTheDocument();
    expect(screen.getByText(/nav\.back/i)).toBeInTheDocument();
  });

  it('exposes the fullscreen toggle with aria-pressed=false initially', () => {
    renderPage();
    const toggle = screen.getByTestId('runs-fullscreen-toggle');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(toggle).toHaveTextContent('runs.enterFullscreen');
  });

  it('hides the page chrome and shows the exit label after clicking fullscreen', () => {
    renderPage();
    const toggle = screen.getByTestId('runs-fullscreen-toggle');

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(toggle).toHaveTextContent('runs.exitFullscreen');
    // Page header chrome is hidden in fullscreen so the page can sit
    // on a wall display without distractions.
    expect(screen.queryByText('runs.pageTitle')).not.toBeInTheDocument();
    expect(screen.queryByText('runs.subtitle')).not.toBeInTheDocument();
    expect(screen.queryByText(/nav\.back/i)).not.toBeInTheDocument();
  });

  it('restores the page chrome after exiting fullscreen', () => {
    renderPage();
    const toggle = screen.getByTestId('runs-fullscreen-toggle');

    fireEvent.click(toggle);
    expect(screen.queryByText('runs.pageTitle')).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(toggle).toHaveTextContent('runs.enterFullscreen');
    expect(screen.getByText('runs.pageTitle')).toBeInTheDocument();
    expect(screen.getByText('runs.subtitle')).toBeInTheDocument();
    expect(screen.getByText(/nav\.back/i)).toBeInTheDocument();
  });

  it('keeps the ws status pill and the fullscreen toggle visible in fullscreen mode', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('runs-fullscreen-toggle'));

    expect(screen.getByTestId('runs-ws-status')).toBeInTheDocument();
    expect(screen.getByTestId('runs-fullscreen-toggle')).toBeInTheDocument();
    expect(screen.getByTestId('runs-live-section')).toBeInTheDocument();
    expect(screen.getByTestId('runs-recent-section')).toBeInTheDocument();
  });

  it('renders a live run card and widens the grid in fullscreen mode', async () => {
    act(() => {
      useRunStore.getState().setRun('task-1', buildLiveRun());
      useRunStore.getState().setRun('task-2', buildLiveRun({ id: 'run-2', taskId: 'task-2', runnerId: 'runner-2' }));
      useRunStore.getState().setRun('task-3', buildLiveRun({ id: 'run-3', taskId: 'task-3', runnerId: 'runner-3' }));
    });

    renderPage();
    expect(screen.getAllByTestId('runs-live-card')).toHaveLength(3);

    fireEvent.click(screen.getByTestId('runs-fullscreen-toggle'));

    const list = screen.getByTestId('runs-live-section').querySelector('ul');
    expect(list).not.toBeNull();
    expect(list?.className).toMatch(/xl:grid-cols-5/);
  });
});
