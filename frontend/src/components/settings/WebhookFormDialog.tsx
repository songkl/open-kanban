import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  Webhook,
  WebhookCreate,
  WebhookEventCatalogueEntry,
} from '@/types/kanban';
import { showErrorToast } from '../ErrorToast';

export interface WebhookFormDialogProps {
  open: boolean;
  initial?: Webhook | null;
  events: WebhookEventCatalogueEntry[];
  saving?: boolean;
  onCancel: () => void;
  onSubmit: (data: WebhookCreate) => Promise<void>;
}

// Reusable HTTP URL validator: https only (with a narrow
// localhost carve-out so operators can point at a local receiver
// during development) plus §5.4's allow-private carve-out. The
// backend re-validates server-side so this is purely a UX guard.
export function isValidWebhookUrl(raw: string, allowInsecure = true): boolean {
  const value = raw.trim();
  if (!value) return false;
  try {
    const u = new URL(value);
    if (u.protocol === 'https:') return Boolean(u.hostname);
    if (u.protocol === 'http:' && allowInsecure) {
      const h = u.hostname;
      if (!h) return false;
      if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
    }
    return false;
  } catch {
    return false;
  }
}

interface HeaderRow {
  id: string;
  key: string;
  value: string;
}

interface FilterState {
  boardIds: string[];
  columnIds: string[];
  priorities: string[];
  assigneeIds: string[];
}

interface FormState {
  name: string;
  url: string;
  eventTypes: string[];
  filters: FilterState;
  headers: HeaderRow[];
  enabled: boolean;
  timeoutSec: number;
  maxRetries: number;
}

interface FormErrors {
  name?: string;
  url?: string;
  eventTypes?: string;
  timeoutSec?: string;
  maxRetries?: string;
  headers?: string;
}

const TIMEOUT_MIN = 5;
const TIMEOUT_MAX = 60;
const TIMEOUT_DEFAULT = 10;
const RETRY_MIN = 0;
const RETRY_MAX = 10;
const RETRY_DEFAULT = 5;
const NAME_MIN = 1;
const NAME_MAX = 64;
const MAX_HEADERS = 10;

const PRIORITIES = ['low', 'medium', 'high'];

function makeHeaderRow(): HeaderRow {
  return { id: `hdr-${Math.random().toString(36).slice(2, 10)}`, key: '', value: '' };
}

function emptyFilters(): FilterState {
  return { boardIds: [], columnIds: [], priorities: [], assigneeIds: [] };
}

