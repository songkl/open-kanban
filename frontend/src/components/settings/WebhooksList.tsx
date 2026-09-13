import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  Webhook,
  WebhookCreate,
  WebhookEventCatalogueEntry,
} from '@/types/kanban';
import { ConfirmDialog } from '../ConfirmDialog';
import { showErrorToast } from '../ErrorToast';
import { WebhookDeliveries } from './WebhookDeliveries';
import { WebhookFormDialog } from './WebhookFormDialog';

const SECRET_PLACEHOLDER = '********';

interface SecretReveal {
  webhookName: string;
  plaintextSecret: string;
}

export interface WebhooksListProps {
  webhooksApi: {
    list: () => Promise<Webhook[]>;
    get: (id: string) => Promise<Webhook>;
    create: (data: WebhookCreate) => Promise<{ webhook: Webhook; plaintextSecret: string }>;
    update: (id: string, data: Partial<WebhookCreate>) => Promise<{ webhook: Webhook }>;
    delete: (id: string) => Promise<{ success: boolean }>;
    rotateSecret: (id: string) => Promise<{ webhook: Webhook; plaintextSecret: string }>;
    test: (id: string, data: { event: string; data?: unknown }) => Promise<unknown>;
    listEvents: () => Promise<WebhookEventCatalogueEntry[]>;
    listDeliveries: (
      id: string,
      params?: { limit?: number; cursor?: string }
    ) => Promise<{
      deliveries: import('@/types/kanban').WebhookDelivery[];
      count: number;
      nextCursor: string;
      hasMore: boolean;
    }>;
  };
  isAdmin: boolean;
}

function parseEventTypes(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw || '[]');
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === 'string');
    }
  } catch {
    /* ignore */
  }
  return [];
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

type TranslateFn = (key: string, params?: Record<string, unknown>) => string;

function formatRelative(iso: string | null | undefined, t: TranslateFn): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return '—';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return t('webhooks.list.justNow');
  if (minutes < 60) return t('webhooks.list.minutesAgo', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('webhooks.list.hoursAgo', { count: hours });
  const days = Math.floor(hours / 24);
  return t('webhooks.list.daysAgo', { count: days });
}

