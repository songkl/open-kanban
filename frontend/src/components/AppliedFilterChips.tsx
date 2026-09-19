import { useTranslation } from 'react-i18next';
import type { FilterState } from '../hooks/useFilters';
import type { CustomField } from '@/types/kanban';

interface AppliedFilterChipsProps {
  filters: FilterState;
  customFields: CustomField[];
  /**
   * s-1201: the chip × handlers receive the dimension key so callers
   * can dispatch the clear without re-deriving which key to mutate.
   */
  onClearSingleFilter: (dimension: keyof FilterState | 'customField.fieldId' | 'customField.value') => void;
  onClearAll: () => void;
}

/**
 * s-1201: rendered next to the filter button whenever at least one
 * filter dimension is non-empty. The first chip is the aggregate
 * "N filters applied" indicator (also functions as a clear-all
 * affordance), followed by one chip per active dimension. Clicking
 * a chip's × clears that single dimension.
 *
 * The component is intentionally lightweight — it does not own
 * visibility or layout; the parent decides when and where to render
 * it. Keeping it always rendered behind the parent's gate satisfies
 * the DoD's "applied-filter chip is always visible".
 */
export function AppliedFilterChips({
  filters,
  customFields,
  onClearSingleFilter,
  onClearAll,
}: AppliedFilterChipsProps) {
  const { t } = useTranslation();
  const selectedCustomField = customFields.find(f => f.id === filters.customField.fieldId);

  const chips: Array<{ key: string; label: string; onRemove: () => void }> = [];

  if (filters.priority) {
    chips.push({
      key: 'priority',
      label: `${t('filter.priority')}: ${t(`filter.${filters.priority}`)}`,
      onRemove: () => onClearSingleFilter('priority'),
    });
  }
  if (filters.assignee) {
    chips.push({
      key: 'assignee',
      label: `${t('filter.assignee')}: ${filters.assignee}`,
      onRemove: () => onClearSingleFilter('assignee'),
    });
  }
  if (filters.dateRange) {
    chips.push({
      key: 'dateRange',
      label: `${t('filter.dateRange')}: ${t(`filter.${filters.dateRange}`)}`,
      onRemove: () => onClearSingleFilter('dateRange'),
    });
  }
  if (filters.tag) {
    chips.push({
      key: 'tag',
      label: `${t('filter.tag')}: ${filters.tag}`,
      onRemove: () => onClearSingleFilter('tag'),
    });
  }
  if (filters.runStatus) {
    const runStatusLabels: Record<string, string> = {
      none: t('filter.runStatusNone'),
      running: t('filter.runStatusRunning'),
      completed: t('filter.runStatusCompleted'),
      failed: t('filter.runStatusFailed'),
      queued: t('filter.runStatusQueued'),
    };
    chips.push({
      key: 'runStatus',
      label: `${t('filter.runStatus')}: ${runStatusLabels[filters.runStatus] ?? filters.runStatus}`,
      onRemove: () => onClearSingleFilter('runStatus'),
    });
  }
  if (filters.hasComments) {
    chips.push({
      key: 'hasComments',
      label: `${t('filter.hasComments')}: ${t(`filter.${filters.hasComments}`)}`,
      onRemove: () => onClearSingleFilter('hasComments'),
    });
  }
  if (filters.hasSubtasks) {
    chips.push({
      key: 'hasSubtasks',
      label: `${t('filter.hasSubtasks')}: ${t(`filter.${filters.hasSubtasks}`)}`,
      onRemove: () => onClearSingleFilter('hasSubtasks'),
    });
  }
  if (filters.customField.fieldId) {
    const fieldLabel = selectedCustomField?.name ?? filters.customField.fieldId;
    chips.push({
      key: 'customField.fieldId',
      label: `${t('filter.customField')}: ${fieldLabel}`,
      onRemove: () => onClearSingleFilter('customField.fieldId'),
    });
  }
  if (filters.customField.value) {
    chips.push({
      key: 'customField.value',
      label: `${t('filter.customFieldValue')}: ${filters.customField.value}`,
      onRemove: () => onClearSingleFilter('customField.value'),
    });
  }

  if (chips.length === 0) return null;

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      data-testid="applied-filter-chips"
      role="list"
      aria-label={t('filter.appliedCount', { count: chips.length })}
    >
      <button
        type="button"
        onClick={onClearAll}
        className="inline-flex items-center gap-1 rounded-full bg-blue-100 dark:bg-blue-900/40 px-2.5 py-1 text-xs font-medium text-blue-700 dark:text-blue-300 hover:bg-blue-200 dark:hover:bg-blue-900/60"
        title={t('filter.clearAll')}
        role="listitem"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
        </svg>
        <span>{t('filter.appliedCount', { count: chips.length })}</span>
      </button>
      {chips.map((chip) => (
        <span
          key={chip.key}
          role="listitem"
          className="inline-flex items-center gap-1 rounded-full bg-zinc-200 dark:bg-zinc-700 px-2.5 py-1 text-xs text-zinc-700 dark:text-zinc-200"
        >
          <span className="max-w-[12rem] truncate">{chip.label}</span>
          <button
            type="button"
            onClick={chip.onRemove}
            aria-label={t('filter.removeFilter', { label: chip.label })}
            className="text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </span>
      ))}
    </div>
  );
}
