import { useCallback, useEffect, useMemo, useState } from 'react';

const STORAGE_KEY = 'cardDensity';

/**
 * s-1213: card density preference (PM-s1188 §3.3). Three personas need
 * different information density on the same board:
 *   - 'compact'   → priority scanner; id + title + dot only
 *   - 'standard'  → default; + assignee + comment/subtask counts
 *   - 'detailed'  → triage operator; + description preview + last
 *                   activity + Run badge when a run is live
 *
 * Persisted in localStorage under `cardDensity` so the preference
 * survives reloads (DoD: "preference persists across sessions"). The
 * hook intentionally does NOT go through the API — switching density
 * must not refetch any task data.
 */

export type CardDensity = 'compact' | 'standard' | 'detailed';

const VALID_DENSITIES: ReadonlySet<CardDensity> = new Set(['compact', 'standard', 'detailed']);

const isCardDensity = (value: unknown): value is CardDensity =>
  typeof value === 'string' && VALID_DENSITIES.has(value as CardDensity);

const readStoredDensity = (): CardDensity => {
  if (typeof window === 'undefined') return 'standard';
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return isCardDensity(raw) ? raw : 'standard';
  } catch {
    return 'standard';
  }
};

export interface UseCardDensityReturn {
  density: CardDensity;
  setDensity: (next: CardDensity) => void;
}

export function useCardDensity(): UseCardDensityReturn {
  const [density, setDensityState] = useState<CardDensity>(() => readStoredDensity());

  // Sync the tab if another tab/window rewrites the key. Keeps the
  // board consistent when the user has the kanban open in two windows
  // and toggles density in one of them.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const handleStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      setDensityState(readStoredDensity());
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  const setDensity = useCallback((next: CardDensity) => {
    if (!isCardDensity(next)) return;
    setDensityState(next);
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // localStorage may be unavailable (private mode, quota); the
        // in-memory state still updates so the toggle feels instant
        // and the session keeps working without persistence.
      }
    }
  }, []);

  return useMemo(() => ({ density, setDensity }), [density, setDensity]);
}