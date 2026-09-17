import { useState, useEffect, useCallback, useMemo, startTransition } from 'react';
import type { Column as ColumnType, CustomField, TaskRun } from '../types/kanban';

const FILTER_PRESETS_KEY = 'filterPresets';

/**
 * s-1197: a single named custom field filter. `fieldId` references a
 * `CustomField.id`; `value` is the comparison value. For multi-select
 * fields the value is a CSV; the matcher checks `value.split(',')` so
 * a task tagged "bug, ui" matches a filter on "bug".
 */
export interface CustomFieldFilter {
  fieldId: string;
  value: string;
}

/**
 * s-1201: the filter modal now exposes seven dimensions. The
 * `searchQuery` is owned by the toolbar search bar but is mirrored
 * into `FilterState` so it travels with presets and URL persistence.
 *
 *   - `runStatus` collapses the `task_runs.status` enum into the
 *     user-facing buckets the drawer renders (Running / Completed /
 *     Failed / Queued) plus a synthetic `'none'` value for tasks
 *     with no run row.
 *   - `hasComments` / `hasSubtasks` are tri-state: `''` (all),
 *     `'yes'` (must have ≥1), `'no'` (must have zero).
 */
export type RunStatusFilter = '' | 'none' | 'running' | 'completed' | 'failed' | 'queued';
export type TriStateFilter = '' | 'yes' | 'no';

export interface FilterState {
  priority: string;
  assignee: string;
  searchQuery: string;
  dateRange: string;
  tag: string;
  customField: CustomFieldFilter;
  runStatus: RunStatusFilter;
  hasComments: TriStateFilter;
  hasSubtasks: TriStateFilter;
}

export interface FilterPreset {
  id: string;
  name: string;
  filters: FilterState;
}

/**
 * s-1201: short, stable URL param keys so the filter state survives
 * a bookmark or shared link. Only non-empty values are written;
 * reading tolerates any subset and falls back to defaults.
 */
export const FILTER_URL_KEYS = {
  priority: 'f_pri',
  assignee: 'f_asg',
  searchQuery: 'f_q',
  dateRange: 'f_dr',
  tag: 'f_tag',
  customFieldId: 'f_cf',
  customFieldValue: 'f_cfv',
  runStatus: 'f_rs',
  hasComments: 'f_hc',
  hasSubtasks: 'f_hs',
} as const;

interface UseFiltersOptions {
  columns?: ColumnType[];
  /**
   * s-1197: definitions of custom fields for the current board. Used
   * to build the unique-value options in the filter UI and to match
   * the `customField` filter against task meta in `getFilteredColumns`.
   */
  customFields?: CustomField[];
  /**
   * s-1201: live run map keyed by taskId, used by the `runStatus`
   * dimension. Optional so legacy callers (and tests that don't care
   * about run filtering) keep working — when absent, `runStatus`
   * always matches.
   */
  runsByTaskId?: Record<string, TaskRun>;
  /**
   * s-1201: optional initial state, typically populated from URL
   * search params on mount by `useBoardState`. When provided, the
   * hook seeds its `useState` initialiser with these values instead
   * of the empty defaults.
   */
  initial?: Partial<FilterState>;
}

interface UseFiltersReturn {
  filters: FilterState;
  filterPresets: FilterPreset[];
  searchQuery: string;
  uniqueAssignees: string[];
  uniqueTags: string[];
  uniqueCustomFieldValues: Record<string, string[]>;
  isInDateRange: (taskCreatedAt: string) => boolean;
  getFilteredColumns: () => ColumnType[];
  setFilters: React.Dispatch<React.SetStateAction<FilterState>>;
  setFilterPresets: React.Dispatch<React.SetStateAction<FilterPreset[]>>;
  setSearchQuery: React.Dispatch<React.SetStateAction<string>>;
  clearFilters: () => void;
  /**
   * s-1201: clear exactly one filter dimension (used by the
   * applied-filter chip × buttons). Pass `'customField.fieldId'` or
   * `'customField.value'` to address the nested keys.
   */
  clearSingleFilter: (dimension: keyof FilterState | 'customField.fieldId' | 'customField.value') => void;
  saveCurrentAsPreset: () => void;
  applyPreset: (preset: FilterPreset) => void;
  deletePreset: (presetId: string) => void;
  hasActiveFilters: boolean;
  activeFilterCount: number;
}

export const EMPTY_CUSTOM_FIELD_FILTER: CustomFieldFilter = { fieldId: '', value: '' };

