import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        'webhooks.deliveries.title': 'Delivery log',
        'webhooks.deliveries.loading': 'Loading…',
        'webhooks.deliveries.empty': 'No deliveries yet.',
        'webhooks.deliveries.refresh': 'Refresh',
        'webhooks.deliveries.eventType': 'Event',
        'webhooks.deliveries.status': 'Status',
        'webhooks.deliveries.attempt': 'Attempt',
        'webhooks.deliveries.responseCode': 'Response',
        'webhooks.deliveries.startedAt': 'Started',
        'webhooks.deliveries.error': 'Error',
        'webhooks.deliveries.statusSuccess': 'success',
        'webhooks.deliveries.statusFailed': 'failed',
        'webhooks.deliveries.statusPending': 'pending',
        'webhooks.deliveries.statusRetrying': 'retrying',
        'webhooks.deliveries.statusExhausted': 'exhausted',
        'webhooks.deliveries.justNow': 'just now',
        'webhooks.deliveries.minutesAgo': '{{count}} min ago',
        'webhooks.deliveries.hoursAgo': '{{count}} hr ago',
        'webhooks.deliveries.daysAgo': '{{count}} d ago',
        'webhooks.deliveries.prev': 'Previous',
        'webhooks.deliveries.next': 'Next',
        'webhooks.deliveries.pageLabel': 'Page {{page}}',
        'webhooks.deliveries.overflowRecovered': 'Recovered',
        'webhooks.deliveries.detailTitle': 'Delivery detail',
        'webhooks.form.close': 'Close'
      };
      let value = map[key] || key;
      if (params && typeof value === 'string' && value.includes('{{')) {
        Object.entries(params).forEach(([k, v]) => {
          value = value.replace(`{{${k}}}`, String(v));
        });
      }
      return value;
    },
    i18n: { language: 'en' }
  })
}));

import { WebhookDeliveries, statusBadge } from './WebhookDeliveries';
import type { WebhookDelivery } from '@/types/kanban';

const tFn = (k: string) => k;

const successRow: WebhookDelivery = {
  id: 'd1',
  webhookId: 'wh-1',
  eventId: 'env-1',
  eventType: 'task.created',
  status: 'SUCCESS',
  attempt: 1,
  responseCode: 200,
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString()
};
const failedRow: WebhookDelivery = {
  id: 'd2',
  webhookId: 'wh-1',
  eventId: 'env-2',
  eventType: 'task.moved',
  status: 'FAILED',
  attempt: 5,
  responseCode: 502,
  error: 'Bad Gateway',
  startedAt: new Date().toISOString()
};

describe('WebhookDeliveries status badge mapping', () => {
  it('maps SUCCESS to a green badge', () => {
    const badge = statusBadge('SUCCESS', tFn);
    expect(badge.label).toBe('webhooks.deliveries.statusSuccess');
    expect(badge.classes).toMatch(/emerald/);
  });

  it('maps FAILED to a red badge', () => {
    const badge = statusBadge('FAILED', tFn);
    expect(badge.label).toBe('webhooks.deliveries.statusFailed');
    expect(badge.classes).toMatch(/red/);
  });

  it('maps PENDING / RETRYING / EXHAUSTED to their own colors', () => {
    expect(statusBadge('PENDING', tFn).classes).toMatch(/amber/);
    expect(statusBadge('RETRYING', tFn).classes).toMatch(/orange/);
    expect(statusBadge('EXHAUSTED', tFn).classes).toMatch(/zinc/);
  });

  it('falls back to a neutral grey badge for unknown statuses', () => {
    const badge = statusBadge('WAT', tFn);
    expect(badge.label).toBe('WAT');
    expect(badge.classes).toMatch(/zinc/);
  });

  it('is case-insensitive (matches the lowercase the legacy dispatcher may emit)', () => {
    expect(statusBadge('success', tFn).label).toBe('webhooks.deliveries.statusSuccess');
  });
});

