import { useState, useEffect, useCallback, useMemo, startTransition } from 'react';
import type { Column as ColumnType } from '../types/kanban';

const FILTER_PRESETS_KEY = 'filterPresets';

export interface FilterState {
  priority: string;
  assignee: string;
  searchQuery: string;
  dateRange: string;
  tag: string;
}

export interface FilterPreset {
  id: string;
  name: string;
  filters: FilterState;
}

interface UseFiltersOptions {
  columns?: ColumnType[];
}

interface UseFiltersReturn {
  filters: FilterState;
  filterPresets: FilterPreset[];
  searchQuery: string;
  uniqueAssignees: string[];
  uniqueTags: string[];
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

export function useFilters({ columns = [] }: UseFiltersOptions = {}): UseFiltersReturn {
  const [filters, setFilters] = useState<FilterState>({
    priority: '',
    assignee: '',
    searchQuery: '',
    dateRange: '',
    tag: '',
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
    setFilters({ priority: '', assignee: '', searchQuery: '', dateRange: '', tag: '' });
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
    setFilters(preset.filters);
    setSearchQuery(preset.filters.searchQuery);
  }, []);

  const deletePreset = useCallback((presetId: string) => {
    setFilterPresets(prev => prev.filter(p => p.id !== presetId));
  }, []);

  const hasActiveFilters = !!(filters.searchQuery || filters.priority || filters.assignee || filters.dateRange || filters.tag);

  const allTasks = useMemo(() => columns.flatMap(col => col.tasks || []), [columns]);
  
  const uniqueAssignees = useMemo(() => [...new Set(allTasks.filter(t => t.assignee).map(t => t.assignee as string))], [allTasks]);
  
  const uniqueTags = useMemo(() => [...new Set(allTasks.filter(t => t.meta && typeof t.meta === 'object' && '标签' in t.meta).map(t => (t.meta as Record<string, unknown>)['标签'] as string).filter(Boolean))], [allTasks]);

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

  const getFilteredColumns = useCallback(() => {
    if (!filters.searchQuery && !filters.priority && !filters.assignee && !filters.dateRange && !filters.tag) {
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
        return true;
      })
    }));
  }, [columns, filters, isInDateRange]);

  return {
    filters,
    filterPresets,
    searchQuery,
    uniqueAssignees,
    uniqueTags,
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