import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { useSetupGuard } from './useSetupGuard';

vi.mock('@/services/api', () => ({
  authApi: {
    me: vi.fn(),
  },
}));

import { authApi } from '@/services/api';

const mockedMe = vi.mocked(authApi.me);

function PathListener({ onPath }: { onPath: (path: string) => void }) {
  const location = useLocation();
  useEffect(() => {
    onPath(location.pathname);
  }, [location.pathname, onPath]);
  return null;
}

function createWrapper(onPath: (p: string) => void) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <MemoryRouter initialEntries={['/boards']}>
        <PathListener onPath={onPath} />
        {children}
      </MemoryRouter>
    );
  };
}

describe('useSetupGuard', () => {
  beforeEach(() => {
    mockedMe.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('redirects to /setup when needsSetup is true', async () => {
    mockedMe.mockResolvedValue({ user: null, needsSetup: true } as never);

    let currentPath = '';
    const wrapper = createWrapper((p) => {
      currentPath = p;
    });

    renderHook(() => useSetupGuard(), { wrapper });

    await waitFor(() => {
      expect(currentPath).toBe('/setup');
    });
    expect(mockedMe).toHaveBeenCalled();
  });

  it('does not redirect when needsSetup is false and user exists', async () => {
    mockedMe.mockResolvedValue({ user: { id: 'u1' }, needsSetup: false } as never);

    const paths: string[] = [];
    const wrapper = createWrapper((p) => {
      paths.push(p);
    });

    renderHook(() => useSetupGuard(), { wrapper });

    await new Promise((r) => setTimeout(r, 10));

    expect(mockedMe).toHaveBeenCalledTimes(1);
    expect(paths).not.toContain('/setup');
    expect(paths[paths.length - 1]).toBe('/boards');
  });

  it('does not redirect when needsSetup is false and no user', async () => {
    mockedMe.mockResolvedValue({ user: null, needsSetup: false } as never);

    const paths: string[] = [];
    const wrapper = createWrapper((p) => {
      paths.push(p);
    });

    renderHook(() => useSetupGuard(), { wrapper });

    await new Promise((r) => setTimeout(r, 10));

    expect(mockedMe).toHaveBeenCalledTimes(1);
    expect(paths).not.toContain('/setup');
    expect(paths[paths.length - 1]).toBe('/boards');
  });

  it('does not redirect when authApi.me() rejects', async () => {
    mockedMe.mockRejectedValue(new Error('network'));

    const paths: string[] = [];
    const wrapper = createWrapper((p) => {
      paths.push(p);
    });

    renderHook(() => useSetupGuard(), { wrapper });

    await new Promise((r) => setTimeout(r, 10));

    expect(mockedMe).toHaveBeenCalledTimes(1);
    expect(paths).not.toContain('/setup');
    expect(paths[paths.length - 1]).toBe('/boards');
  });
});