export function WebhooksList({ webhooksApi, isAdmin }: WebhooksListProps) {
  const { t } = useTranslation();
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [events, setEvents] = useState<WebhookEventCatalogueEntry[]>([]);
  const [eventsLoadFailed, setEventsLoadFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>('');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Webhook | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [secretReveal, setSecretReveal] = useState<SecretReveal | null>(null);
  const [testEventById, setTestEventById] = useState<Record<string, string>>({});
  const [testSendingId, setTestSendingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const rows = await webhooksApi.list();
      setWebhooks(rows || []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [webhooksApi]);

  // Event catalogue is loaded separately so a 4xx/5xx there
  // doesn't take down the list (§7.2 "event picker source").
  const refreshEvents = useCallback(async () => {
    setEventsLoadFailed(false);
    try {
      const rows = await webhooksApi.listEvents();
      setEvents(rows || []);
    } catch {
      // Empty array + the eventsLoadFailed flag drives the empty
      // state inside the form dialog. We deliberately swallow
      // the error here so the list still renders.
      setEvents([]);
      setEventsLoadFailed(true);
    }
  }, [webhooksApi]);

  useEffect(() => {
    refresh();
    refreshEvents();
  }, [refresh, refreshEvents]);

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (webhook: Webhook) => {
    setEditing(webhook);
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setEditing(null);
  };

  const handleSubmit = async (data: WebhookCreate) => {
    setSaving(true);
    try {
      if (editing) {
        await webhooksApi.update(editing.id, data);
        showErrorToast(t('webhooks.list.updated'), 'info');
      } else {
        const res = await webhooksApi.create(data);
        setSecretReveal({
          webhookName: res.webhook.name,
          plaintextSecret: res.plaintextSecret,
        });
        showErrorToast(t('webhooks.list.created'), 'info');
      }
      closeForm();
      await refresh();
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await webhooksApi.delete(id);
      setWebhooks((prev) => prev.filter((w) => w.id !== id));
      if (expandedId === id) setExpandedId(null);
      showErrorToast(t('webhooks.list.deleted'), 'info');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleToggle = async (webhook: Webhook) => {
    try {
      const res = await webhooksApi.update(webhook.id, { enabled: !webhook.enabled });
      setWebhooks((prev) => prev.map((w) => (w.id === res.webhook.id ? res.webhook : w)));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleRotate = async (id: string) => {
    try {
      const res = await webhooksApi.rotateSecret(id);
      setWebhooks((prev) => prev.map((w) => (w.id === res.webhook.id ? res.webhook : w)));
      setSecretReveal({
        webhookName: res.webhook.name,
        plaintextSecret: res.plaintextSecret,
      });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleTest = async (webhook: Webhook) => {
    const event = testEventById[webhook.id] || parseEventTypes(webhook.eventTypes)[0];
    if (!event) {
      setError(t('webhooks.list.testEventRequired'));
      return;
    }
    setTestSendingId(webhook.id);
    try {
      await webhooksApi.test(webhook.id, { event });
      showErrorToast(t('webhooks.list.testQueued'), 'info');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setTestSendingId(null);
    }
  };

  const sorted = useMemo(
    () =>
      [...webhooks].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      ),
    [webhooks]
  );

  return (
    <div className="space-y-6" data-testid="webhooks-list">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-zinc-800 dark:text-zinc-100">
            {t('webhooks.list.title')}
          </h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-500">
            {t('webhooks.list.subtitle')}
          </p>
        </div>
        {isAdmin && (
          <button
            type="button"
            onClick={openCreate}
            className="rounded-md bg-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600"
            data-testid="webhook-add"
          >
            {t('webhooks.list.newWebhook')}
          </button>
        )}
      </div>

      {error && (
        <div
          className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700"
          role="alert"
          data-testid="webhooks-error"
        >
          {error}
        </div>
      )}

      {loading ? (
        <div className="py-8 text-center text-sm text-zinc-500 dark:text-zinc-500">
          {t('webhooks.list.loading')}
        </div>
      ) : sorted.length === 0 ? (
        <div
          className="rounded-md border border-dashed border-zinc-300 dark:border-zinc-700 py-10 text-center text-sm text-zinc-500 dark:text-zinc-500"
          data-testid="webhooks-empty"
        >
          {t('webhooks.list.empty')}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-700">
          <table className="min-w-full divide-y divide-zinc-200 dark:divide-zinc-700 text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-900/40">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-zinc-500 dark:text-zinc-400">
                  {t('webhooks.list.name')}
                </th>
                <th className="px-3 py-2 text-left font-medium text-zinc-500 dark:text-zinc-400">
                  {t('webhooks.list.url')}
                </th>
                <th className="px-3 py-2 text-left font-medium text-zinc-500 dark:text-zinc-400">
                  {t('webhooks.list.events')}
                </th>
                <th className="px-3 py-2 text-left font-medium text-zinc-500 dark:text-zinc-400">
                  {t('webhooks.list.enabled')}
                </th>
                <th className="px-3 py-2 text-left font-medium text-zinc-500 dark:text-zinc-400">
                  {t('webhooks.list.lastSuccess')}
                </th>
                <th className="px-3 py-2 text-left font-medium text-zinc-500 dark:text-zinc-400">
                  {t('webhooks.list.lastFailure')}
                </th>
                <th className="px-3 py-2 text-right font-medium text-zinc-500 dark:text-zinc-400">
                  {t('webhooks.list.actions')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-700">
              {sorted.map((webhook) => {
                const evs = parseEventTypes(webhook.eventTypes);
                const isOpen = expandedId === webhook.id;
                return (
                  <Fragment key={webhook.id}>
                    <tr data-testid="webhook-row">
                      <td className="px-3 py-2 font-medium text-zinc-800 dark:text-zinc-100">
                        {webhook.name}
                      </td>
                      <td
                        className="max-w-xs truncate px-3 py-2 font-mono text-xs text-zinc-600 dark:text-zinc-300"
                        title={webhook.url}
                      >
                        {truncate(webhook.url, 60)}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {evs.slice(0, 4).map((ev) => (
                            <span
                              key={ev}
                              className="rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-700 dark:bg-blue-900/40 dark:text-blue-200"
                            >
                              {ev}
                            </span>
                          ))}
                          {evs.length > 4 && (
                            <span className="text-xs text-zinc-500 dark:text-zinc-400">
                              +{evs.length - 4}
                            </span>
                          )}
                          {evs.length === 0 && (
                            <span className="text-xs text-zinc-500 dark:text-zinc-500">
                              {t('webhooks.list.noEvents')}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          onClick={() => handleToggle(webhook)}
                          disabled={!isAdmin}
                          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                            webhook.enabled ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-600'
                          } ${!isAdmin ? 'opacity-50' : ''}`}
                          data-testid="webhook-toggle"
                          aria-checked={webhook.enabled}
                          role="switch"
                        >
                          <span
                            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                              webhook.enabled ? 'translate-x-4' : 'translate-x-0.5'
                            }`}
                          />
                        </button>
                      </td>
                      <td className="px-3 py-2 text-xs text-zinc-500 dark:text-zinc-400">
                        {formatRelative(webhook.lastSuccessAt, t)}
                      </td>
                      <td className="px-3 py-2 text-xs text-zinc-500 dark:text-zinc-400">
                        {formatRelative(webhook.lastFailureAt, t)}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap items-center justify-end gap-1">
                          {isAdmin && (
                            <>
                              <button
                                type="button"
                                onClick={() => openEdit(webhook)}
                                className="rounded bg-zinc-100 dark:bg-zinc-700 px-2 py-1 text-xs text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-600"
                                data-testid="webhook-edit"
                              >
                                {t('webhooks.list.edit')}
                              </button>
                              <button
                                type="button"
                                onClick={() => handleRotate(webhook.id)}
                                className="rounded bg-zinc-100 dark:bg-zinc-700 px-2 py-1 text-xs text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-600"
                                data-testid="webhook-rotate"
                              >
                                {t('webhooks.list.rotateSecret')}
                              </button>
                              <button
                                type="button"
                                onClick={() => handleTest(webhook)}
                                disabled={testSendingId === webhook.id}
                                className="rounded bg-zinc-100 dark:bg-zinc-700 px-2 py-1 text-xs text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-600 disabled:opacity-50"
                                data-testid="webhook-test"
                              >
                                {testSendingId === webhook.id
                                  ? t('webhooks.list.testing')
                                  : t('webhooks.list.test')}
                              </button>
                            </>
                          )}
                          <button
                            type="button"
                            onClick={() => setExpandedId(isOpen ? null : webhook.id)}
                            className="rounded bg-zinc-100 dark:bg-zinc-700 px-2 py-1 text-xs text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-600"
                            data-testid="webhook-view-deliveries"
                          >
                            {isOpen ? t('webhooks.list.hideDeliveries') : t('webhooks.list.viewDeliveries')}
                          </button>
                          {isAdmin && (
                            <button
                              type="button"
                              onClick={() => setDeletingId(webhook.id)}
                              className="rounded bg-red-50 px-2 py-1 text-xs text-red-600 hover:bg-red-100"
                              data-testid="webhook-delete"
                            >
                              {t('webhooks.list.delete')}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr data-testid="webhook-deliveries-row">
                        <td colSpan={7} className="bg-zinc-50 dark:bg-zinc-900/30 px-3 py-3">
                          {eventsLoadFailed && (
                            <p className="mb-2 text-xs text-amber-600" data-testid="webhook-events-warning">
                              {t('webhooks.list.eventCatalogueFailed')}
                            </p>
                          )}
                          {evs.length > 0 && (
                            <div className="mb-3 flex items-center gap-2">
                              <label
                                htmlFor={`webhook-test-event-${webhook.id}`}
                                className="text-xs text-zinc-500 dark:text-zinc-400"
                              >
                                {t('webhooks.list.testEventLabel')}
                              </label>
                              <select
                                id={`webhook-test-event-${webhook.id}`}
                                value={testEventById[webhook.id] || evs[0]}
                                onChange={(e) =>
                                  setTestEventById((prev) => ({
                                    ...prev,
                                    [webhook.id]: e.target.value,
                                  }))
                                }
                                data-testid="webhook-test-event"
                                className="rounded-md border border-zinc-300 dark:border-zinc-600 px-2 py-1 text-xs dark:bg-zinc-800"
                              >
                                {evs.map((ev) => (
                                  <option key={ev} value={ev}>
                                    {ev}
                                  </option>
                                ))}
                              </select>
                            </div>
                          )}
                          <WebhookDeliveries
                            webhookId={webhook.id}
                            fetcher={(id, params) => webhooksApi.listDeliveries(id, params)}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <WebhookFormDialog
        open={formOpen}
        initial={editing}
        events={events}
        saving={saving}
        onCancel={closeForm}
        onSubmit={handleSubmit}
      />

      <ConfirmDialog
        isOpen={Boolean(deletingId)}
        title={t('webhooks.list.confirmDeleteTitle')}
        message={t('webhooks.list.confirmDelete')}
        variant="danger"
        confirmText={t('webhooks.list.delete')}
        cancelText={t('webhooks.form.cancel')}
        onConfirm={async () => {
          const id = deletingId;
          setDeletingId(null);
          if (id) await handleDelete(id);
        }}
        onCancel={() => setDeletingId(null)}
      />

      {secretReveal && (
        <SecretRevealDialog
          reveal={secretReveal}
          onClose={() => setSecretReveal(null)}
        />
      )}
    </div>
  );
}

// Tiny inline wrapper removed — using React.Fragment directly so
// the open/closed state lives on the parent row.

interface SecretRevealDialogProps {
  reveal: SecretReveal;
  onClose: () => void;
}

function SecretRevealDialog({ reveal, onClose }: SecretRevealDialogProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Reveal-once: clicking the copy button or the dismiss button
  // closes the dialog. We never re-show this value; the next
  // call to /rotate or /create returns a fresh secret.
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(reveal.plaintextSecret);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={onClose}
      data-testid="webhook-secret-dialog"
    >
      <div
        className="relative z-10 w-full max-w-md rounded-2xl bg-white dark:bg-zinc-800 border border-zinc-100 dark:border-zinc-700 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-zinc-100 dark:border-zinc-700 px-6 py-4">
          <h3 className="text-lg font-bold text-zinc-800 dark:text-zinc-100">
            {t('webhooks.list.secretRevealTitle')}
          </h3>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">
            {t('webhooks.list.secretRevealBody', { name: reveal.webhookName })}
          </p>
        </div>
        <div className="space-y-3 px-6 py-4">
          <div className="flex items-center gap-2">
            <input
              type="text"
              readOnly
              value={reveal.plaintextSecret}
              data-testid="webhook-secret-input"
              className="flex-1 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 font-mono text-sm text-zinc-800 dark:bg-amber-900/30 dark:text-amber-200"
            />
            <button
              type="button"
              onClick={handleCopy}
              className="rounded-md bg-blue-500 px-3 py-2 text-xs font-medium text-white hover:bg-blue-600"
              data-testid="webhook-secret-copy"
            >
              {copied ? t('webhooks.list.copied') : t('webhooks.list.copy')}
            </button>
          </div>
          <p className="text-xs text-red-600" data-testid="webhook-secret-warning">
            {t('webhooks.list.secretRevealWarning')}
          </p>
        </div>
        <div className="flex justify-end border-t border-zinc-100 dark:border-zinc-700 px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-zinc-100 dark:bg-zinc-700 px-4 py-2 text-sm font-medium text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-600"
            data-testid="webhook-secret-dismiss"
          >
            {t('webhooks.list.secretDismiss')}
          </button>
        </div>
        {/* SECRET_PLACEHOLDER documents the redact-on-read contract
            the service layer promises ("********" on every read
            that isn't create / rotate). */}
        <span className="sr-only">{SECRET_PLACEHOLDER}</span>
      </div>
    </div>
  );
}