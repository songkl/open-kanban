import { useState, useEffect, useCallback, useMemo, startTransition } from 'react';
import type { Column as ColumnType, CustomField } from '../types/kanban';

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

export interface FilterState {
  priority: string;
  assignee: string;
  searchQuery: string;
  dateRange: string;
  tag: string;
  customField: CustomFieldFilter;
}

export interface FilterPreset {
  id: string;
  name: string;
  filters: FilterState;
}

interface UseFiltersOptions {
  columns?: ColumnType[];
  /**
   * s-1197: definitions of custom fields for the current board. Used
   * to build the unique-value options in the filter UI and to match
   * the `customField` filter against task meta in `getFilteredColumns`.
   */
  customFields?: CustomField[];
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
  saveCurrentAsPreset: () => void;
  applyPreset: (preset: FilterPreset) => void;
  deletePreset: (presetId: string) => void;
  hasActiveFilters: boolean;
}

export const EMPTY_CUSTOM_FIELD_FILTER: CustomFieldFilter = { fieldId: '', value: '' };

export function useFilters({ columns = [], customFields = [] }: UseFiltersOptions = {}): UseFiltersReturn {
  const [filters, setFilters] = useState<FilterState>({
    priority: '',
    assignee: '',
    searchQuery: '',
    dateRange: '',
    tag: '',
    customField: EMPTY_CUSTOM_FIELD_FILTER,
  });

  const [filterPresets, setFilterPresets] = useState<FilterPreset[]>(() => {
    const saved = localStorage.getItem(FILTER_PRESETS_KEY);
    return saved ? JSON.parse(saved) : [];
  });

  const [searchQuery, setSearchQuery] = useState('');

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
    setFilters({ priority: '', assignee: '', searchQuery: '', dateRange: '', tag: '', customField: EMPTY_CUSTOM_FIELD_FILTER });
    setSearchQuery('');
  }, []);

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
    setFilters({ ...preset.filters, customField: preset.filters.customField ?? EMPTY_CUSTOM_FIELD_FILTER });
    setSearchQuery(preset.filters.searchQuery);
  }, []);

  const deletePreset = useCallback((presetId: string) => {
    setFilterPresets(prev => prev.filter(p => p.id !== presetId));
  }, []);

  const hasActiveFilters = !!(
    filters.searchQuery ||
    filters.priority ||
    filters.assignee ||
    filters.dateRange ||
    filters.tag ||
    filters.customField.fieldId
  );

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
      !filters.customField.fieldId;
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
        return true;
      }),
    }));
  }, [columns, filters, isInDateRange, activeCustomFieldName, customFields]);

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
    saveCurrentAsPreset,
    applyPreset,
    deletePreset,
    hasActiveFilters,
  };
}