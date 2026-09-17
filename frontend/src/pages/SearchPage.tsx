import { useState, useEffect, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { authApi } from '../services/api';
import { useSetupGuard } from '../hooks/useSetupGuard';

/**
 * Minimal global-search surface wired into the new persistent
 * sidebar (s-1194, PM_REVIEW_2026-09-17 §5.2 ROI #2). The page
 * shells out to the existing `/api/v1/tasks/search?q=` endpoint
 * via the public-facing frontend API and renders the result set
 * inline.
 *
 * Scope is intentionally narrow: a dedicated search UX with
 * faceting, ranking and per-board scopes is tracked separately
 * (s-1205 follow-up). This page exists so the sidebar Search
 * icon has a real destination that returns something useful in
 * one click — the spec's definition of done for ROI #2 is
 * "any authenticated page is reachable in ≤ 1 click from the
 * sidebar", not "search must be feature-complete".
 */
export function SearchPage() {
  const { t } = useTranslation();
  useSetupGuard();
  const [params, setParams] = useSearchParams();
  const initial = params.get('q') ?? '';
  const [query, setQuery] = useState(initial);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [boards, setBoards] = useState<Record<string, { name: string }>>({});

  const loadBoards = useCallback(async () => {
    try {
      const all = await authApi.getBoards();
      const map: Record<string, { name: string }> = {};
      for (const b of all || []) {
        map[b.id] = { name: b.name };
      }
      setBoards(map);
    } catch (err) {
      console.warn('Failed to load boards for search', err);
    }
  }, []);

  useEffect(() => {
    void loadBoards();
  }, [loadBoards]);

  const run = useCallback(
    async (q: string) => {
      if (!q.trim()) {
        setResults([]);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/v1/tasks/search?q=${encodeURIComponent(q)}&pageSize=20`,
          { credentials: 'include' }
        );
        if (!res.ok) {
          throw new Error(`search failed: ${res.status}`);
        }
        const data = (await res.json()) as { data?: SearchResult[] };
        setResults(data.data || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'unknown');
        setResults([]);
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    void run(initial);
  }, [initial, run]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const next = query.trim();
    if (next) {
      setParams({ q: next }, { replace: true });
    } else {
      setParams({}, { replace: true });
    }
    void run(next);
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <h1 className="mb-4 text-xl font-semibold text-zinc-800 dark:text-zinc-100">
        {t('search.title')}
      </h1>
      <form onSubmit={onSubmit} className="mb-6 flex gap-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('search.placeholder')}
          aria-label={t('search.placeholder')}
          className="flex-1 rounded-lg border border-zinc-200 bg-white px-4 py-2 text-sm text-zinc-800 focus:border-blue-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
        />
        <button
          type="submit"
          className="rounded-lg bg-blue-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-600"
        >
          {t('search.go')}
        </button>
      </form>

      {error && (
        <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">
          {t('search.error', { error })}
        </div>
      )}

      {loading ? (
        <div className="py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
          {t('search.loading')}
        </div>
      ) : results.length === 0 && query.trim() ? (
        <div className="py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
          {t('search.noResults')}
        </div>
      ) : (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-700" data-testid="search-results">
          {results.map((r) => (
            <li key={r.id} className="py-3">
              <Link
                to={`/board/${r.boardId || '_'}/tasks/${r.id}`}
                className="block rounded-md px-2 py-1 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800"
              >
                <div className="text-sm font-medium text-zinc-800 dark:text-zinc-100">
                  {r.title}
                </div>
                {r.boardId && boards[r.boardId] && (
                  <div className="text-xs text-zinc-500 dark:text-zinc-400">
                    {boards[r.boardId].name}
                  </div>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface SearchResult {
  id: string;
  title: string;
  boardId?: string;
}