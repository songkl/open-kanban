import { useTranslation } from 'react-i18next';
import type { FilterState, FilterPreset } from '../hooks/useFilters';
import { CustomDropdown } from './CustomDropdown';

interface FilterPanelContentProps {
  filters: FilterState;
  uniqueAssignees: string[];
  uniqueTags: string[];
  filterPresets: FilterPreset[];
  showPresetDropdown: boolean;
  onSetFilters: React.Dispatch<React.SetStateAction<FilterState>>;
  onClearFilters: () => void;
  onSaveCurrentAsPreset: () => void;
  onApplyPreset: (preset: FilterPreset) => void;
  onDeletePreset: (presetId: string) => void;
  onSetShowPresetDropdown: (show: boolean) => void;
}

export function FilterPanelContent({
  filters,
  uniqueAssignees,
  uniqueTags,
  filterPresets,
  showPresetDropdown,
  onSetFilters,
  onClearFilters,
  onSaveCurrentAsPreset,
  onApplyPreset,
  onDeletePreset,
  onSetShowPresetDropdown,
}: FilterPanelContentProps) {
  const { t } = useTranslation();

  return (
    <>
      <div className="mb-3">
        <label className="block text-xs font-medium text-zinc-500 mb-1">{t('filter.priority')}</label>
        <CustomDropdown
          options={[
            { value: '', label: t('filter.all') },
            { value: 'high', label: t('filter.high') },
            { value: 'medium', label: t('filter.medium') },
            { value: 'low', label: t('filter.low') },
          ]}
          value={filters.priority}
          onChange={(val) => onSetFilters((prev) => ({ ...prev, priority: val }))}
          className="w-full"
        />
      </div>
      <div className="mb-3">
        <label className="block text-xs font-medium text-zinc-500 mb-1">{t('filter.assignee')}</label>
        <CustomDropdown
          options={[
            { value: '', label: t('filter.all') },
            ...uniqueAssignees.map((a) => ({ value: a, label: a })),
          ]}
          value={filters.assignee}
          onChange={(val) => onSetFilters((prev) => ({ ...prev, assignee: val }))}
          className="w-full"
        />
      </div>
      <div className="mb-3">
        <label className="block text-xs font-medium text-zinc-500 mb-1">{t('filter.dateRange')}</label>
        <CustomDropdown
          options={[
            { value: '', label: t('filter.all') },
            { value: 'today', label: t('filter.today') },
            { value: 'thisWeek', label: t('filter.thisWeek') },
            { value: 'thisMonth', label: t('filter.thisMonth') },
          ]}
          value={filters.dateRange}
          onChange={(val) => onSetFilters((prev) => ({ ...prev, dateRange: val }))}
          className="w-full"
        />
      </div>
      {uniqueTags.length > 0 && (
        <div className="mb-3">
          <label className="block text-xs font-medium text-zinc-500 mb-1">{t('filter.tag')}</label>
          <CustomDropdown
            options={[
              { value: '', label: t('filter.all') },
              ...uniqueTags.map((tag) => ({ value: tag, label: tag })),
            ]}
            value={filters.tag}
            onChange={(val) => onSetFilters((prev) => ({ ...prev, tag: val }))}
            className="w-full"
          />
        </div>
      )}
      <div className="flex gap-2 pt-2 border-t border-zinc-100">
        <button
          onClick={onClearFilters}
          className="flex-1 rounded-md bg-zinc-100 px-2 py-1.5 text-sm text-zinc-700 hover:bg-zinc-200"
        >
          {t('filter.clear')}
        </button>
        <button
          onClick={onSaveCurrentAsPreset}
          className="flex-1 rounded-md bg-blue-500 px-2 py-1.5 text-sm text-white hover:bg-blue-600"
        >
          {t('filter.savePreset')}
        </button>
      </div>
      {filterPresets.length > 0 && (
        <div className="mt-3 pt-3 border-t border-zinc-100">
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs font-medium text-zinc-500">{t('filter.preset')}</label>
            <button
              onClick={() => onSetShowPresetDropdown(!showPresetDropdown)}
              className="text-xs text-blue-500 hover:text-blue-600"
            >
              {showPresetDropdown ? t('filter.collapse') : t('filter.expand')}
            </button>
          </div>
          {showPresetDropdown && (
            <div className="space-y-1">
              {filterPresets.map((preset) => (
                <div key={preset.id} className="flex items-center justify-between group">
                  <button
                    onClick={() => onApplyPreset(preset)}
                    className="flex-1 text-left px-2 py-1 text-sm rounded hover:bg-zinc-100"
                  >
                    {preset.name}
                  </button>
                  <button
                    onClick={() => onDeletePreset(preset.id)}
                    className="opacity-0 group-hover:opacity-100 text-red-500 hover:text-red-600 px-1"
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
                    >
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}