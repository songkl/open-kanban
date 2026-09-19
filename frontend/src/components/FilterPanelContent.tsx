import { useTranslation } from 'react-i18next';
import type { FilterState, FilterPreset } from '../hooks/useFilters';
import type { CustomField } from '@/types/kanban';
import { CustomDropdown } from './CustomDropdown';

interface FilterPanelContentProps {
  filters: FilterState;
  uniqueAssignees: string[];
  uniqueTags: string[];
  uniqueCustomFieldValues: Record<string, string[]>;
  customFields: CustomField[];
  filterPresets: FilterPreset[];
  showPresetDropdown: boolean;
  onSetFilters: React.Dispatch<React.SetStateAction<FilterState>>;
  onClearFilters: () => void;
  onSaveCurrentAsPreset?: () => void;
  onApplyPreset?: (preset: FilterPreset) => void;
  onDeletePreset?: (presetId: string) => void;
  onSetShowPresetDropdown?: (show: boolean) => void;
  hideBoardDefaults?: boolean;
  children?: React.ReactNode;
}

export function FilterPanelContent({
  filters,
  uniqueAssignees,
  uniqueTags,
  uniqueCustomFieldValues,
  customFields,
  filterPresets,
  showPresetDropdown,
  onSetFilters,
  onClearFilters,
  onSaveCurrentAsPreset,
  onApplyPreset,
  onDeletePreset,
  onSetShowPresetDropdown,
  hideBoardDefaults = false,
  children,
}: FilterPanelContentProps) {
  void children;
  void hideBoardDefaults;
  const { t } = useTranslation();

  // s-1197: render the custom-field filter as two coupled dropdowns —
  // first pick the field (any non-archived definition), then pick a
  // value from the unique values seen across this board's tasks. We
  // deliberately keep both dropdowns mounted even when the field is
  // empty so the layout doesn't jump when toggled.
  const selectedField = customFields.find(f => f.id === filters.customField.fieldId);
  const valueOptions = selectedField ? (uniqueCustomFieldValues[selectedField.id] ?? []) : [];

  return (
    <>
      <div className="mb-3">
        <label htmlFor="filter-priority" className="block text-xs font-medium text-zinc-500 dark:text-zinc-500 mb-1">{t('filter.priority')}</label>
        <CustomDropdown
          id="filter-priority"
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
        <label htmlFor="filter-assignee" className="block text-xs font-medium text-zinc-500 dark:text-zinc-500 mb-1">{t('filter.assignee')}</label>
        <CustomDropdown
          id="filter-assignee"
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
        <label htmlFor="filter-dateRange" className="block text-xs font-medium text-zinc-500 dark:text-zinc-500 mb-1">{t('filter.dateRange')}</label>
        <CustomDropdown
          id="filter-dateRange"
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
          <label htmlFor="filter-tag" className="block text-xs font-medium text-zinc-500 dark:text-zinc-500 mb-1">{t('filter.tag')}</label>
          <CustomDropdown
            id="filter-tag"
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
      <div className="mb-3">
        <label htmlFor="filter-runStatus" className="block text-xs font-medium text-zinc-500 dark:text-zinc-500 mb-1">{t('filter.runStatus')}</label>
        <CustomDropdown
          id="filter-runStatus"
          options={[
            { value: '', label: t('filter.all') },
            { value: 'none', label: t('filter.runStatusNone') },
            { value: 'running', label: t('filter.runStatusRunning') },
            { value: 'completed', label: t('filter.runStatusCompleted') },
            { value: 'failed', label: t('filter.runStatusFailed') },
            { value: 'queued', label: t('filter.runStatusQueued') },
          ]}
          value={filters.runStatus}
          onChange={(val) => onSetFilters((prev) => ({ ...prev, runStatus: val as FilterState['runStatus'] }))}
          className="w-full"
        />
      </div>
      <div className="mb-3">
        <label htmlFor="filter-hasComments" className="block text-xs font-medium text-zinc-500 dark:text-zinc-500 mb-1">{t('filter.hasComments')}</label>
        <CustomDropdown
          id="filter-hasComments"
          options={[
            { value: '', label: t('filter.all') },
            { value: 'yes', label: t('filter.yes') },
            { value: 'no', label: t('filter.no') },
          ]}
          value={filters.hasComments}
          onChange={(val) => onSetFilters((prev) => ({ ...prev, hasComments: val as FilterState['hasComments'] }))}
          className="w-full"
        />
      </div>
      <div className="mb-3">
        <label htmlFor="filter-hasSubtasks" className="block text-xs font-medium text-zinc-500 dark:text-zinc-500 mb-1">{t('filter.hasSubtasks')}</label>
        <CustomDropdown
          id="filter-hasSubtasks"
          options={[
            { value: '', label: t('filter.all') },
            { value: 'yes', label: t('filter.yes') },
            { value: 'no', label: t('filter.no') },
          ]}
          value={filters.hasSubtasks}
          onChange={(val) => onSetFilters((prev) => ({ ...prev, hasSubtasks: val as FilterState['hasSubtasks'] }))}
          className="w-full"
        />
      </div>
      {customFields.length > 0 && (
        <div className="mb-3">
          <label htmlFor="filter-customField" className="block text-xs font-medium text-zinc-500 dark:text-zinc-500 mb-1">{t('filter.customField')}</label>
          <CustomDropdown
            id="filter-customField"
            options={[
              { value: '', label: t('filter.all') },
              ...customFields.map((f) => ({ value: f.id, label: f.name })),
            ]}
            value={filters.customField.fieldId}
            onChange={(val) =>
              onSetFilters((prev) => ({ ...prev, customField: { fieldId: val, value: '' } }))
            }
            className="w-full"
          />
        </div>
      )}
      {customFields.length > 0 && filters.customField.fieldId && (
        <div className="mb-3">
          <label htmlFor="filter-customField-value" className="block text-xs font-medium text-zinc-500 dark:text-zinc-500 mb-1">{t('filter.customFieldValue')}</label>
          <CustomDropdown
            id="filter-customField-value"
            options={[
              { value: '', label: t('filter.all') },
              ...valueOptions.map((v) => ({ value: v, label: v })),
            ]}
            value={filters.customField.value}
            onChange={(val) =>
              onSetFilters((prev) => ({ ...prev, customField: { ...prev.customField, value: val } }))
            }
            className="w-full"
            disabled={valueOptions.length === 0}
          />
        </div>
      )}
      <div className="flex gap-2 pt-2 border-t border-zinc-100">
        <button
          onClick={onClearFilters}
          className="flex-1 rounded-md bg-zinc-100 dark:bg-zinc-700 px-2 py-1.5 text-sm text-zinc-700 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-600"
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
            <label className="text-xs font-medium text-zinc-500 dark:text-zinc-500">{t('filter.preset')}</label>
            <button
              onClick={() => onSetShowPresetDropdown?.(!showPresetDropdown)}
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
                    onClick={() => onApplyPreset?.(preset)}
                    className="flex-1 text-left px-2 py-1 text-sm rounded hover:bg-zinc-100 dark:hover:bg-zinc-600"
                  >
                    {preset.name}
                  </button>
                  <button
                    onClick={() => onDeletePreset?.(preset.id)}
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
