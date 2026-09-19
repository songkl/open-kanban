import { useEffect, useState } from 'react';
import { authApi } from '../services/api';

export interface MyBoardPermissions {
  boardId: string;
  effectiveAccess: string;
  isOwner: boolean;
  canManageBoardPermissions: boolean;
  canManageColumnPermissions: boolean;
}

export interface UseBoardPermissionResult {
  effectiveAccess: string;
  isOwner: boolean;
  canManageBoardPermissions: boolean;
  canManageColumnPermissions: boolean;
  loading: boolean;
  error: Error | null;
}

const EMPTY_RESULT: UseBoardPermissionResult = {
  effectiveAccess: '',
  isOwner: false,
  canManageBoardPermissions: false,
  canManageColumnPermissions: false,
  loading: false,
  error: null,
};

export function useBoardPermission(boardId: string | null | undefined): UseBoardPermissionResult {
  const [data, setData] = useState<MyBoardPermissions | null>(null);
  const [loading, setLoading] = useState<boolean>(!!boardId);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!boardId) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    authApi
      .getMyBoardPermissions(boardId)
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setLoading(false);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [boardId]);

  if (!boardId) {
    return EMPTY_RESULT;
  }

  return {
    effectiveAccess: data?.effectiveAccess ?? '',
    isOwner: data?.isOwner ?? false,
    canManageBoardPermissions: data?.canManageBoardPermissions ?? false,
    canManageColumnPermissions: data?.canManageColumnPermissions ?? false,
    loading,
    error,
  };
}
