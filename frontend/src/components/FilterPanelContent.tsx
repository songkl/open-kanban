import { useTranslation } from 'react-i18next';
import type { FilterState, FilterPreset } from '../hooks/useBoardState';

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
        <select
          value={filters.priority}
          onChange={(e) => onSetFilters((prev) => ({ ...prev, priority: e.target.value }))}
          className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-sm"
        >
          <option value="">{t('filter.all')}</option>
          <option value="high">{t('filter.high')}</option>
          <option value="medium">{t('filter.medium')}</option>
          <option value="low">{t('filter.low')}</option>
        </select>
      </div>
      <div className="mb-3">
        <label className="block text-xs font-medium text-zinc-500 mb-1">{t('filter.assignee')}</label>
        <select
          value={filters.assignee}
          onChange={(e) => onSetFilters((prev) => ({ ...prev, assignee: e.target.value }))}
          className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-sm"
        >
          <option value="">{t('filter.all')}</option>
          {uniqueAssignees.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </div>
      <div className="mb-3">
        <label className="block text-xs font-medium text-zinc-500 mb-1">{t('filter.dateRange')}</label>
        <select
          value={filters.dateRange}
          onChange={(e) => onSetFilters((prev) => ({ ...prev, dateRange: e.target.value }))}
          className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-sm"
        >
          <option value="">{t('filter.all')}</option>
          <option value="today">{t('filter.today')}</option>
          <option value="thisWeek">{t('filter.thisWeek')}</option>
          <option value="thisMonth">{t('filter.thisMonth')}</option>
        </select>
      </div>
      {uniqueTags.length > 0 && (
        <div className="mb-3">
          <label className="block text-xs font-medium text-zinc-500 mb-1">{t('filter.tag')}</label>
          <select
            value={filters.tag}
            onChange={(e) => onSetFilters((prev) => ({ ...prev, tag: e.target.value }))}
            className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-sm"
          >
            <option value="">{t('filter.all')}</option>
            {uniqueTags.map((tag) => (
              <option key={tag} value={tag}>
                {tag}
              </option>
            ))}
          </select>
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