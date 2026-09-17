import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useBoardTaskRuns } from './useBoardTaskRuns';
import { useRunStore } from '../store/runStore';

vi.mock('@/services/api', () => ({
  runsApi: {
    getByTask: vi.fn(),
  },
}));

import { runsApi } from '@/services/api';

const mockedGetByTask = runsApi.getByTask as unknown as ReturnType<typeof vi.fn>;

const buildRun = (overrides: Partial<Parameters<typeof useRunStore.getState>[0]['runs'][string]> = {}) => ({
  id: 'run-1',
  taskId: 'task-1',
  runnerId: 'runner-1',
  agentId: null,
  status: 'claimed' as const,
  claimedAt: '2026-09-17T10:00:00.000Z',
  lastHeartbeatAt: '2026-09-17T10:00:00.000Z',
  expiresAt: '2026-09-17T10:02:00.000Z',
  finishedAt: null,
  exitCode: null,
  error: null,
  ...overrides,
});

const flushPromises = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('useBoardTaskRuns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useRunStore.getState().clearAll();
  });

  afterEach(() => {
    vi.clearAllTimers();
    useRunStore.getState().clearAll();
  });

  it('does nothing when taskIds is empty', async () => {
    renderHook(() => useBoardTaskRuns([], { intervalMs: 0 }));
    expect(mockedGetByTask).not.toHaveBeenCalled();
    expect(useRunStore.getState().runs).toEqual({});
  });

  it('populates the run store with rows for each task', async () => {
    mockedGetByTask.mockImplementation(async (taskId: string) => buildRun({ id: `run-${taskId}`, taskId }));

    renderHook(() => useBoardTaskRuns(['task-1', 'task-2'], { intervalMs: 0 }));

    await act(async () => {
      await flushPromises();
    });

    const state = useRunStore.getState().runs;
    expect(state['task-1']?.taskId).toBe('task-1');
    expect(state['task-2']?.taskId).toBe('task-2');
  });

  it('clears stale run rows when the server returns no row', async () => {
    // Seed the store with a row that should be removed.
    useRunStore.getState().setRun('task-1', buildRun({ status: 'completed', finishedAt: '2026-09-17T10:01:00.000Z' }));
    expect(useRunStore.getState().runs['task-1']).toBeTruthy();

    mockedGetByTask.mockResolvedValueOnce(null);

    renderHook(() => useBoardTaskRuns(['task-1'], { intervalMs: 0 }));

    await act(async () => {
      await flushPromises();
    });

    expect(useRunStore.getState().runs['task-1']).toBeUndefined();
  });

  it('emits onRunComplete when a run transitions to a terminal status', async () => {
    // First call: claimed (live). Second call: completed.
    mockedGetByTask
      .mockResolvedValueOnce(buildRun({ status: 'claimed' }))
      .mockResolvedValueOnce(buildRun({ status: 'completed', finishedAt: '2026-09-17T10:01:00.000Z', exitCode: 0 }));

    const onRunComplete = vi.fn();
    renderHook(() => useBoardTaskRuns(['task-1'], { intervalMs: 50, onRunComplete }));

    await act(async () => {
      await flushPromises();
    });
    expect(onRunComplete).not.toHaveBeenCalled();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });

    expect(onRunComplete).toHaveBeenCalledTimes(1);
    expect(onRunComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-1',
        previousStatus: 'claimed',
        run: expect.objectContaining({ status: 'completed' }),
      })
    );
  });

  it('emits onRunComplete on the failed terminal transition too', async () => {
    mockedGetByTask
      .mockResolvedValueOnce(buildRun({ status: 'running' }))
      .mockResolvedValueOnce(buildRun({ status: 'failed', finishedAt: '2026-09-17T10:01:00.000Z', exitCode: 1, error: 'boom' }));

    const onRunComplete = vi.fn();
    renderHook(() => useBoardTaskRuns(['task-1'], { intervalMs: 50, onRunComplete }));

    await act(async () => {
      await flushPromises();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });

    expect(onRunComplete).toHaveBeenCalledTimes(1);
    expect(onRunComplete.mock.calls[0][0].run.status).toBe('failed');
  });

  it('does not fire onRunComplete for re-fetches of an already-terminal row', async () => {
    const completed = buildRun({ status: 'completed', finishedAt: '2026-09-17T10:01:00.000Z' });
    mockedGetByTask.mockResolvedValue(completed);

    const onRunComplete = vi.fn();
    renderHook(() => useBoardTaskRuns(['task-1'], { intervalMs: 30, onRunComplete }));

    await act(async () => {
      await flushPromises();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(onRunComplete).not.toHaveBeenCalled();
  });

  it('keeps polling even after a terminal status (so a re-queued run is detected)', async () => {
    const completed = buildRun({ status: 'completed', finishedAt: '2026-09-17T10:01:00.000Z' });
    mockedGetByTask.mockResolvedValue(completed);

    renderHook(() => useBoardTaskRuns(['task-1'], { intervalMs: 30 }));
    await act(async () => {
      await flushPromises();
    });
    const callsAtFirst = mockedGetByTask.mock.calls.length;

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(mockedGetByTask.mock.calls.length).toBeGreaterThan(callsAtFirst);
  });
});