export const DEFAULT_FILTERS: FilterState = {
  priority: '',
  assignee: '',
  searchQuery: '',
  dateRange: '',
  tag: '',
  customField: EMPTY_CUSTOM_FIELD_FILTER,
  runStatus: '',
  hasComments: '',
  hasSubtasks: '',
};

/**
 * s-1201: collapse the per-row task_runs.status enum into the
 * user-facing buckets the filter UI exposes. Mirrors the grouping
 * documented on `TaskRun.status`.
 */
function collapseRunStatus(raw: TaskRun['status'] | undefined): 'none' | 'running' | 'completed' | 'failed' | 'queued' {
  if (!raw) return 'none';
  if (raw === 'claimed' || raw === 'running') return 'running';
  if (raw === 'completed') return 'completed';
  if (raw === 'failed') return 'failed';
  if (raw === 'released') return 'queued';
  return 'none';
}

/**
 * s-1201: merge a partial filter object onto the defaults so callers
 * (URL hydration, preset application, chip × handlers) can supply
 * only the keys they care about without losing the new dimensions.
 */
export function withDefaults(partial: Partial<FilterState> | undefined | null): FilterState {
  if (!partial) return { ...DEFAULT_FILTERS };
  return {
    ...DEFAULT_FILTERS,
    ...partial,
    customField: { ...EMPTY_CUSTOM_FIELD_FILTER, ...(partial.customField ?? {}) },
  };
}

/**
 * s-1201: round-trip helpers between `FilterState` and
 * `URLSearchParams`. Only non-empty values are written so a fully
 * cleared filter does not pollute the URL.
 */
export function encodeFiltersToParams(
  filters: FilterState,
  keys: typeof FILTER_URL_KEYS = FILTER_URL_KEYS,
): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.priority) params.set(keys.priority, filters.priority);
  if (filters.assignee) params.set(keys.assignee, filters.assignee);
  if (filters.searchQuery) params.set(keys.searchQuery, filters.searchQuery);
  if (filters.dateRange) params.set(keys.dateRange, filters.dateRange);
  if (filters.tag) params.set(keys.tag, filters.tag);
  if (filters.customField.fieldId) params.set(keys.customFieldId, filters.customField.fieldId);
  if (filters.customField.value) params.set(keys.customFieldValue, filters.customField.value);
  if (filters.runStatus) params.set(keys.runStatus, filters.runStatus);
  if (filters.hasComments) params.set(keys.hasComments, filters.hasComments);
  if (filters.hasSubtasks) params.set(keys.hasSubtasks, filters.hasSubtasks);
  return params;
}

export function decodeFiltersFromParams(
  params: URLSearchParams,
  keys: typeof FILTER_URL_KEYS = FILTER_URL_KEYS,
): Partial<FilterState> {
  const out: Partial<FilterState> = {};
  const priority = params.get(keys.priority);
  if (priority) out.priority = priority;
  const assignee = params.get(keys.assignee);
  if (assignee) out.assignee = assignee;
  const searchQuery = params.get(keys.searchQuery);
  if (searchQuery) out.searchQuery = searchQuery;
  const dateRange = params.get(keys.dateRange);
  if (dateRange) out.dateRange = dateRange;
  const tag = params.get(keys.tag);
  if (tag) out.tag = tag;
  const customFieldId = params.get(keys.customFieldId);
  if (customFieldId) {
    out.customField = {
      fieldId: customFieldId,
      value: params.get(keys.customFieldValue) ?? '',
    };
  }
  const runStatus = params.get(keys.runStatus);
  if (runStatus) out.runStatus = runStatus as RunStatusFilter;
  const hasComments = params.get(keys.hasComments);
  if (hasComments) out.hasComments = hasComments as TriStateFilter;
  const hasSubtasks = params.get(keys.hasSubtasks);
  if (hasSubtasks) out.hasSubtasks = hasSubtasks as TriStateFilter;
  return out;
}