describe('WebhookDeliveries pagination', () => {
  it('renders an empty state when the API returns no rows', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      deliveries: [],
      count: 0,
      nextCursor: '',
      hasMore: false
    });
    render(<WebhookDeliveries webhookId="wh-1" fetcher={fetcher} />);
    await waitFor(() => {
      expect(screen.getByTestId('webhook-deliveries-empty')).toBeInTheDocument();
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('renders one row per delivery and a status badge', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      deliveries: [successRow, failedRow],
      count: 2,
      nextCursor: '',
      hasMore: false
    });
    render(<WebhookDeliveries webhookId="wh-1" fetcher={fetcher} />);
    await waitFor(() => {
      expect(screen.getAllByTestId('webhook-delivery-row')).toHaveLength(2);
    });
    const badges = screen.getAllByTestId('webhook-delivery-status');
    // The t() mock translates the status badge keys via the
    // map table — so SUCCESS shows as "success" and FAILED as
    // "failed" rather than the raw i18n keys.
    expect(badges[0]).toHaveTextContent('success');
    expect(badges[1]).toHaveTextContent('failed');
  });

  it('disables Next when hasMore=false and forwards the cursor when Next is clicked', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({
        deliveries: [successRow],
        count: 1,
        nextCursor: 'cur-1',
        hasMore: true
      })
      .mockResolvedValueOnce({
        deliveries: [failedRow],
        count: 1,
        nextCursor: '',
        hasMore: false
      });
    render(<WebhookDeliveries webhookId="wh-1" fetcher={fetcher} />);
    await waitFor(() => {
      expect(screen.getAllByTestId('webhook-delivery-row')).toHaveLength(1);
    });
    const nextBtn = screen.getByTestId('webhook-deliveries-next') as HTMLButtonElement;
    expect(nextBtn).not.toBeDisabled();
    fireEvent.click(nextBtn);
    await waitFor(() => {
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
    expect(fetcher.mock.calls[1][1]).toEqual({ limit: 20, cursor: 'cur-1' });
    await waitFor(() => {
      expect(screen.getAllByTestId('webhook-delivery-row')).toHaveLength(1);
    });
    expect(screen.getByTestId('webhook-deliveries-next')).toBeDisabled();
  });

  it('falls back to page 1 with the overflow banner when the cursor 400s', async () => {
    const fetcher = vi
      .fn()
      // initial load succeeds
      .mockResolvedValueOnce({
        deliveries: [successRow],
        count: 1,
        nextCursor: 'stale-cursor',
        hasMore: true
      })
      // Next page request: simulate backend 400 on the stale cursor
      .mockRejectedValueOnce(new Error('cursor is malformed'))
      // Fallback refresh succeeds
      .mockResolvedValueOnce({
        deliveries: [successRow, failedRow],
        count: 2,
        nextCursor: '',
        hasMore: false
      });
    render(<WebhookDeliveries webhookId="wh-1" fetcher={fetcher} />);
    await waitFor(() => {
      expect(screen.getAllByTestId('webhook-delivery-row')).toHaveLength(1);
    });
    fireEvent.click(screen.getByTestId('webhook-deliveries-next'));
    await waitFor(() => {
      expect(fetcher).toHaveBeenCalledTimes(3);
    });
    // Banner surfaces; rows jumped back to the fresh first page.
    await waitFor(() => {
      expect(screen.getByTestId('webhook-deliveries-overflow')).toBeInTheDocument();
    });
    expect(screen.getAllByTestId('webhook-delivery-row')).toHaveLength(2);
    expect(screen.getByTestId('webhook-deliveries-page')).toHaveTextContent('Page 1');
  });

  it('surfaces a fatal error when both the paged and fallback fetches fail', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({
        deliveries: [successRow],
        count: 1,
        nextCursor: 'cur-x',
        hasMore: true
      })
      .mockRejectedValueOnce(new Error('boom-1'))
      .mockRejectedValueOnce(new Error('boom-2'));
    render(<WebhookDeliveries webhookId="wh-1" fetcher={fetcher} />);
    await waitFor(() => {
      expect(screen.getAllByTestId('webhook-delivery-row')).toHaveLength(1);
    });
    fireEvent.click(screen.getByTestId('webhook-deliveries-next'));
    await waitFor(() => {
      expect(screen.getByTestId('webhook-deliveries-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('webhook-deliveries-error')).toHaveTextContent('boom-1');
  });

  it('opens the raw-body modal when a row is clicked', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      deliveries: [successRow],
      count: 1,
      nextCursor: '',
      hasMore: false
    });
    render(<WebhookDeliveries webhookId="wh-1" fetcher={fetcher} />);
    await waitFor(() => {
      expect(screen.getByTestId('webhook-delivery-row')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('webhook-delivery-row'));
    expect(screen.getByTestId('webhook-delivery-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('webhook-delivery-raw').textContent).toContain('SUCCESS');
    fireEvent.click(screen.getByTestId('webhook-delivery-dialog-close'));
    expect(screen.queryByTestId('webhook-delivery-dialog')).not.toBeInTheDocument();
  });
});