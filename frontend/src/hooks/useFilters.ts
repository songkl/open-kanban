import { useState, useEffect, useCallback } from 'react';

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

export function useFilters() {
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
    setFilters(prev => ({ ...prev, searchQuery }));
  }, [searchQuery]);

  useEffect(() => {
    localStorage.setItem(FILTER_PRESETS_KEY, JSON.stringify(filterPresets));
  }, [filterPresets]);

  useEffect(() => {
    void syncFiltersWithSearch();
  }, [syncFiltersWithSearch]);

  const clearFilters = useCallback(() => {
    setFilters({ priority: '', assignee: '', searchQuery: '', dateRange: '', tag: '' });
    setSearchQuery('');
  }, []);

  const saveCurrentAsPreset = useCallback((name: string) => {
    if (!name?.trim()) return;
    const newPreset: FilterPreset = {
      id: Date.now().toString(),
      name: name.trim(),
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

  const hasActiveFilters = filters.searchQuery || filters.priority || filters.assignee || filters.dateRange || filters.tag;

  return {
    filters,
    setFilters,
    filterPresets,
    searchQuery,
    setSearchQuery,
    clearFilters,
    saveCurrentAsPreset,
    applyPreset,
    deletePreset,
    hasActiveFilters,
  };
}
