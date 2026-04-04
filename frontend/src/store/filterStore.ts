import { create } from 'zustand';
import { persist } from 'zustand/middleware';

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

interface FilterStore {
  filters: FilterState;
  filterPresets: FilterPreset[];
  searchQuery: string;
  showFilterPanel: boolean;
  showPresetDropdown: boolean;

  setFilters: (filters: Partial<FilterState>) => void;
  setSearchQuery: (query: string) => void;
  setShowFilterPanel: (show: boolean) => void;
  setShowPresetDropdown: (show: boolean) => void;
  clearFilters: () => void;
  saveCurrentAsPreset: (name: string) => void;
  applyPreset: (preset: FilterPreset) => void;
  deletePreset: (presetId: string) => void;
  getHasActiveFilters: () => boolean;
}

const initialFilters: FilterState = {
  priority: '',
  assignee: '',
  searchQuery: '',
  dateRange: '',
  tag: '',
};

export const useFilterStore = create<FilterStore>()(
  persist(
    (set, get) => ({
      filters: initialFilters,
      filterPresets: [],
      searchQuery: '',
      showFilterPanel: false,
      showPresetDropdown: false,

      setFilters: (newFilters) => set((state) => ({
        filters: { ...state.filters, ...newFilters }
      })),

      setSearchQuery: (query) => {
        set({ searchQuery: query });
        set((state) => ({
          filters: { ...state.filters, searchQuery: query }
        }));
      },

      setShowFilterPanel: (show) => set({ showFilterPanel: show }),
      setShowPresetDropdown: (show) => set({ showPresetDropdown: show }),

      clearFilters: () => set({
        filters: initialFilters,
        searchQuery: '',
      }),

      saveCurrentAsPreset: (name) => {
        if (!name?.trim()) return;
        const state = get();
        const newPreset: FilterPreset = {
          id: Date.now().toString(),
          name: name.trim(),
          filters: { ...state.filters },
        };
        set({ filterPresets: [...state.filterPresets, newPreset] });
      },

      applyPreset: (preset) => set({
        filters: preset.filters,
        searchQuery: preset.filters.searchQuery,
        showPresetDropdown: false,
      }),

      deletePreset: (presetId) => set((state) => ({
        filterPresets: state.filterPresets.filter(p => p.id !== presetId)
      })),

      getHasActiveFilters: () => {
        const { filters } = get();
        return !!(filters.searchQuery || filters.priority || filters.assignee || filters.dateRange || filters.tag);
      },
    }),
    {
      name: 'filter-storage',
      partialize: (state) => ({ filterPresets: state.filterPresets }),
    }
  )
);
