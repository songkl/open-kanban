import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useCardDensity } from './useCardDensity';

const STORAGE_KEY = 'cardDensity';

describe('useCardDensity (s-1213)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('returns standard as the default when nothing is stored', () => {
    const { result } = renderHook(() => useCardDensity());
    expect(result.current.density).toBe('standard');
  });

  it('reads the persisted preference on subsequent mounts', () => {
    localStorage.setItem(STORAGE_KEY, 'compact');
    const { result } = renderHook(() => useCardDensity());
    expect(result.current.density).toBe('compact');
  });

  it('falls back to standard when the stored value is not a known density', () => {
    localStorage.setItem(STORAGE_KEY, 'gigantic');
    const { result } = renderHook(() => useCardDensity());
    expect(result.current.density).toBe('standard');
  });

  it('persists the new value to localStorage when setDensity is called', () => {
    const { result } = renderHook(() => useCardDensity());
    act(() => {
      result.current.setDensity('detailed');
    });
    expect(result.current.density).toBe('detailed');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('detailed');
  });

  it('ignores invalid density values', () => {
    const { result } = renderHook(() => useCardDensity());
    act(() => {
      // Bypass TypeScript to ensure runtime guard works
      result.current.setDensity('gigantic' as unknown as 'compact');
    });
    expect(result.current.density).toBe('standard');
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});