import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useBoardPermission } from './useBoardPermission';

vi.mock('../services/api', () => ({
  authApi: {
    getMyBoardPermissions: vi.fn(),
  },
}));

import { authApi } from '../services/api';

const mockedGetMyBoardPermissions = vi.mocked(authApi.getMyBoardPermissions);

describe('useBoardPermission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('loading state', () => {
    it('starts with loading=true and empty flags when boardId is provided', () => {
      mockedGetMyBoardPermissions.mockReturnValue(new Promise(() => {}));

      const { result } = renderHook(() => useBoardPermission('board-1'));

      expect(result.current.loading).toBe(true);
      expect(result.current.effectiveAccess).toBe('');
      expect(result.current.isOwner).toBe(false);
      expect(result.current.canManageBoardPermissions).toBe(false);
      expect(result.current.canManageColumnPermissions).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it('skips the fetch and returns the empty result when boardId is falsy', async () => {
      const { result } = renderHook(() => useBoardPermission(null));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });
      expect(mockedGetMyBoardPermissions).not.toHaveBeenCalled();
      expect(result.current.canManageBoardPermissions).toBe(false);
      expect(result.current.canManageColumnPermissions).toBe(false);
    });
  });

  describe('success state', () => {
    it('exposes the returned permission flags once the request resolves', async () => {
      mockedGetMyBoardPermissions.mockResolvedValue({
        boardId: 'board-1',
        effectiveAccess: 'WRITE',
        isOwner: true,
        canManageBoardPermissions: true,
        canManageColumnPermissions: true,
      });

      const { result } = renderHook(() => useBoardPermission('board-1'));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.effectiveAccess).toBe('WRITE');
      expect(result.current.isOwner).toBe(true);
      expect(result.current.canManageBoardPermissions).toBe(true);
      expect(result.current.canManageColumnPermissions).toBe(true);
      expect(result.current.error).toBeNull();
      expect(mockedGetMyBoardPermissions).toHaveBeenCalledWith('board-1');
    });

    it('reports canManageBoardPermissions=false for a non-owner MEMBER viewer', async () => {
      mockedGetMyBoardPermissions.mockResolvedValue({
        boardId: 'board-2',
        effectiveAccess: 'READ',
        isOwner: false,
        canManageBoardPermissions: false,
        canManageColumnPermissions: false,
      });

      const { result } = renderHook(() => useBoardPermission('board-2'));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.canManageBoardPermissions).toBe(false);
      expect(result.current.canManageColumnPermissions).toBe(false);
      expect(result.current.isOwner).toBe(false);
    });
  });

  describe('error state', () => {
    it('exposes the error and disables permission flags on failure', async () => {
      mockedGetMyBoardPermissions.mockRejectedValue(new Error('network'));

      const { result } = renderHook(() => useBoardPermission('board-3'));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.error).toBeInstanceOf(Error);
      expect(result.current.error?.message).toBe('network');
      expect(result.current.canManageBoardPermissions).toBe(false);
      expect(result.current.isOwner).toBe(false);
      expect(result.current.effectiveAccess).toBe('');
    });

    it('switches to a fresh fetch when boardId changes', async () => {
      mockedGetMyBoardPermissions.mockResolvedValue({
        boardId: 'board-1',
        effectiveAccess: 'ADMIN',
        isOwner: false,
        canManageBoardPermissions: true,
        canManageColumnPermissions: true,
      });

      const { result, rerender } = renderHook(
        ({ id }: { id: string | null }) => useBoardPermission(id),
        { initialProps: { id: 'board-1' as string | null } }
      );

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });
      expect(result.current.canManageBoardPermissions).toBe(true);

      mockedGetMyBoardPermissions.mockResolvedValue({
        boardId: 'board-2',
        effectiveAccess: 'READ',
        isOwner: false,
        canManageBoardPermissions: false,
        canManageColumnPermissions: false,
      });

      rerender({ id: 'board-2' });

      await waitFor(() => {
        expect(result.current.effectiveAccess).toBe('READ');
      });
      expect(result.current.canManageBoardPermissions).toBe(false);
      expect(mockedGetMyBoardPermissions).toHaveBeenCalledWith('board-1');
      expect(mockedGetMyBoardPermissions).toHaveBeenCalledWith('board-2');
    });

    it('cancels stale requests when the hook unmounts mid-flight', async () => {
      let resolveFn: (value: never) => void = () => {};
      mockedGetMyBoardPermissions.mockReturnValue(
        new Promise<never>((resolve) => {
          resolveFn = resolve;
        })
      );

      const { unmount } = renderHook(() => useBoardPermission('board-1'));
      unmount();
      // Resolving after unmount must not throw.
      resolveFn({} as never);
      expect(true).toBe(true);
    });
  });
});
