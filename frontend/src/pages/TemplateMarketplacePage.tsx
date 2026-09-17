import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { presetTemplatesApi, type PresetTemplate } from '../services/api';
import { ErrorToastContainer } from '../components/ErrorToast';
import { useSetupGuard } from '../hooks/useSetupGuard';

/**
 * TemplateMarketplacePage — the public, curated marketplace of starter
 * boards (s-1196, PM_REVIEW_2026-09-17 §5.4 ROI #4 / §6).
 *
 * Renders one card per preset the server exposes via
 * GET /api/v1/preset-templates. Each card carries three actions:
 *
 *   1. "Use this template" → drop into the onboarding wizard with the
 *      preset pre-selected, so the wizard's "pick preset → auto-create
 *      board → install sample agent → trigger demo run" sequence is one
 *      click from this page.
 *   2. "Preview columns" → expands a read-only view of the column order
 *      so the user knows what they're getting.
 *   3. "Back to boards" → leave the marketplace without doing anything.
 *
 * The marketplace is intentionally public (no auth required to read)
 * so unauthenticated visitors can browse from the landing page; admins
 * can hide it wholesale via the marketplaceEnabled app_config toggle.
 * When the server returns an empty list the page renders an empty-state
 * with a friendly hint rather than a confusing "no results" message.
 */
