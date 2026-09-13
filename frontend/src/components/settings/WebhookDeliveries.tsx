import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WebhookDelivery } from '@/types/kanban';

const PAGE_LIMIT_DEFAULT = 20;

export interface WebhookDeliveriesProps {
  webhookId: string;
  fetcher: (
    id: string,
    params?: { limit?: number; cursor?: string }
  ) => Promise<{
    deliveries: WebhookDelivery[];
    count: number;
    nextCursor: string;
    hasMore: boolean;
  }>;
}

// Centralised status→badge class + display label mapping. The
// backend writes the status literal from webhook_deliveries.status
// (SUCCESS / FAILED / PENDING / EXHAUSTED / RETRYING …) so the
// mapping only needs to handle the closed set the dispatcher
// emits; unknown statuses fall through to a neutral grey badge.
export interface StatusBadgeStyle {
  label: string;
  classes: string;
}

type TranslateFn = (key: string, params?: Record<string, unknown>) => string;

export function statusBadge(status: string, t: TranslateFn): StatusBadgeStyle {
  switch (status.toUpperCase()) {
    case 'SUCCESS':
      return {
        label: t('webhooks.deliveries.statusSuccess'),
        classes: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
      };
    case 'FAILED':
      return {
        label: t('webhooks.deliveries.statusFailed'),
        classes: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
      };
    case 'PENDING':
      return {
        label: t('webhooks.deliveries.statusPending'),
        classes: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
      };
    case 'RETRYING':
      return {
        label: t('webhooks.deliveries.statusRetrying'),
        classes: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300',
      };
    case 'EXHAUSTED':
      return {
        label: t('webhooks.deliveries.statusExhausted'),
        classes: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200',
      };
    default:
      return {
        label: status,
        classes: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300',
      };
  }
}

function formatRelativeTime(iso: string | null | undefined, t: TranslateFn): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return iso;
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return t('webhooks.deliveries.justNow');
  if (minutes < 60) return t('webhooks.deliveries.minutesAgo', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('webhooks.deliveries.hoursAgo', { count: hours });
  const days = Math.floor(hours / 24);
  return t('webhooks.deliveries.daysAgo', { count: days });
}