function safeParseObject(raw: string): Record<string, unknown> | null {
  if (!raw || !raw.trim() || raw.trim() === '{}') return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function safeParseFilters(raw: string): FilterState {
  const obj = safeParseObject(raw);
  if (!obj) return emptyFilters();
  const result = emptyFilters();
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  if (Array.isArray(obj.boardIds)) result.boardIds = arr(obj.boardIds);
  if (Array.isArray(obj.columnIds)) result.columnIds = arr(obj.columnIds);
  if (Array.isArray(obj.priorities)) result.priorities = arr(obj.priorities);
  if (Array.isArray(obj.assigneeIds)) result.assigneeIds = arr(obj.assigneeIds);
  return result;
}

function safeParseHeaders(raw: string): HeaderRow[] {
  const obj = safeParseObject(raw);
  if (!obj) return [];
  return Object.entries(obj).map(([key, value]) => ({
    id: `hdr-${Math.random().toString(36).slice(2, 10)}`,
    key,
    value: value == null ? '' : String(value),
  }));
}

function filtersToString(filters: FilterState): string {
  const obj: Record<string, string[]> = {};
  if (filters.boardIds.length) obj.boardIds = filters.boardIds;
  if (filters.columnIds.length) obj.columnIds = filters.columnIds;
  if (filters.priorities.length) obj.priorities = filters.priorities;
  if (filters.assigneeIds.length) obj.assigneeIds = filters.assigneeIds;
  return Object.keys(obj).length ? JSON.stringify(obj) : '{}';
}

function headersToString(headers: HeaderRow[]): string {
  const obj: Record<string, string> = {};
  for (const row of headers) {
    const key = row.key.trim();
    if (!key) continue;
    obj[key] = row.value;
  }
  return Object.keys(obj).length ? JSON.stringify(obj) : '{}';
}

function eventTypesToString(types: string[]): string {
  return JSON.stringify(types);
}

function formFromWebhook(webhook: Webhook): FormState {
  let parsedEvents: string[] = [];
  try {
    const parsed = JSON.parse(webhook.eventTypes || '[]');
    if (Array.isArray(parsed)) {
      parsedEvents = parsed.filter((x): x is string => typeof x === 'string');
    }
  } catch {
    parsedEvents = [];
  }
  return {
    name: webhook.name,
    url: webhook.url,
    eventTypes: parsedEvents,
    filters: safeParseFilters(webhook.filters),
    headers: safeParseHeaders(webhook.headers),
    enabled: webhook.enabled,
    timeoutSec: webhook.timeoutSec || TIMEOUT_DEFAULT,
    maxRetries: webhook.maxRetries ?? RETRY_DEFAULT,
  };
}

function emptyForm(): FormState {
  return {
    name: '',
    url: '',
    eventTypes: [],
    filters: emptyFilters(),
    headers: [],
    enabled: true,
    timeoutSec: TIMEOUT_DEFAULT,
    maxRetries: RETRY_DEFAULT,
  };
}

function validate(form: FormState): FormErrors {
  const errors: FormErrors = {};
  const trimmedName = form.name.trim();
  if (trimmedName.length < NAME_MIN || trimmedName.length > NAME_MAX) {
    errors.name = 'webhooks.form.errors.nameLength';
  }
  if (!isValidWebhookUrl(form.url)) {
    errors.url = 'webhooks.form.errors.urlInvalid';
  }
  if (form.eventTypes.length === 0) {
    errors.eventTypes = 'webhooks.form.errors.eventRequired';
  }
  if (form.timeoutSec < TIMEOUT_MIN || form.timeoutSec > TIMEOUT_MAX) {
    errors.timeoutSec = 'webhooks.form.errors.timeoutRange';
  }
  if (form.maxRetries < RETRY_MIN || form.maxRetries > RETRY_MAX) {
    errors.maxRetries = 'webhooks.form.errors.retriesRange';
  }
  if (form.headers.length > MAX_HEADERS) {
    errors.headers = 'webhooks.form.errors.headersTooMany';
  }
  return errors;
}

function hasErrors(errors: FormErrors): boolean {
  return Object.values(errors).some((v) => Boolean(v));
}

export function WebhookFormDialog({
  open,
  initial,
  events,
  saving,
  onCancel,
  onSubmit,
}: WebhookFormDialogProps) {
  const { t } = useTranslation();
  const [form, setForm] = useState<FormState>(() =>
    initial ? formFromWebhook(initial) : emptyForm()
  );
  const [errors, setErrors] = useState<FormErrors>({});
  const [showFilters, setShowFilters] = useState(false);

  useEffect(() => {
    if (open) {
      setForm(initial ? formFromWebhook(initial) : emptyForm());
      setErrors({});
      setShowFilters(false);
    }
  }, [open, initial]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  const eventOptions = useMemo(() => {
    return [...events].sort((a, b) => a.event.localeCompare(b.event));
  }, [events]);

  if (!open) return null;

  const isEdit = Boolean(initial);

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const toggleEvent = (event: string) => {
    setForm((prev) => {
      const set = new Set(prev.eventTypes);
      if (set.has(event)) set.delete(event);
      else set.add(event);
      return { ...prev, eventTypes: Array.from(set) };
    });
  };

  const toggleFilter = (key: keyof FilterState, value: string) => {
    setForm((prev) => {
      const set = new Set(prev.filters[key]);
      if (set.has(value)) set.delete(value);
      else set.add(value);
      return { ...prev, filters: { ...prev.filters, [key]: Array.from(set) } };
    });
  };

  const addHeader = () => {
    setForm((prev) => {
      if (prev.headers.length >= MAX_HEADERS) return prev;
      return { ...prev, headers: [...prev.headers, makeHeaderRow()] };
    });
  };

  const updateHeader = (id: string, patch: Partial<HeaderRow>) => {
    setForm((prev) => ({
      ...prev,
      headers: prev.headers.map((h) => (h.id === id ? { ...h, ...patch } : h)),
    }));
  };

  const removeHeader = (id: string) => {
    setForm((prev) => ({ ...prev, headers: prev.headers.filter((h) => h.id !== id) }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const v = validate(form);
    setErrors(v);
    if (hasErrors(v)) return;
    const payload: WebhookCreate = {
      name: form.name.trim(),
      url: form.url.trim(),
      eventTypes: eventTypesToString(form.eventTypes),
      filters: filtersToString(form.filters),
      headers: headersToString(form.headers),
      enabled: form.enabled,
      timeoutSec: form.timeoutSec,
      maxRetries: form.maxRetries,
    };
    try {
      await onSubmit(payload);
    } catch (err) {
      showErrorToast((err as Error).message || t('webhooks.form.saveFailed'), 'error');
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={onCancel}
      data-testid="webhook-form-dialog"
    >
      <div
        className="relative z-10 w-full max-w-2xl rounded-2xl bg-white dark:bg-zinc-800 border border-zinc-100 dark:border-zinc-700 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-100 dark:border-zinc-700 px-6 py-4">
          <h3 className="text-lg font-bold text-zinc-800 dark:text-zinc-100">
            {isEdit ? t('webhooks.form.editTitle') : t('webhooks.form.createTitle')}
          </h3>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md bg-zinc-100 dark:bg-zinc-700 px-2 py-1 text-xs text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-600"
            data-testid="webhook-form-close"
          >
            {t('webhooks.form.close')}
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5 px-6 py-5 max-h-[70vh] overflow-y-auto">
          <div>
            <label
              htmlFor="webhook-name"
              className="block text-sm font-medium text-zinc-700 dark:text-zinc-200"
            >
              {t('webhooks.form.name')}
            </label>
            <input
              id="webhook-name"
              type="text"
              value={form.name}
              onChange={(e) => update('name', e.target.value)}
              data-testid="webhook-field-name"
              className="mt-1 w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:bg-zinc-900"
              maxLength={NAME_MAX + 1}
            />
            {errors.name && (
              <p className="mt-1 text-xs text-red-600" data-testid="webhook-error-name">
                {t(errors.name)}
              </p>
            )}
          </div>

          <div>
            <label
              htmlFor="webhook-url"
              className="block text-sm font-medium text-zinc-700 dark:text-zinc-200"
            >
              {t('webhooks.form.url')}
            </label>
            <input
              id="webhook-url"
              type="url"
              value={form.url}
              onChange={(e) => update('url', e.target.value)}
              data-testid="webhook-field-url"
              className="mt-1 w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:bg-zinc-900"
              placeholder="https://example.com/webhook"
            />
            {errors.url && (
              <p className="mt-1 text-xs text-red-600" data-testid="webhook-error-url">
                {t(errors.url)}
              </p>
            )}
          </div>

          <div>
            <span className="block text-sm font-medium text-zinc-700 dark:text-zinc-200">
              {t('webhooks.form.eventTypes')}
            </span>
            {eventOptions.length === 0 ? (
              <p
                className="mt-1 text-xs text-zinc-500 dark:text-zinc-500"
                data-testid="webhook-event-empty"
              >
                {t('webhooks.form.eventCatalogueEmpty')}
              </p>
            ) : (
              <div className="mt-2 flex flex-wrap gap-2" data-testid="webhook-event-list">
                {eventOptions.map((entry) => {
                  const active = form.eventTypes.includes(entry.event);
                  return (
                    <button
                      key={entry.event}
                      type="button"
                      onClick={() => toggleEvent(entry.event)}
                      className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                        active
                          ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200'
                          : 'border-zinc-300 dark:border-zinc-600 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700'
                      }`}
                      data-testid={`webhook-event-${entry.event}`}
                      aria-pressed={active}
                      title={entry.description}
                    >
                      {entry.displayName} <span className="text-zinc-400">({entry.event})</span>
                    </button>
                  );
                })}
              </div>
            )}
            {errors.eventTypes && (
              <p className="mt-1 text-xs text-red-600" data-testid="webhook-error-events">
                {t(errors.eventTypes)}
              </p>
            )}
          </div>

          <div className="rounded-md border border-zinc-200 dark:border-zinc-700">
            <button
              type="button"
              onClick={() => setShowFilters((v) => !v)}
              className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-200"
              data-testid="webhook-filters-toggle"
              aria-expanded={showFilters}
            >
              <span>{t('webhooks.form.filters')}</span>
              <span className="text-zinc-400">{showFilters ? '−' : '+'}</span>
            </button>
            {showFilters && (
              <div className="space-y-3 border-t border-zinc-200 dark:border-zinc-700 px-3 py-3">
                <div>
                  <span className="block text-xs font-medium text-zinc-500 dark:text-zinc-400">
                    {t('webhooks.form.priorities')}
                  </span>
                  <div className="mt-1 flex gap-2">
                    {PRIORITIES.map((priority) => {
                      const active = form.filters.priorities.includes(priority);
                      return (
                        <button
                          key={priority}
                          type="button"
                          onClick={() => toggleFilter('priorities', priority)}
                          className={`rounded-full border px-3 py-1 text-xs ${
                            active
                              ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200'
                              : 'border-zinc-300 dark:border-zinc-600 text-zinc-600 dark:text-zinc-300'
                          }`}
                          data-testid={`webhook-filter-priority-${priority}`}
                          aria-pressed={active}
                        >
                          {priority}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <p className="text-xs text-zinc-500 dark:text-zinc-500">
                  {t('webhooks.form.filtersHint')}
                </p>
              </div>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between">
              <span className="block text-sm font-medium text-zinc-700 dark:text-zinc-200">
                {t('webhooks.form.headers')}
              </span>
              <button
                type="button"
                onClick={addHeader}
                disabled={form.headers.length >= MAX_HEADERS}
                className="rounded-md bg-zinc-100 dark:bg-zinc-700 px-2 py-1 text-xs text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-600 disabled:opacity-50"
                data-testid="webhook-header-add"
              >
                {t('webhooks.form.headersAdd')}
              </button>
            </div>
            {form.headers.length === 0 ? (
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">
                {t('webhooks.form.headersEmpty')}
              </p>
            ) : (
              <div className="mt-2 space-y-2" data-testid="webhook-headers">
                {form.headers.map((row) => (
                  <div key={row.id} className="flex gap-2">
                    <input
                      type="text"
                      placeholder={t('webhooks.form.headerKey')}
                      value={row.key}
                      onChange={(e) => updateHeader(row.id, { key: e.target.value })}
                      data-testid="webhook-header-key"
                      className="flex-1 rounded-md border border-zinc-300 dark:border-zinc-600 px-2 py-1 text-sm dark:bg-zinc-900"
                    />
                    <input
                      type="text"
                      placeholder={t('webhooks.form.headerValue')}
                      value={row.value}
                      onChange={(e) => updateHeader(row.id, { value: e.target.value })}
                      data-testid="webhook-header-value"
                      className="flex-1 rounded-md border border-zinc-300 dark:border-zinc-600 px-2 py-1 text-sm dark:bg-zinc-900"
                    />
                    <button
                      type="button"
                      onClick={() => removeHeader(row.id)}
                      className="rounded bg-red-50 px-2 py-1 text-xs text-red-600 hover:bg-red-100"
                      data-testid="webhook-header-remove"
                      aria-label="remove-header"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            {errors.headers && (
              <p className="mt-1 text-xs text-red-600" data-testid="webhook-error-headers">
                {t(errors.headers)}
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="webhook-timeout"
                className="block text-sm font-medium text-zinc-700 dark:text-zinc-200"
              >
                {t('webhooks.form.timeoutSec')}
              </label>
              <input
                id="webhook-timeout"
                type="number"
                min={TIMEOUT_MIN}
                max={TIMEOUT_MAX}
                value={form.timeoutSec}
                onChange={(e) =>
                  update('timeoutSec', Number(e.target.value) || 0)
                }
                data-testid="webhook-field-timeout"
                className="mt-1 w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:bg-zinc-900"
              />
              {errors.timeoutSec && (
                <p className="mt-1 text-xs text-red-600" data-testid="webhook-error-timeout">
                  {t(errors.timeoutSec)}
                </p>
              )}
            </div>
            <div>
              <label
                htmlFor="webhook-retries"
                className="block text-sm font-medium text-zinc-700 dark:text-zinc-200"
              >
                {t('webhooks.form.maxRetries')}
              </label>
              <input
                id="webhook-retries"
                type="number"
                min={RETRY_MIN}
                max={RETRY_MAX}
                value={form.maxRetries}
                onChange={(e) =>
                  update('maxRetries', Number(e.target.value) || 0)
                }
                data-testid="webhook-field-retries"
                className="mt-1 w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:bg-zinc-900"
              />
              {errors.maxRetries && (
                <p className="mt-1 text-xs text-red-600" data-testid="webhook-error-retries">
                  {t(errors.maxRetries)}
                </p>
              )}
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-200">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => update('enabled', e.target.checked)}
              data-testid="webhook-field-enabled"
            />
            {t('webhooks.form.enabled')}
          </label>

          {!isEdit && (
            <p className="text-xs text-zinc-500 dark:text-zinc-500">
              {t('webhooks.form.secretHint')}
            </p>
          )}
        </form>

        <div className="flex justify-end gap-3 border-t border-zinc-100 dark:border-zinc-700 px-6 py-4">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md bg-zinc-100 dark:bg-zinc-700 px-4 py-2 text-sm font-medium text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-600"
            data-testid="webhook-form-cancel"
          >
            {t('webhooks.form.cancel')}
          </button>
          <button
            type="submit"
            onClick={handleSubmit}
            disabled={Boolean(saving)}
            className="rounded-md bg-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600 disabled:bg-zinc-300"
            data-testid="webhook-form-submit"
          >
            {saving ? t('webhooks.form.saving') : t('webhooks.form.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

// Exported so tests can exercise validation without rendering the
// dialog body. The dialog re-uses validate() to gate submit.
export const __test__ = {
  validate,
  isValidWebhookUrl,
  formFromWebhook,
  emptyForm,
  filtersToString,
  headersToString,
  PRIORITIES,
  TIMEOUT_MIN,
  TIMEOUT_MAX,
  TIMEOUT_DEFAULT,
  RETRY_MIN,
  RETRY_MAX,
  RETRY_DEFAULT,
  NAME_MIN,
  NAME_MAX,
  MAX_HEADERS,
};