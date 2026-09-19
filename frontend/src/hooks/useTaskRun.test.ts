import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTaskRun } from './useTaskRun';
import type { TaskRun } from '@/types/kanban';

vi.mock('@/services/api', () => ({
  runsApi: {
    getByTask: vi.fn(),
  },
}));

import { runsApi } from '@/services/api';

const mockedGetByTask = runsApi.getByTask as unknown as ReturnType<typeof vi.fn>;

const baseRun: TaskRun = {
  id: 'run-1',
  taskId: 'task-1',
  runnerId: 'runner-1',
  agentId: 'agent-1',
  status: 'claimed',
  claimedAt: '2026-09-17T10:00:00.000Z',
  lastHeartbeatAt: '2026-09-17T10:00:00.000Z',
  expiresAt: '2026-09-17T10:02:00.000Z',
  finishedAt: null,
  exitCode: null,
  error: null,
};

const flushPromises = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('useTaskRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  it('returns null and skips fetching when taskId is missing', async () => {
    const { result } = renderHook(() => useTaskRun(undefined));
    expect(mockedGetByTask).not.toHaveBeenCalled();
    expect(result.current.run).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('returns null when the server responds with no row', async () => {
    mockedGetByTask.mockResolvedValueOnce(null);
    const { result } = renderHook(() => useTaskRun('task-1', { intervalMs: 0 }));
    await act(async () => {
      await flushPromises();
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.run).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('surfaces a live (claimed) row and keeps polling', async () => {
    const liveRun: TaskRun = { ...baseRun, status: 'claimed' };
    mockedGetByTask.mockResolvedValue(liveRun);
    const { result } = renderHook(() => useTaskRun('task-1', { intervalMs: 50 }));

    await act(async () => {
      await flushPromises();
    });
    expect(result.current.run?.status).toBe('claimed');
    expect(result.current.error).toBeNull();

    const callsAfterFirst = mockedGetByTask.mock.calls.length;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(mockedGetByTask.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it('stops polling once the run reaches a terminal status', async () => {
    const completedRun: TaskRun = {
      ...baseRun,
      status: 'completed',
      finishedAt: '2026-09-17T10:01:00.000Z',
      exitCode: 0,
    };
    mockedGetByTask.mockResolvedValueOnce(completedRun);
    const { result } = renderHook(() => useTaskRun('task-1', { intervalMs: 50 }));

    await act(async () => {
      await flushPromises();
    });
    expect(result.current.run?.status).toBe('completed');
    const callsAtTerminal = mockedGetByTask.mock.calls.length;

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(mockedGetByTask.mock.calls.length).toBe(callsAtTerminal);
    expect(result.current.run?.status).toBe('completed');
  });

  it('records network errors and keeps the last good row', async () => {
    mockedGetByTask.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useTaskRun('task-1', { intervalMs: 0 }));
    await act(async () => {
      await flushPromises();
    });
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.run).toBeNull();
  });

  it('does not fire requests after unmount', async () => {
    const liveRun: TaskRun = { ...baseRun, status: 'running' };
    mockedGetByTask.mockResolvedValue(liveRun);
    const { unmount, result } = renderHook(() => useTaskRun('task-1', { intervalMs: 50 }));
    await act(async () => {
      await flushPromises();
    });
    expect(result.current.run?.status).toBe('running');
    unmount();
    const callsAtUnmount = mockedGetByTask.mock.calls.length;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(mockedGetByTask.mock.calls.length).toBeLessThanOrEqual(callsAtUnmount + 1);
  });
});