export function WebhookDeliveries({ webhookId, fetcher }: WebhookDeliveriesProps) {
  const { t } = useTranslation();
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [nextCursor, setNextCursor] = useState<string>('');
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>('');
  const [selected, setSelected] = useState<WebhookDelivery | null>(null);
  const [overflowRecovered, setOverflowRecovered] = useState(false);

  const load = useCallback(
    async (cursor?: string, requestedPage = 1) => {
      setLoading(true);
      setError('');
      setOverflowRecovered(false);
      try {
        const res = await fetcher(webhookId, { limit: PAGE_LIMIT_DEFAULT, cursor });
        setDeliveries(res.deliveries || []);
        setNextCursor(res.nextCursor || '');
        setHasMore(Boolean(res.hasMore));
        setPage(requestedPage);
      } catch (e) {
        // The backend caps limit at 100 and 400s out-of-range
        // cursors; if the caller hands us a stale cursor from a
        // prior load (e.g. after the deliveries table grew /
        // shrank between page renders) the API can reject us.
        // Fall back to the first page and surface a transient
        // banner so the operator knows the requested page was
        // skipped. See §7.3 "paginated table".
        if (cursor) {
          try {
            const fallback = await fetcher(webhookId, { limit: PAGE_LIMIT_DEFAULT });
            setDeliveries(fallback.deliveries || []);
            setNextCursor(fallback.nextCursor || '');
            setHasMore(Boolean(fallback.hasMore));
            setPage(1);
            setOverflowRecovered(true);
            return;
          } catch {
            /* surface the original error below */
          }
        }
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [fetcher, webhookId]
  );

  useEffect(() => {
    load();
  }, [load]);

  const goNext = () => {
    if (!hasMore || !nextCursor) return;
    load(nextCursor, page + 1);
  };
  const goPrev = () => {
    if (page <= 1) return;
    load(undefined, 1);
  };

  const rows = useMemo(() => deliveries, [deliveries]);

  return (
    <div className="space-y-4" data-testid="webhook-deliveries">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
          {t('webhooks.deliveries.title')}
        </h3>
        <button
          type="button"
          onClick={() => load(undefined, 1)}
          disabled={loading}
          className="rounded-md bg-zinc-100 dark:bg-zinc-700 px-3 py-1 text-xs text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-600 disabled:opacity-50"
          data-testid="webhook-deliveries-refresh"
        >
          {t('webhooks.deliveries.refresh')}
        </button>
      </div>

      {error && (
        <div
          className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700"
          role="alert"
          data-testid="webhook-deliveries-error"
        >
          {error}
        </div>
      )}

      {overflowRecovered && (
        <div
          className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700"
          data-testid="webhook-deliveries-overflow"
        >
          {t('webhooks.deliveries.overflowRecovered')}
        </div>
      )}

      {loading && rows.length === 0 ? (
        <div className="py-8 text-center text-sm text-zinc-500 dark:text-zinc-500">
          {t('webhooks.deliveries.loading')}
        </div>
      ) : rows.length === 0 ? (
        <div
          className="py-8 text-center text-sm text-zinc-500 dark:text-zinc-500"
          data-testid="webhook-deliveries-empty"
        >
          {t('webhooks.deliveries.empty')}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-700">
          <table className="min-w-full divide-y divide-zinc-200 dark:divide-zinc-700 text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-900/40">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-zinc-500 dark:text-zinc-400">
                  {t('webhooks.deliveries.eventType')}
                </th>
                <th className="px-3 py-2 text-left font-medium text-zinc-500 dark:text-zinc-400">
                  {t('webhooks.deliveries.status')}
                </th>
                <th className="px-3 py-2 text-left font-medium text-zinc-500 dark:text-zinc-400">
                  {t('webhooks.deliveries.attempt')}
                </th>
                <th className="px-3 py-2 text-left font-medium text-zinc-500 dark:text-zinc-400">
                  {t('webhooks.deliveries.responseCode')}
                </th>
                <th className="px-3 py-2 text-left font-medium text-zinc-500 dark:text-zinc-400">
                  {t('webhooks.deliveries.startedAt')}
                </th>
                <th className="px-3 py-2 text-left font-medium text-zinc-500 dark:text-zinc-400">
                  {t('webhooks.deliveries.error')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-700">
              {rows.map((row) => {
                const badge = statusBadge(row.status, t);
                return (
                  <tr
                    key={row.id}
                    onClick={() => setSelected(row)}
                    className="cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-700/40"
                    data-testid="webhook-delivery-row"
                  >
                    <td className="px-3 py-2 font-mono text-xs text-zinc-700 dark:text-zinc-200">
                      {row.eventType}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${badge.classes}`}
                        data-testid="webhook-delivery-status"
                      >
                        {badge.label}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-zinc-700 dark:text-zinc-200">{row.attempt}</td>
                    <td className="px-3 py-2 text-zinc-700 dark:text-zinc-200">
                      {row.responseCode || '—'}
                    </td>
                    <td className="px-3 py-2 text-xs text-zinc-500 dark:text-zinc-400">
                      {formatRelativeTime(row.startedAt, t)}
                    </td>
                    <td className="max-w-xs truncate px-3 py-2 text-xs text-red-600">
                      {row.error || ''}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
        <span data-testid="webhook-deliveries-page">
          {t('webhooks.deliveries.pageLabel', { page })}
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={goPrev}
            disabled={page <= 1 || loading}
            className="rounded-md bg-zinc-100 dark:bg-zinc-700 px-3 py-1 hover:bg-zinc-200 dark:hover:bg-zinc-600 disabled:opacity-50"
            data-testid="webhook-deliveries-prev"
          >
            {t('webhooks.deliveries.prev')}
          </button>
          <button
            type="button"
            onClick={goNext}
            disabled={!hasMore || loading}
            className="rounded-md bg-zinc-100 dark:bg-zinc-700 px-3 py-1 hover:bg-zinc-200 dark:hover:bg-zinc-600 disabled:opacity-50"
            data-testid="webhook-deliveries-next"
          >
            {t('webhooks.deliveries.next')}
          </button>
        </div>
      </div>

      {selected && (
        <DeliveryDetailDialog delivery={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

interface DeliveryDetailDialogProps {
  delivery: WebhookDelivery;
  onClose: () => void;
}

function DeliveryDetailDialog({ delivery, onClose }: DeliveryDetailDialogProps) {
  const { t } = useTranslation();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const badge = statusBadge(delivery.status, t);

  // The backend exposes the delivery view (id, status, attempt,
  // response code, error, timestamps). Future API revisions may
  // add requestBody / responseBody — we render whatever shape
  // arrives so the modal stays useful when raw bodies land.
  const rawPayload = useMemo(() => {
    const obj: Record<string, unknown> = {
      id: delivery.id,
      webhookId: delivery.webhookId,
      eventId: delivery.eventId,
      eventType: delivery.eventType,
      status: delivery.status,
      attempt: delivery.attempt,
      responseCode: delivery.responseCode,
      startedAt: delivery.startedAt,
    };
    if (delivery.error) obj.error = delivery.error;
    if (delivery.finishedAt) obj.finishedAt = delivery.finishedAt;
    if (delivery.nextRetryAt) obj.nextRetryAt = delivery.nextRetryAt;
    // Pass through any unknown rawBody / responseBody fields the
    // backend might surface in a future revision.
    const candidate = delivery as unknown as Record<string, unknown>;
    if (typeof candidate.requestBody === 'string') obj.requestBody = candidate.requestBody;
    if (typeof candidate.responseBody === 'string') obj.responseBody = candidate.responseBody;
    return JSON.stringify(obj, null, 2);
  }, [delivery]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={onClose}
      data-testid="webhook-delivery-dialog"
    >
      <div
        className="relative z-10 w-full max-w-2xl rounded-2xl bg-white dark:bg-zinc-800 border border-zinc-100 dark:border-zinc-700 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-100 dark:border-zinc-700 px-6 py-4">
          <div className="flex items-center gap-3">
            <h3 className="text-lg font-bold text-zinc-800 dark:text-zinc-100">
              {t('webhooks.deliveries.detailTitle')}
            </h3>
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${badge.classes}`}
            >
              {badge.label}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-zinc-100 dark:bg-zinc-700 px-2 py-1 text-xs text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-600"
            data-testid="webhook-delivery-dialog-close"
          >
            {t('webhooks.form.close')}
          </button>
        </div>
        <div className="px-6 py-4">
          <pre
            className="max-h-96 overflow-auto rounded-md bg-zinc-100 dark:bg-zinc-900 p-3 text-xs text-zinc-800 dark:text-zinc-200"
            data-testid="webhook-delivery-raw"
          >
            {rawPayload}
          </pre>
        </div>
      </div>
    </div>
  );
}