import { useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { SearchBar } from './SearchBar';
import { FilterPanelContent } from './FilterPanelContent';
import type { FilterPreset, FilterState } from '../hooks/useFilters';

interface BoardToolbarProps {
  searchQuery: string;
  filters: FilterState;
  filterPresets: FilterPreset[];
  uniqueAssignees: string[];
  uniqueTags: string[];
  hasActiveFilters: boolean;
  showFilterPanel: boolean;
  showPresetDropdown: boolean;
  onSetSearchQuery: (value: string) => void;
  onSetFilters: React.Dispatch<React.SetStateAction<FilterState>>;
  onClearFilters: () => void;
  onSaveCurrentAsPreset: () => void;
  onApplyPreset: (preset: FilterPreset) => void;
  onDeletePreset: (presetId: string) => void;
  onSetShowPresetDropdown: (show: boolean) => void;
  onToggleFilterPanel: () => void;
  onCloseFilterPanel: () => void;
  onAddTask: () => void;
}

export function BoardToolbar({
  searchQuery,
  filters,
  filterPresets,
  uniqueAssignees,
  uniqueTags,
  hasActiveFilters,
  showFilterPanel,
  showPresetDropdown,
  onSetSearchQuery,
  onSetFilters,
  onClearFilters,
  onSaveCurrentAsPreset,
  onApplyPreset,
  onDeletePreset,
  onSetShowPresetDropdown,
  onToggleFilterPanel,
  onCloseFilterPanel,
  onAddTask,
}: BoardToolbarProps) {
  const { t } = useTranslation();
  const filterPanelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (showFilterPanel && filterPanelRef.current && !filterPanelRef.current.contains(e.target as Node)) {
        onCloseFilterPanel();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showFilterPanel, onCloseFilterPanel]);

  return (
    <div className="flex items-center gap-3">
      <SearchBar
        value={searchQuery}
        onChange={(value) => {
          onSetSearchQuery(value);
          onSetFilters((prev) => ({ ...prev, searchQuery: value }));
        }}
        onClear={() => {
          onSetSearchQuery('');
          onSetFilters((prev) => ({ ...prev, searchQuery: '' }));
        }}
      />

      <div className="relative">
        <button
          onClick={onToggleFilterPanel}
          className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm ${
            hasActiveFilters
              ? 'bg-blue-100 text-blue-700 border border-blue-300'
              : 'bg-zinc-200 text-zinc-700 border border-transparent'
          } hover:bg-zinc-300`}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
          </svg>
          {t('filter.filter')}
          {hasActiveFilters && (
            <span className="ml-1 rounded-full bg-blue-500 text-white text-xs w-4 h-4 flex items-center justify-center">
              {[filters.searchQuery, filters.priority, filters.assignee, filters.dateRange, filters.tag].filter(Boolean).length}
            </span>
          )}
        </button>
        {showFilterPanel && (
          <div
            ref={filterPanelRef}
            className="absolute right-0 top-full mt-2 w-64 rounded-lg border border-zinc-200 bg-white p-3 shadow-lg z-50"
          >
            <FilterPanelContent
              filters={filters}
              uniqueAssignees={uniqueAssignees}
              uniqueTags={uniqueTags}
              filterPresets={filterPresets}
              showPresetDropdown={showPresetDropdown}
              onSetFilters={onSetFilters}
              onClearFilters={onClearFilters}
              onSaveCurrentAsPreset={onSaveCurrentAsPreset}
              onApplyPreset={onApplyPreset}
              onDeletePreset={onDeletePreset}
              onSetShowPresetDropdown={onSetShowPresetDropdown}
            />
          </div>
        )}
      </div>

      <button
        onClick={() => {
          onAddTask();
        }}
        className="flex items-center gap-1.5 rounded-md bg-blue-500 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-600"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        {t('task.create')}
      </button>
    </div>
  );
}