export function TemplateMarketplacePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  useSetupGuard();

  const [presets, setPresets] = useState<PresetTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedSlug, setExpandedSlug] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string>('');

  const fetchPresets = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await presetTemplatesApi.getAll();
      setPresets(data || []);
    } catch (err) {
      console.error('Failed to fetch preset templates:', err);
      setError(err instanceof Error ? err.message : t('app.error.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchPresets();
  }, [fetchPresets]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    presets.forEach((p) => {
      if (p.category) set.add(p.category);
    });
    return Array.from(set).sort();
  }, [presets]);

  const visiblePresets = useMemo(() => {
    if (!categoryFilter) return presets;
    return presets.filter((p) => p.category === categoryFilter);
  }, [presets, categoryFilter]);

  const handleUseTemplate = (preset: PresetTemplate) => {
    navigate(`/onboarding?preset=${encodeURIComponent(preset.slug)}`);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-zinc-100 to-zinc-50 dark:from-zinc-800 dark:to-zinc-900 p-6">
      <div className="mx-auto max-w-7xl">
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-purple-500 to-purple-600 text-white shadow-lg shadow-purple-500/30">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
                <rect x="14" y="14" width="7" height="7" rx="1" />
              </svg>
            </div>
            <div>
              <h1 className="text-2xl font-bold text-zinc-800 dark:text-zinc-100">
                {t('marketplace.title')}
              </h1>
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                {t('marketplace.subtitle')}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Link
              to="/boards"
              className="flex items-center gap-2 rounded-xl bg-white dark:bg-zinc-800 px-4 py-2.5 text-sm font-medium text-zinc-600 dark:text-zinc-300 shadow-sm border border-zinc-100 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-all"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
              {t('marketplace.backToBoards')}
            </Link>
          </div>
        </div>

        {categories.length > 1 && (
          <div className="mb-6 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setCategoryFilter('')}
              className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                categoryFilter === ''
                  ? 'bg-purple-500 text-white shadow-sm'
                  : 'bg-white dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-700'
              }`}
            >
              {t('marketplace.filterAll')}
            </button>
            {categories.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setCategoryFilter(cat)}
                className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                  categoryFilter === cat
                    ? 'bg-purple-500 text-white shadow-sm'
                    : 'bg-white dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-700'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        )}

        {loading ? (
          <div className="rounded-2xl bg-white dark:bg-zinc-800 p-12 text-center shadow-sm border border-zinc-100 dark:border-zinc-700">
            <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-purple-500 border-t-transparent" />
            <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">
              {t('marketplace.loading')}
            </p>
          </div>
        ) : error ? (
          <div className="rounded-2xl bg-white dark:bg-zinc-800 p-8 text-center shadow-sm border border-zinc-100 dark:border-zinc-700">
            <p className="text-lg font-semibold text-zinc-800 dark:text-zinc-100">
              {t('app.error.loadFailed')}
            </p>
            <button
              onClick={fetchPresets}
              className="mt-4 inline-flex items-center gap-1 text-sm text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300 transition-colors"
            >
              {t('app.error.retry')}
            </button>
          </div>
        ) : presets.length === 0 ? (
          <div className="rounded-2xl bg-white dark:bg-zinc-800 p-12 text-center shadow-sm border border-zinc-100 dark:border-zinc-700">
            <div className="mb-4 flex h-20 w-20 mx-auto items-center justify-center rounded-full bg-zinc-50 dark:bg-zinc-700 text-zinc-400">
              <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
                <rect x="14" y="14" width="7" height="7" rx="1" />
              </svg>
            </div>
            <p className="text-lg font-medium text-zinc-500 dark:text-zinc-400">
              {t('marketplace.empty')}
            </p>
            <Link
              to="/boards"
              className="mt-4 inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-blue-500 to-blue-600 px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-blue-500/30 hover:from-blue-600 hover:to-blue-700 transition-all"
            >
              {t('marketplace.backToBoards')}
            </Link>
          </div>
        ) : (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {visiblePresets.map((preset) => {
              const isExpanded = expandedSlug === preset.slug;
              let columns: { name: string; color?: string; status?: string }[] = [];
              try {
                const parsed = JSON.parse(preset.columnsConfig || '[]');
                if (Array.isArray(parsed)) {
                  columns = parsed as typeof columns;
                }
              } catch {
                columns = [];
              }
              return (
                <div
                  key={preset.id}
                  className="group flex flex-col rounded-2xl bg-white dark:bg-zinc-800 p-6 shadow-sm border border-zinc-100 dark:border-zinc-700 hover:shadow-lg hover:border-purple-200 dark:hover:border-purple-700 transition-all duration-300"
                >
                  <div className="flex items-start gap-3 mb-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-purple-500/10 to-purple-600/10 text-purple-600 dark:text-purple-300">
                      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="3" width="7" height="7" rx="1" />
                        <rect x="14" y="3" width="7" height="7" rx="1" />
                        <rect x="3" y="14" width="7" height="7" rx="1" />
                        <rect x="14" y="14" width="7" height="7" rx="1" />
                      </svg>
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="font-semibold text-zinc-800 dark:text-zinc-100 truncate">
                        {preset.name}
                      </h3>
                      {preset.category && (
                        <span className="mt-1 inline-block rounded-full bg-zinc-100 dark:bg-zinc-700 px-2 py-0.5 text-xs font-medium text-zinc-600 dark:text-zinc-300">
                          {preset.category}
                        </span>
                      )}
                    </div>
                  </div>
                  <p className="text-sm text-zinc-600 dark:text-zinc-300 mb-4 line-clamp-3">
                    {preset.description}
                  </p>

                  {columns.length > 0 && (
                    <div className="mb-4">
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedSlug(isExpanded ? null : preset.slug)
                        }
                        className="text-xs font-medium text-purple-600 dark:text-purple-300 hover:text-purple-700 dark:hover:text-purple-200"
                      >
                        {isExpanded ? t('marketplace.hideColumns') : t('marketplace.showColumns', { count: columns.length })}
                      </button>
                      {isExpanded && (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {columns.map((col, idx) => (
                            <span
                              key={`${preset.slug}-col-${idx}`}
                              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-white"
                              style={{ backgroundColor: col.color || '#6b7280' }}
                            >
                              {col.name}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  <div className="mt-auto flex gap-2">
                    <button
                      type="button"
                      onClick={() => handleUseTemplate(preset)}
                      className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-purple-500 to-purple-600 px-4 py-2.5 text-sm font-medium text-white shadow-lg shadow-purple-500/30 hover:from-purple-600 hover:to-purple-700 transition-all"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M5 12h14M12 5l7 7-7 7" />
                      </svg>
                      {t('marketplace.useTemplate')}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <ErrorToastContainer />
    </div>
  );
}