export function useFilters({
  columns = [],
  customFields = [],
  runsByTaskId,
  initial,
}: UseFiltersOptions = {}): UseFiltersReturn {
  const [filters, setFilters] = useState<FilterState>(() => withDefaults(initial));
  const initialSearchFromProps = initial?.searchQuery ?? '';
  const [searchQuery, setSearchQuery] = useState(initialSearchFromProps);

  const [filterPresets, setFilterPresets] = useState<FilterPreset[]>(() => {
    const saved = localStorage.getItem(FILTER_PRESETS_KEY);
    return saved ? JSON.parse(saved) : [];
  });

  const syncFiltersWithSearch = useCallback(() => {
    startTransition(() => {
      setFilters(prev => ({ ...prev, searchQuery }));
    });
  }, [searchQuery]);

  useEffect(() => {
    localStorage.setItem(FILTER_PRESETS_KEY, JSON.stringify(filterPresets));
  }, [filterPresets]);

  useEffect(() => {
    syncFiltersWithSearch();
  }, [syncFiltersWithSearch]);

  const clearFilters = useCallback(() => {
    setFilters({ ...DEFAULT_FILTERS });
    setSearchQuery('');
  }, []);

  const clearSingleFilter = useCallback(
    (dimension: keyof FilterState | 'customField.fieldId' | 'customField.value') => {
      setFilters(prev => {
        if (dimension === 'customField.fieldId') {
          return { ...prev, customField: EMPTY_CUSTOM_FIELD_FILTER };
        }
        if (dimension === 'customField.value') {
          return { ...prev, customField: { ...prev.customField, value: '' } };
        }
        if (dimension === 'searchQuery') {
          setSearchQuery('');
          return { ...prev, searchQuery: '' };
        }
        if (dimension === 'customField') {
          return { ...prev, customField: EMPTY_CUSTOM_FIELD_FILTER };
        }
        return { ...prev, [dimension]: DEFAULT_FILTERS[dimension] };
      });
    },
    [],
  );

  const saveCurrentAsPreset = useCallback((name?: string) => {
    const presetName = name || prompt('Preset name:');
    if (!presetName?.trim()) return;
    const newPreset: FilterPreset = {
      id: Date.now().toString(),
      name: presetName.trim(),
      filters: { ...filters },
    };
    setFilterPresets(prev => [...prev, newPreset]);
  }, [filters]);

  const applyPreset = useCallback((preset: FilterPreset) => {
    setFilters(withDefaults(preset.filters));
    setSearchQuery(preset.filters.searchQuery ?? '');
  }, []);

  const deletePreset = useCallback((presetId: string) => {
    setFilterPresets(prev => prev.filter(p => p.id !== presetId));
  }, []);

  const activeFilterCount = useMemo(
    () =>
      [
        filters.searchQuery,
        filters.priority,
        filters.assignee,
        filters.dateRange,
        filters.tag,
        filters.runStatus,
        filters.hasComments,
        filters.hasSubtasks,
        filters.customField.fieldId,
        filters.customField.value,
      ].filter(Boolean).length,
    [filters],
  );

  const hasActiveFilters = activeFilterCount > 0;

  const allTasks = useMemo(() => columns.flatMap(col => col.tasks || []), [columns]);

  const uniqueAssignees = useMemo(
    () => [...new Set(allTasks.filter(t => t.assignee).map(t => t.assignee as string))],
    [allTasks],
  );

  const uniqueTags = useMemo(
    () => [
      ...new Set(
        allTasks
          .filter(t => t.meta && typeof t.meta === 'object' && '标签' in t.meta)
          .map(t => (t.meta as Record<string, unknown>)['标签'] as string)
          .filter(Boolean),
      ),
    ],
    [allTasks],
  );

  /**
   * s-1197: pre-compute the unique values seen across all tasks for
   * each defined custom field. Used by the filter UI to populate the
   * "Custom field" value dropdown without scanning the task list on
   * every keystroke. Multi-select values are flattened and split on
   * commas so legacy CSV-formatted values still appear in the list.
   */
  const uniqueCustomFieldValues = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const field of customFields) {
      const seen = new Set<string>();
      for (const task of allTasks) {
        if (!task.meta || typeof task.meta !== 'object') continue;
        const raw = (task.meta as Record<string, unknown>)[field.name];
        if (raw === undefined || raw === null || raw === '') continue;
        if (field.type === 'multi-select') {
          const items = Array.isArray(raw)
            ? raw
            : typeof raw === 'string'
            ? raw.split(',')
            : [];
          for (const item of items) {
            if (typeof item === 'string' && item.trim()) seen.add(item.trim());
          }
        } else if (typeof raw === 'string' || typeof raw === 'number') {
          seen.add(String(raw));
        }
      }
      map[field.id] = [...seen];
    }
    return map;
  }, [allTasks, customFields]);

  const isInDateRange = useCallback((taskCreatedAt: string): boolean => {
    if (!filters.dateRange) return true;
    const created = new Date(taskCreatedAt);
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    switch (filters.dateRange) {
      case 'today':
        return created >= todayStart;
      case 'thisWeek':
        return created >= weekStart;
      case 'thisMonth':
        return created >= monthStart;
      default:
        return true;
    }
  }, [filters.dateRange]);

  /**
   * Resolve the field name once per render for the active custom field
   * filter so we don't keep doing the lookup inside the per-task loop.
   * A field may have been deleted (or renamed) since the filter was
   * set; in that case `activeCustomFieldName` is undefined and the
   * matcher becomes a no-op (no task matches), which is the safe
   * default — the filter UI clears it on the next render anyway.
   */
  const activeCustomFieldName = useMemo(() => {
    if (!filters.customField.fieldId) return undefined;
    const field = customFields.find(f => f.id === filters.customField.fieldId);
    return field?.name;
  }, [filters.customField.fieldId, customFields]);

  const getFilteredColumns = useCallback(() => {
    const noFiltersActive =
      !filters.searchQuery &&
      !filters.priority &&
      !filters.assignee &&
      !filters.dateRange &&
      !filters.tag &&
      !filters.customField.fieldId &&
      !filters.runStatus &&
      !filters.hasComments &&
      !filters.hasSubtasks;
    if (noFiltersActive) {
      return columns;
    }
    return columns.map(col => ({
      ...col,
      tasks: (col.tasks || []).filter(task => {
        if (filters.searchQuery) {
          const query = filters.searchQuery.toLowerCase();
          const titleMatch = task.title.toLowerCase().includes(query);
          const descMatch = (task.description || '').toLowerCase().includes(query);
          const idMatch = task.id.toLowerCase().includes(query);
          if (!titleMatch && !descMatch && !idMatch) return false;
        }
        if (filters.priority && task.priority !== filters.priority) return false;
        if (filters.assignee && task.assignee !== filters.assignee) return false;
        if (filters.dateRange && !isInDateRange(task.createdAt)) return false;
        if (filters.tag) {
          const taskTag = task.meta && typeof task.meta === 'object' ? (task.meta as Record<string, unknown>)['标签'] : null;
          if (taskTag !== filters.tag) return false;
        }
        if (filters.customField.fieldId && filters.customField.value && activeCustomFieldName) {
          if (!task.meta || typeof task.meta !== 'object') return false;
          const taskValue = (task.meta as Record<string, unknown>)[activeCustomFieldName];
          if (taskValue === undefined || taskValue === null || taskValue === '') return false;
          const field = customFields.find(f => f.id === filters.customField.fieldId);
          if (field?.type === 'multi-select') {
            const items = Array.isArray(taskValue)
              ? taskValue.map(v => String(v))
              : typeof taskValue === 'string'
              ? taskValue.split(',').map(s => s.trim())
              : [];
            if (!items.includes(filters.customField.value)) return false;
          } else if (Array.isArray(taskValue)) {
            if (!taskValue.map(v => String(v)).includes(filters.customField.value)) return false;
          } else {
            if (String(taskValue) !== filters.customField.value) return false;
          }
        }
        if (filters.runStatus && runsByTaskId) {
          const run = runsByTaskId[task.id];
          const bucket = collapseRunStatus(run?.status);
          if (filters.runStatus === 'none') {
            if (run) return false;
          } else if (bucket !== filters.runStatus) {
            return false;
          }
        }
        if (filters.hasComments) {
          const direct = task.comments?.length ?? 0;
          const count = task._count?.comments ?? direct;
          const has = count > 0 || direct > 0;
          if (filters.hasComments === 'yes' && !has) return false;
          if (filters.hasComments === 'no' && has) return false;
        }
        if (filters.hasSubtasks) {
          const direct = task.subtasks?.length ?? 0;
          const count = task._count?.subtasks ?? direct;
          const has = count > 0 || direct > 0;
          if (filters.hasSubtasks === 'yes' && !has) return false;
          if (filters.hasSubtasks === 'no' && has) return false;
        }
        return true;
      }),
    }));
  }, [columns, filters, isInDateRange, activeCustomFieldName, customFields, runsByTaskId]);

  return {
    filters,
    filterPresets,
    searchQuery,
    uniqueAssignees,
    uniqueTags,
    uniqueCustomFieldValues,
    isInDateRange,
    getFilteredColumns,
    setFilters,
    setFilterPresets,
    setSearchQuery,
    clearFilters,
    clearSingleFilter,
    saveCurrentAsPreset,
    applyPreset,
    deletePreset,
    hasActiveFilters,
    activeFilterCount,
  };
}
