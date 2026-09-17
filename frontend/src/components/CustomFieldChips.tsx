import type { CustomField } from '@/types/kanban';

interface CustomFieldChipsProps {
  meta: Record<string, unknown> | null | undefined;
  customFields: CustomField[];
  maxVisible?: number;
}

/**
 * s-1197: render the values of `task.meta` whose keys match defined
 * custom fields as colored chips. We intentionally ignore meta keys
 * that don't have a matching definition — those belong to the legacy
 * free-form metadata editor (see TaskModal) and are shown there, not
 * here on the card where space is tight.
 */
export function CustomFieldChips({ meta, customFields, maxVisible = 4 }: CustomFieldChipsProps) {
  if (!meta || customFields.length === 0) return null;

  const chips: { field: CustomField; value: unknown }[] = [];
  for (const field of customFields) {
    if (!(field.name in meta)) continue;
    const value = meta[field.name];
    if (value === undefined || value === null || value === '') continue;
    chips.push({ field, value });
  }

  if (chips.length === 0) return null;

  const visible = chips.slice(0, maxVisible);
  const overflow = chips.length - visible.length;

  return (
    <div className="flex flex-wrap gap-1 pl-3 mb-2" data-testid="custom-field-chips">
      {visible.map(({ field, value }) => (
        <CustomFieldChip key={field.id} field={field} value={value} />
      ))}
      {overflow > 0 && (
        <span
          className="inline-flex items-center rounded-full bg-zinc-100 dark:bg-zinc-700 px-2 py-0.5 text-xs font-medium text-zinc-500 dark:text-zinc-400"
          title={`+${overflow} more`}
        >
          +{overflow}
        </span>
      )}
    </div>
  );
}

interface CustomFieldChipProps {
  field: CustomField;
  value: unknown;
}

export function CustomFieldChip({ field, value }: CustomFieldChipProps) {
  const display = formatChipValue(field, value);
  if (!display) return null;

  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium text-white shadow-sm"
      style={{ backgroundColor: field.color }}
      title={`${field.name}: ${display}`}
      data-testid={`custom-field-chip-${field.id}`}
    >
      <span className="opacity-80 mr-1">{field.name}</span>
      <span>{display}</span>
    </span>
  );
}

function formatChipValue(field: CustomField, value: unknown): string {
  if (value === null || value === undefined) return '';
  if (field.type === 'multi-select') {
    if (Array.isArray(value)) return value.filter(v => typeof v === 'string' && v).join(', ');
    if (typeof value === 'string') {
      // legacy CSV form
      return value.split(',').map(s => s.trim()).filter(Boolean).join(', ');
    }
    return '';
  }
  if (field.type === 'date' && typeof value === 'string') {
    // Show short date without time for chips
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}