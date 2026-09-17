import { useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { SearchBar } from './SearchBar';
import { FilterPanelContent } from './FilterPanelContent';
import type { FilterPreset, FilterState } from '../hooks/useFilters';
import type { CustomField } from '@/types/kanban';

interface BoardToolbarProps {
  searchQuery: string;
  filters: FilterState;
  filterPresets: FilterPreset[];
  uniqueAssignees: string[];
  uniqueTags: string[];
  uniqueCustomFieldValues: Record<string, string[]>;
  customFields: CustomField[];
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
  canCreateTask?: boolean;
  isMobile?: boolean;
}

export function BoardToolbar({
  searchQuery,
  filters,
  filterPresets,
  uniqueAssignees,
  uniqueTags,
  uniqueCustomFieldValues,
  customFields,
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
  canCreateTask = true,
  isMobile = false,
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

  const activeFilterCount = [
    filters.searchQuery,
    filters.priority,
    filters.assignee,
    filters.dateRange,
    filters.tag,
    filters.customField.fieldId,
  ].filter(Boolean).length;

  return (
    <div className="flex items-center gap-2 sm:gap-3 order-3 sm:order-2 w-full sm:w-auto mt-2 sm:mt-0">
      <div className={isMobile ? 'flex-1 min-w-0' : ''}>
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
          isMobile={isMobile}
        />
      </div>

      <div className="relative">
        <button
          onClick={onToggleFilterPanel}
          aria-label={t('filter.filter')}
          className={`flex items-center justify-center min-h-[36px] min-w-[36px] sm:min-h-0 sm:min-w-0 sm:gap-1.5 sm:px-3 sm:py-1.5 rounded-md text-sm ${
            hasActiveFilters
              ? 'bg-blue-100 text-blue-700 border border-blue-300'
              : 'bg-zinc-200 text-zinc-700 dark:text-zinc-400 border border-transparent'
          } hover:bg-zinc-300 dark:hover:bg-zinc-600`}
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
          <span className="hidden sm:inline">{t('filter.filter')}</span>
          {hasActiveFilters && (
            <span className="ml-1 rounded-full bg-blue-500 text-white text-xs w-4 h-4 flex items-center justify-center">
              {activeFilterCount}
            </span>
          )}
        </button>
        {showFilterPanel && (
          <div
            ref={filterPanelRef}
            className="absolute right-0 top-full mt-2 w-64 max-w-[calc(100vw-1.5rem)] rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 p-3 shadow-lg z-50"
          >
            <FilterPanelContent
              filters={filters}
              uniqueAssignees={uniqueAssignees}
              uniqueTags={uniqueTags}
              uniqueCustomFieldValues={uniqueCustomFieldValues}
              customFields={customFields}
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
          if (!canCreateTask) return;
          onAddTask();
        }}
        disabled={!canCreateTask}
        title={canCreateTask ? undefined : t('task.createNoPermission')}
        aria-label={t('task.create')}
        className={`flex items-center justify-center min-h-[36px] min-w-[36px] sm:min-h-0 sm:min-w-0 sm:gap-1.5 sm:px-4 sm:py-1.5 rounded-md text-sm font-medium text-white ${
          canCreateTask
            ? 'bg-blue-500 hover:bg-blue-600'
            : 'bg-zinc-300 dark:bg-zinc-600 cursor-not-allowed'
        }`}
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
        <span className="hidden sm:inline ml-1.5">{t('task.create')}</span>
      </button>
    </div>
  );
}
