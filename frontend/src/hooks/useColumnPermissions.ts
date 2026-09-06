import { useEffect, useState, useCallback, useRef } from 'react';
import { authApi } from '../services/api';

export interface ColumnAccess {
  effectiveAccess: string;
  canCreateTask: boolean;
  canModify: boolean;
  canDelete: boolean;
}

export interface UseColumnPermissionsResult {
  /** Map of columnId → access info. Empty until the first response lands. */
  columnAccess: Record<string, ColumnAccess>;
  /** True while the first network round trip is in flight. */
  loading: boolean;
  /** Error message from the last failed fetch, or null. */
  error: string | null;
  /** Effective access on the board itself (READ | WRITE | ADMIN | ''). */
  boardAccess: string;
  /** Whether the calling user is the recorded owner of the board. */
  isOwner: boolean;
  /** True if the user can create a task in any column under the board. */
  canCreateAnywhere: boolean;
  /** True if the user can create a task in this specific column. Defaults
   *  to `true` when no access info is loaded yet so the modal isn't
   *  disabled during the initial fetch and only locks when the server
   *  has actually answered. */
  canCreateIn: (columnId: string) => boolean;
  /** Force a fresh fetch (used when permissions might have just changed). */
  refresh: () => void;
}

// useColumnPermissions fetches the per-column access map for a
// board and exposes helpers the UI uses to gate task-creation
// affordances. Without this hook the create-task button is rendered
// for every logged-in user; the server then returns a 403 and the
// user only finds out after clicking. See s-1053.
//
// The hook re-fetches whenever boardId changes. Callers should pass
// the currently-selected board ID; the modal and column components
// read from the returned `columnAccess` map directly so a single
// fetch per board visit is enough.
export function useColumnPermissions(boardId: string | undefined | null): UseColumnPermissionsResult {
  const [columnAccess, setColumnAccess] = useState<Record<string, ColumnAccess>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [boardAccess, setBoardAccess] = useState('');
  const [isOwner, setIsOwner] = useState(false);
  // Track the latest requested boardId so an out-of-order response
  // for a stale board can't overwrite a fresh one.
  const latestBoardIdRef = useRef<string>('');

  const load = useCallback(async () => {
    if (!boardId) {
      setColumnAccess({});
      setBoardAccess('');
      setIsOwner(false);
      setLoading(false);
      setError(null);
      return;
    }
    latestBoardIdRef.current = boardId;
    setLoading(true);
    setError(null);
    try {
      const data = await authApi.getMyColumnAccess(boardId);
      if (latestBoardIdRef.current !== boardId) {
        return;
      }
      setColumnAccess(data.columns || {});
      setBoardAccess(data.boardAccess || '');
      setIsOwner(Boolean(data.isOwner));
    } catch (e) {
      if (latestBoardIdRef.current !== boardId) {
        return;
      }
      // 404 is expected for users with no relationship to the
      // board — leave the access map empty and surface a
      // non-blocking error so the caller can choose to show a
      // hint or fall back to the existing "no access" page.
      setColumnAccess({});
      setBoardAccess('');
      setIsOwner(false);
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
    } finally {
      if (latestBoardIdRef.current === boardId) {
        setLoading(false);
      }
    }
  }, [boardId]);

  useEffect(() => {
    load();
  }, [load]);

  const canCreateIn = useCallback(
    (columnId: string) => {
      if (!columnId) return false;
      const info = columnAccess[columnId];
      if (!info) {
        // Optimistic default: before the server answers, don't
        // block the user. Once `columnAccess` is populated, the
        // real value takes over.
        return true;
      }
      return info.canCreateTask;
    },
    [columnAccess]
  );

  const canCreateAnywhere = Object.values(columnAccess).some((c) => c.canCreateTask);

  return {
    columnAccess,
    loading,
    error,
    boardAccess,
    isOwner,
    canCreateAnywhere,
    canCreateIn,
    refresh: load,
  };
}
