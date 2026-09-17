import { useTranslation } from 'react-i18next';
import type { CustomField } from '@/types/kanban';

interface CustomFieldEditorProps {
  customFields: CustomField[];
  /**
   * Current value of the task's meta, indexed by `CustomField.name`.
   * The editor mutates this map directly via `onChange`; the caller is
   * responsible for shaping it back into the wire format the API
   * expects (the modal already does this).
   */
  values: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  isEditing: boolean;
}

/**
 * s-1197: render a typed input for each defined custom field. Renders
 * nothing when no fields are defined so the surrounding modal layout
 * stays clean for boards that haven't opted into custom fields.
 */
export function CustomFieldEditor({ customFields, values, onChange, isEditing }: CustomFieldEditorProps) {
  if (customFields.length === 0) return null;

  const setValue = (name: string, value: unknown) => {
    const next = { ...values };
    if (value === '' || value === null || value === undefined) {
      delete next[name];
    } else {
      next[name] = value;
    }
    onChange(next);
  };

  return (
    <div className="space-y-3" data-testid="custom-field-editor">
      {customFields.map((field) => {
        const raw = values[field.name];
        const displayValue = formatDisplayValue(field, raw);
        return (
          <div key={field.id} className="flex items-start gap-2">
            <span
              className="mt-2 inline-block h-2.5 w-2.5 rounded-md flex-shrink-0 shadow-sm"
              style={{ backgroundColor: field.color }}
              aria-hidden
            />
            <div className="flex-1 min-w-0">
              <label className="mb-1 block text-sm font-medium text-zinc-600 dark:text-zinc-300">
                {field.name}
              </label>
              {!isEditing ? (
                <div className="text-sm text-zinc-700 dark:text-zinc-200" data-testid={`cf-view-${field.id}`}>
                  {displayValue || <span className="text-zinc-400">—</span>}
                </div>
              ) : (
                renderInput(field, raw, (v) => setValue(field.name, v))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function renderInput(
  field: CustomField,
  raw: unknown,
  onValueChange: (value: unknown) => void,
) {
  const { t } = useTranslation();
  if (field.type === 'text') {
    return (
      <input
        type="text"
        value={typeof raw === 'string' ? raw : ''}
        onChange={(e) => onValueChange(e.target.value)}
        className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-2 text-sm bg-white dark:bg-zinc-800"
        placeholder={t('customFields.editor.placeholder')}
        data-testid={`cf-input-${field.id}`}
      />
    );
  }
  if (field.type === 'number') {
    return (
      <input
        type="number"
        value={raw === undefined || raw === null ? '' : String(raw)}
        onChange={(e) => {
          const v = e.target.value;
          onValueChange(v === '' ? '' : Number(v));
        }}
        className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-2 text-sm bg-white dark:bg-zinc-800"
        data-testid={`cf-input-${field.id}`}
      />
    );
  }
  if (field.type === 'date') {
    const dateStr = typeof raw === 'string' ? raw.slice(0, 10) : '';
    return (
      <input
        type="date"
        value={dateStr}
        onChange={(e) => onValueChange(e.target.value)}
        className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-2 text-sm bg-white dark:bg-zinc-800"
        data-testid={`cf-input-${field.id}`}
      />
    );
  }
  if (field.type === 'single-select') {
    const options = field.options ?? [];
    return (
      <select
        value={typeof raw === 'string' ? raw : ''}
        onChange={(e) => onValueChange(e.target.value)}
        className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-2 text-sm bg-white dark:bg-zinc-800"
        data-testid={`cf-input-${field.id}`}
      >
        <option value="">{t('filter.all')}</option>
        {options.map((opt) => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
    );
  }
  if (field.type === 'multi-select') {
    const current = Array.isArray(raw)
      ? raw.map(v => String(v))
      : typeof raw === 'string'
      ? raw.split(',').map(s => s.trim()).filter(Boolean)
      : [];
    const options = field.options ?? [];
    const toggle = (opt: string) => {
      if (current.includes(opt)) {
        onValueChange(current.filter(o => o !== opt));
      } else {
        onValueChange([...current, opt]);
      }
    };
    return (
      <div className="flex flex-wrap gap-2" data-testid={`cf-input-${field.id}`}>
        {options.map((opt) => {
          const selected = current.includes(opt);
          return (
            <button
              key={opt}
              type="button"
              onClick={() => toggle(opt)}
              className={`rounded-full px-3 py-1 text-xs font-medium border transition-colors ${
                selected
                  ? 'border-transparent text-white shadow-sm'
                  : 'border-zinc-200 dark:border-zinc-600 text-zinc-600 dark:text-zinc-300 hover:border-blue-400'
              }`}
              style={selected ? { backgroundColor: field.color } : undefined}
              data-testid={`cf-chip-${field.id}-${opt}`}
            >
              {opt}
            </button>
          );
        })}
      </div>
    );
  }
  return null;
}

function formatDisplayValue(field: CustomField, raw: unknown): string {
  if (raw === undefined || raw === null || raw === '') return '';
  if (field.type === 'multi-select') {
    if (Array.isArray(raw)) return raw.map(v => String(v)).filter(Boolean).join(', ');
    if (typeof raw === 'string') return raw;
    return '';
  }
  if (field.type === 'date' && typeof raw === 'string') {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  if (typeof raw === 'string' || typeof raw === 'number') return String(raw);
  return '';
}