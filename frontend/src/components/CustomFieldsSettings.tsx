import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CustomField, CustomFieldType } from '@/types/kanban';

interface CustomFieldsSettingsProps {
  isOpen: boolean;
  customFields: CustomField[];
  onClose: () => void;
  onSave: (fields: CustomField[]) => void;
}

const FIELD_COLORS = [
  '#3b82f6', // blue
  '#22c55e', // green
  '#f59e0b', // orange
  '#ef4444', // red
  '#8b5cf6', // purple
  '#06b6d4', // cyan
  '#ec4899', // pink
  '#6b7280', // gray
];

const FIELD_TYPES: CustomFieldType[] = ['text', 'number', 'date', 'single-select', 'multi-select'];

function generateId(): string {
  return `cf-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

function emptyField(type: CustomFieldType = 'text'): CustomField {
  return {
    id: generateId(),
    name: '',
    type,
    color: FIELD_COLORS[Math.floor(Math.random() * FIELD_COLORS.length)],
    options: type === 'single-select' || type === 'multi-select' ? [] : undefined,
  };
}

/**
 * s-1197: column settings modal that lets the user define which custom
 * fields appear on task cards. The fields themselves are stored on the
 * task (via `tasks.meta`) — this component only owns the *definitions*.
 * We snapshot the working list at open so cancelling discards edits
 * without touching storage.
 */
export function CustomFieldsSettings({ isOpen, customFields, onClose, onSave }: CustomFieldsSettingsProps) {
  const { t } = useTranslation();
  const [draftFields, setDraftFields] = useState<CustomField[]>([]);

  useEffect(() => {
    if (isOpen) {
      // Deep-copy so editing the draft doesn't mutate the hook's array
      // reference until the user clicks Save.
      setDraftFields(customFields.map(f => ({ ...f, options: f.options ? [...f.options] : undefined })));
    }
  }, [isOpen, customFields]);

  if (!isOpen) return null;

  const addField = () => {
    setDraftFields(prev => [...prev, emptyField()]);
  };

  const updateField = (id: string, patch: Partial<CustomField>) => {
    setDraftFields(prev => prev.map(f => (f.id === id ? { ...f, ...patch } : f)));
  };

  const removeField = (id: string) => {
    setDraftFields(prev => prev.filter(f => f.id !== id));
  };

  const changeType = (id: string, type: CustomFieldType) => {
    setDraftFields(prev =>
      prev.map(f => {
        if (f.id !== id) return f;
        const needsOptions = type === 'single-select' || type === 'multi-select';
        return {
          ...f,
          type,
          options: needsOptions ? (f.options ?? []) : undefined,
        };
      }),
    );
  };

  const addOption = (id: string) => {
    setDraftFields(prev =>
      prev.map(f => (f.id === id ? { ...f, options: [...(f.options ?? []), ''] } : f)),
    );
  };

  const updateOption = (id: string, index: number, value: string) => {
    setDraftFields(prev =>
      prev.map(f => {
        if (f.id !== id) return f;
        const options = [...(f.options ?? [])];
        options[index] = value;
        return { ...f, options };
      }),
    );
  };

  const removeOption = (id: string, index: number) => {
    setDraftFields(prev =>
      prev.map(f => {
        if (f.id !== id) return f;
        const options = [...(f.options ?? [])];
        options.splice(index, 1);
        return { ...f, options };
      }),
    );
  };

  const handleSave = () => {
    // Strip empty names — a field without a name is meaningless and would
    // pollute the task modal / filter UI. Same for empty option strings.
    const cleaned = draftFields
      .filter(f => f.name.trim().length > 0)
      .map(f => {
        if (f.type !== 'single-select' && f.type !== 'multi-select') return { ...f, options: undefined };
        const opts = (f.options ?? []).map(o => o.trim()).filter(o => o.length > 0);
        return { ...f, options: opts };
      });
    onSave(cleaned);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
      data-testid="custom-fields-settings-backdrop"
    >
      <div
        className="w-full max-w-2xl rounded-2xl bg-white dark:bg-zinc-800 p-6 shadow-xl border border-zinc-100 dark:border-zinc-700 max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        data-testid="custom-fields-settings-modal"
      >
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-indigo-500 text-white">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/>
              <line x1="7" y1="7" x2="7.01" y2="7"/>
            </svg>
          </div>
          <div>
            <h2 className="text-xl font-bold text-zinc-800 dark:text-zinc-100">{t('customFields.title')}</h2>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('customFields.subtitle')}</p>
          </div>
        </div>

        <div className="space-y-3">
          {draftFields.length === 0 && (
            <div className="rounded-xl border border-dashed border-zinc-200 dark:border-zinc-700 p-6 text-center text-sm text-zinc-500 dark:text-zinc-400">
              {t('customFields.empty')}
            </div>
          )}

          {draftFields.map((field, idx) => (
            <div
              key={field.id}
              className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900/40 p-4 space-y-3"
              data-testid={`custom-field-row-${idx}`}
            >
              <div className="flex items-center gap-2">
                <span
                  className="inline-block h-5 w-5 rounded-md flex-shrink-0 ring-2 ring-white dark:ring-zinc-800 shadow"
                  style={{ backgroundColor: field.color }}
                  aria-hidden
                />
                <input
                  type="text"
                  value={field.name}
                  onChange={(e) => updateField(field.id, { name: e.target.value })}
                  placeholder={t('customFields.namePlaceholder')}
                  className="flex-1 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
                  data-testid={`custom-field-name-${idx}`}
                />
                <select
                  value={field.type}
                  onChange={(e) => changeType(field.id, e.target.value as CustomFieldType)}
                  className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-2 text-sm"
                  data-testid={`custom-field-type-${idx}`}
                >
                  {FIELD_TYPES.map(type => (
                    <option key={type} value={type}>
                      {t(`customFields.types.${type}`)}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => removeField(field.id)}
                  className="rounded-lg p-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30"
                  title={t('customFields.remove')}
                  data-testid={`custom-field-remove-${idx}`}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                    <path d="M10 11v6M14 11v6"/>
                  </svg>
                </button>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-xs text-zinc-500 dark:text-zinc-400">{t('customFields.color')}</span>
                <div className="flex gap-1.5">
                  {FIELD_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => updateField(field.id, { color: c })}
                      className={`h-5 w-5 rounded-md transition-all hover:scale-110 ${
                        field.color === c ? 'ring-2 ring-offset-1 ring-blue-500' : ''
                      }`}
                      style={{ backgroundColor: c }}
                      aria-label={`color-${c}`}
                    />
                  ))}
                </div>
              </div>

              {(field.type === 'single-select' || field.type === 'multi-select') && (
                <div className="space-y-1.5 pl-1">
                  <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                    {t('customFields.options')}
                  </label>
                  {(field.options ?? []).map((opt, optIdx) => (
                    <div key={optIdx} className="flex items-center gap-2">
                      <input
                        type="text"
                        value={opt}
                        onChange={(e) => updateOption(field.id, optIdx, e.target.value)}
                        placeholder={t('customFields.optionPlaceholder')}
                        className="flex-1 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-1.5 text-sm"
                      />
                      <button
                        type="button"
                        onClick={() => removeOption(field.id, optIdx)}
                        className="rounded p-1 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30"
                        title={t('customFields.removeOption')}
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="18" y1="6" x2="6" y2="18"/>
                          <line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => addOption(field.id)}
                    className="text-xs text-blue-500 hover:text-blue-600 font-medium"
                  >
                    + {t('customFields.addOption')}
                  </button>
                </div>
              )}
            </div>
          ))}

          <button
            type="button"
            onClick={addField}
            className="w-full rounded-xl border border-dashed border-zinc-300 dark:border-zinc-600 px-4 py-3 text-sm font-medium text-zinc-500 dark:text-zinc-400 hover:border-blue-400 hover:text-blue-500 transition-colors"
            data-testid="custom-fields-add"
          >
            + {t('customFields.addField')}
          </button>
        </div>

        <div className="mt-6 flex gap-3 border-t border-zinc-100 dark:border-zinc-700 pt-4">
          <button
            onClick={onClose}
            className="flex-1 rounded-xl bg-zinc-100 dark:bg-zinc-700 px-4 py-3 font-medium text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-600 transition-colors"
          >
            {t('customFields.cancel')}
          </button>
          <button
            onClick={handleSave}
            className="flex-1 rounded-xl bg-gradient-to-r from-blue-500 to-blue-600 px-4 py-3 font-medium text-white hover:from-blue-600 hover:to-blue-700 transition-all shadow-sm"
            data-testid="custom-fields-save"
          >
            {t('customFields.save')}
          </button>
        </div>
      </div>
    </div>
  );
}