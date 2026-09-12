// Tests for useTaskRun — the polling hook that surfaces the in-flight
// runner badge on a task card (see devDoc/CLI_RUNNER_PLAN_2026-09-12.md §5).
//
// The hook is mostly an orchestration layer around `runsApi.getByTask`,
// so the tests focus on the behaviours that callers actually rely on:
// (1) returning null on a 404, (2) keeping the latest row when polling,
// (3) cancelling an in-flight request when the interval re-fires,
// (4) clearing the polling timer on unmount, and (5) short-circuiting
// when `enabled` is false or the taskId is missing.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('../services/api', () => ({
  runsApi: {
    getByTask: vi.fn(),
  },
}));

import { runsApi } from '../services/api';
import { useTaskRun } from './useTaskRun';

const mockedGetByTask = runsApi.getByTask as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockedGetByTask.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useTaskRun', () => {
  it('returns null when the api responds with no row', async () => {
    mockedGetByTask.mockResolvedValue(null);
    const { result } = renderHook(() => useTaskRun('task-1', { intervalMs: 1000 }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.run).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('exposes the row the api returned', async () => {
    const row = {
      taskId: 'task-1',
      runnerId: 'runner-A',
      agentId: 'opencode',
      boardId: 'b-1',
      columnId: 'c-1',
      status: 'claimed' as const,
      claimedAt: '2024-01-01T00:00:00Z',
      lastHeartbeatAt: '2024-01-01T00:00:00Z',
      expiresAt: '2024-01-01T00:05:00Z',
    };
    mockedGetByTask.mockResolvedValue(row);
    const { result } = renderHook(() => useTaskRun('task-1', { intervalMs: 1000 }));
    await waitFor(() => expect(result.current.run).toEqual(row), { timeout: 2000 });
  });

  it('passes an AbortSignal to the api call so polling can be cancelled', async () => {
    mockedGetByTask.mockResolvedValue(null);
    renderHook(() => useTaskRun('task-1', { intervalMs: 1000 }));
    await waitFor(() => expect(mockedGetByTask).toHaveBeenCalledTimes(1));
    const firstSignal = mockedGetByTask.mock.calls[0][1] as AbortSignal;
    expect(firstSignal).toBeInstanceOf(AbortSignal);
    expect(firstSignal.aborted).toBe(false);
  });

  it('cancels the in-flight request when the component unmounts', async () => {
    let capturedSignal: AbortSignal | undefined;
    mockedGetByTask.mockImplementation((_taskId: string, signal?: AbortSignal) => {
      capturedSignal = signal;
      return new Promise(() => {
        // never resolves — the unmount should fire the abort
      });
    });
    const { unmount } = renderHook(() => useTaskRun('task-1', { intervalMs: 1000 }));
    await waitFor(() => expect(capturedSignal).toBeDefined());
    unmount();
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('clears the polling timer on unmount', async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    mockedGetByTask.mockResolvedValue(null);
    const { unmount } = renderHook(() => useTaskRun('task-1', { intervalMs: 1000 }));
    await waitFor(() => expect(mockedGetByTask).toHaveBeenCalled());
    unmount();
    expect(clearIntervalSpy).toHaveBeenCalled();
  });

  it('short-circuits when enabled is false', async () => {
    const { result } = renderHook(() => useTaskRun('task-1', { enabled: false }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockedGetByTask).not.toHaveBeenCalled();
    expect(result.current.run).toBeNull();
  });

  it('short-circuits when taskId is null', async () => {
    const { result } = renderHook(() => useTaskRun(null));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockedGetByTask).not.toHaveBeenCalled();
    expect(result.current.run).toBeNull();
  });

  it('surfaces non-abort errors without blocking the next poll', async () => {
    // The next poll (after intervalMs=50) clears the error.
    mockedGetByTask
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(null);
    const { result } = renderHook(() => useTaskRun('task-1', { intervalMs: 50 }));
    await waitFor(() => expect(result.current.error?.message).toBe('boom'), { timeout: 3000 });
    // Wait at least one full interval (50ms) for the second tick.
    await waitFor(() => expect(result.current.error).toBeNull(), { timeout: 3000, interval: 30 });
    expect(result.current.run).toBeNull();
  });
});
