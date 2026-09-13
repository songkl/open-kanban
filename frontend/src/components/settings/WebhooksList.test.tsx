import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        'webhooks.list.title': 'Webhooks',
        'webhooks.list.subtitle': 'Send events',
        'webhooks.list.loading': 'Loading…',
        'webhooks.list.empty': 'No webhooks yet.',
        'webhooks.list.newWebhook': 'New webhook',
        'webhooks.list.name': 'Name',
        'webhooks.list.url': 'URL',
        'webhooks.list.events': 'Events',
        'webhooks.list.enabled': 'Enabled',
        'webhooks.list.lastSuccess': 'Last success',
        'webhooks.list.lastFailure': 'Last failure',
        'webhooks.list.actions': 'Actions',
        'webhooks.list.noEvents': 'none',
        'webhooks.list.edit': 'Edit',
        'webhooks.list.delete': 'Delete',
        'webhooks.list.rotateSecret': 'Rotate secret',
        'webhooks.list.test': 'Send test',
        'webhooks.list.testing': 'Sending…',
        'webhooks.list.viewDeliveries': 'View deliveries',
        'webhooks.list.hideDeliveries': 'Hide deliveries',
        'webhooks.list.created': 'Webhook created.',
        'webhooks.list.updated': 'Webhook updated.',
        'webhooks.list.deleted': 'Webhook deleted.',
        'webhooks.list.testQueued': 'Test event queued',
        'webhooks.list.testEventRequired': 'Pick an event',
        'webhooks.list.testEventLabel': 'Test event',
        'webhooks.list.confirmDeleteTitle': 'Delete webhook',
        'webhooks.list.confirmDelete': 'Delete?',
        'webhooks.list.copy': 'Copy',
        'webhooks.list.copied': 'Copied',
        'webhooks.list.secretRevealTitle': 'Save secret',
        'webhooks.list.secretRevealBody': 'Secret for {{name}}',
        'webhooks.list.secretRevealWarning': 'Save it now',
        'webhooks.list.secretDismiss': 'I have saved it',
        'webhooks.list.justNow': 'just now',
        'webhooks.list.minutesAgo': '{{count}} min ago',
        'webhooks.list.hoursAgo': '{{count}} hr ago',
        'webhooks.list.daysAgo': '{{count}} d ago',
        'webhooks.list.eventCatalogueFailed': 'Event catalogue failed',
        'webhooks.form.createTitle': 'New webhook',
        'webhooks.form.editTitle': 'Edit webhook',
        'webhooks.form.close': 'Close',
        'webhooks.form.cancel': 'Cancel',
        'webhooks.form.save': 'Save',
        'webhooks.form.saving': 'Saving…',
        'webhooks.form.name': 'Name',
        'webhooks.form.url': 'URL',
        'webhooks.form.eventTypes': 'Events',
        'webhooks.form.eventCatalogueEmpty': 'Catalogue empty',
        'webhooks.form.filters': 'Filters',
        'webhooks.form.filtersHint': 'Filter hint',
        'webhooks.form.priorities': 'Priorities',
        'webhooks.form.headers': 'Headers',
        'webhooks.form.headersAdd': 'Add header',
        'webhooks.form.headersEmpty': 'No headers',
        'webhooks.form.headerKey': 'Key',
        'webhooks.form.headerValue': 'Value',
        'webhooks.form.timeoutSec': 'Timeout',
        'webhooks.form.maxRetries': 'Retries',
        'webhooks.form.enabled': 'Enabled',
        'webhooks.form.secretHint': 'Secret hint',
        'webhooks.form.saveFailed': 'Save failed',
        'webhooks.form.errors.nameLength': 'Name 1-64',
        'webhooks.form.errors.urlInvalid': 'Invalid URL',
        'webhooks.form.errors.eventRequired': 'Pick event',
        'webhooks.form.errors.timeoutRange': 'Timeout 5-60',
        'webhooks.form.errors.retriesRange': 'Retries 0-10',
        'webhooks.form.errors.headersTooMany': 'Max 10 headers',
        'webhooks.deliveries.title': 'Deliveries',
        'webhooks.deliveries.loading': 'Loading deliveries',
        'webhooks.deliveries.empty': 'No deliveries',
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
        'webhooks.deliveries.prev': 'Prev',
        'webhooks.deliveries.next': 'Next',
        'webhooks.deliveries.pageLabel': 'Page {{page}}',
        'webhooks.deliveries.overflowRecovered': 'Recovered',
        'webhooks.deliveries.detailTitle': 'Delivery detail'
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

import { WebhooksList } from './WebhooksList';
import type {
  Webhook,
  WebhookEventCatalogueEntry,
  WebhookDelivery
} from '@/types/kanban';

const catalogue: WebhookEventCatalogueEntry[] = [
  {
    event: 'task.created',
    displayName: 'Task created',
    description: 'A new task',
    payloadSchema: { type: 'object' },
    filters: ['boardIds']
  },
  {
    event: 'task.moved',
    displayName: 'Task moved',
    description: 'Crossed a column',
    payloadSchema: { type: 'object' },
    filters: ['columnIds']
  }
];

const baseWebhook: Webhook = {
  id: 'wh-1',
  name: 'Staging',
  url: 'https://hooks.example.com/in',
  secret: '********',
  enabled: true,
  eventTypes: JSON.stringify(['task.created']),
  filters: '{}',
  headers: '{}',
  timeoutSec: 10,
  maxRetries: 5,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  lastSuccessAt: '2026-01-02T00:00:00Z',
  lastFailureAt: null
};

interface MockWebhooksApi {
  list: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  rotateSecret: ReturnType<typeof vi.fn>;
  test: ReturnType<typeof vi.fn>;
  listEvents: ReturnType<typeof vi.fn>;
  listDeliveries: ReturnType<typeof vi.fn>;
}

function makeApi(overrides: Partial<MockWebhooksApi> = {}): MockWebhooksApi {
  return {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    rotateSecret: vi.fn(),
    test: vi.fn(),
    listEvents: vi.fn().mockResolvedValue(catalogue),
    listDeliveries: vi.fn().mockResolvedValue({
      deliveries: [],
      count: 0,
      nextCursor: '',
      hasMore: false
    }),
    ...overrides
  };
}

describe('WebhooksList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.confirm = vi.fn(() => true);
  });

  it('renders the list with name, url, event chips, and toggle state', async () => {
    const api = makeApi({ list: vi.fn().mockResolvedValue([baseWebhook]) });
    render(<WebhooksList webhooksApi={api as never} isAdmin />);
    await waitFor(() => {
      expect(screen.getAllByTestId('webhook-row')).toHaveLength(1);
    });
    expect(screen.getByText('Staging')).toBeInTheDocument();
    expect(screen.getByText('https://hooks.example.com/in')).toBeInTheDocument();
    expect(screen.getByTestId('webhook-toggle')).toHaveAttribute('aria-checked', 'true');
  });

  it('renders the empty state when no webhooks are configured', async () => {
    const api = makeApi({ list: vi.fn().mockResolvedValue([]) });
    render(<WebhooksList webhooksApi={api as never} isAdmin />);
    await waitFor(() => {
      expect(screen.getByTestId('webhooks-empty')).toBeInTheDocument();
    });
  });

  it('keeps admin-only actions hidden from non-admin viewers', async () => {
    const api = makeApi({ list: vi.fn().mockResolvedValue([baseWebhook]) });
    render(<WebhooksList webhooksApi={api as never} isAdmin={false} />);
    await waitFor(() => {
      expect(screen.getAllByTestId('webhook-row')).toHaveLength(1);
    });
    expect(screen.queryByTestId('webhook-add')).not.toBeInTheDocument();
    expect(screen.queryByTestId('webhook-edit')).not.toBeInTheDocument();
    expect(screen.queryByTestId('webhook-rotate')).not.toBeInTheDocument();
    expect(screen.queryByTestId('webhook-delete')).not.toBeInTheDocument();
    expect(screen.getByTestId('webhook-view-deliveries')).toBeInTheDocument();
  });

  it('surfaces the empty state when the event catalogue fails to load', async () => {
    const api = makeApi({
      list: vi.fn().mockResolvedValue([baseWebhook]),
      listEvents: vi.fn().mockRejectedValue(new Error('boom'))
    });
    render(<WebhooksList webhooksApi={api as never} isAdmin />);
    fireEvent.click(screen.getByTestId('webhook-add'));
    await waitFor(() => {
      expect(screen.getByTestId('webhook-event-empty')).toBeInTheDocument();
    });
    // The banner warning surfaces once deliveries are expanded.
    fireEvent.click(screen.getByTestId('webhook-view-deliveries'));
    await waitFor(() => {
      expect(screen.getByTestId('webhook-events-warning')).toBeInTheDocument();
    });
  });

  it('opens the create form, validates, and submits with serialised events', async () => {
    const api = makeApi({
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({
        webhook: { ...baseWebhook, id: 'wh-new' },
        plaintextSecret: 'fresh-secret-token'
      })
    });
    render(<WebhooksList webhooksApi={api as never} isAdmin />);
    fireEvent.click(await screen.findByTestId('webhook-add'));
    fireEvent.change(screen.getByTestId('webhook-field-name'), {
      target: { value: 'Hook' }
    });
    fireEvent.change(screen.getByTestId('webhook-field-url'), {
      target: { value: 'https://hooks.example.com/in' }
    });
    fireEvent.click(screen.getByTestId('webhook-event-task.created'));
    fireEvent.click(screen.getByTestId('webhook-form-submit'));
    await waitFor(() => {
      expect(api.create).toHaveBeenCalledTimes(1);
    });
    const payload = api.create.mock.calls[0][0];
    expect(payload.name).toBe('Hook');
    expect(payload.url).toBe('https://hooks.example.com/in');
    expect(JSON.parse(payload.eventTypes)).toEqual(['task.created']);
    // Reveal-once dialog must surface the plaintext secret so
    // the operator can copy it before closing.
    await waitFor(() => {
      expect(screen.getByTestId('webhook-secret-dialog')).toBeInTheDocument();
    });
    expect(screen.getByTestId('webhook-secret-input')).toHaveValue('fresh-secret-token');
    fireEvent.click(screen.getByTestId('webhook-secret-dismiss'));
    await waitFor(() => {
      expect(screen.queryByTestId('webhook-secret-dialog')).not.toBeInTheDocument();
    });
  });

  it('shows the secret reveal-once banner on rotate and never re-renders after dismiss', async () => {
    const api = makeApi({
      list: vi.fn().mockResolvedValue([baseWebhook]),
      rotateSecret: vi.fn().mockResolvedValue({
        webhook: baseWebhook,
        plaintextSecret: 'rotated-secret-token'
      })
    });
    render(<WebhooksList webhooksApi={api as never} isAdmin />);
    await waitFor(() => {
      expect(screen.getAllByTestId('webhook-row')).toHaveLength(1);
    });
    fireEvent.click(screen.getByTestId('webhook-rotate'));
    await waitFor(() => {
      expect(screen.getByTestId('webhook-secret-dialog')).toBeInTheDocument();
    });
    expect(screen.getByTestId('webhook-secret-input')).toHaveValue('rotated-secret-token');
    fireEvent.click(screen.getByTestId('webhook-secret-dismiss'));
    await waitFor(() => {
      expect(screen.queryByTestId('webhook-secret-dialog')).not.toBeInTheDocument();
    });
    // Triggering rotate again must hand us a fresh secret
    // because reveal-once is a server-side contract.
    api.rotateSecret.mockResolvedValueOnce({
      webhook: baseWebhook,
      plaintextSecret: 'second-secret'
    });
    fireEvent.click(screen.getByTestId('webhook-rotate'));
    await waitFor(() => {
      expect(screen.getByTestId('webhook-secret-input')).toHaveValue('second-secret');
    });
  });

  it('expands the deliveries row and shows a refreshable empty state', async () => {
    const api = makeApi({ list: vi.fn().mockResolvedValue([baseWebhook]) });
    render(<WebhooksList webhooksApi={api as never} isAdmin />);
    await waitFor(() => {
      expect(screen.getAllByTestId('webhook-row')).toHaveLength(1);
    });
    fireEvent.click(screen.getByTestId('webhook-view-deliveries'));
    await waitFor(() => {
      expect(screen.getByTestId('webhook-deliveries-empty')).toBeInTheDocument();
    });
    expect(api.listDeliveries).toHaveBeenCalledWith('wh-1', expect.any(Object));
  });

  it('confirms before deleting a webhook', async () => {
    const api = makeApi({
      list: vi.fn().mockResolvedValue([baseWebhook]),
      delete: vi.fn().mockResolvedValue({ success: true })
    });
    render(<WebhooksList webhooksApi={api as never} isAdmin />);
    await waitFor(() => {
      expect(screen.getAllByTestId('webhook-row')).toHaveLength(1);
    });
    // Opens the in-app ConfirmDialog (not window.confirm) — the
    // row action button is the trigger.
    fireEvent.click(screen.getByTestId('webhook-delete'));
    // The dialog renders the translated confirm button. Two
    // elements on the page say "Delete" (the row button and the
    // dialog confirm button); the last one in the document is
    // the dialog confirm.
    const buttons = screen.getAllByText('Delete');
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => {
      expect(api.delete).toHaveBeenCalledWith('wh-1');
    });
  });

  it('refuses to send a test when no event is selected and the webhook has none', async () => {
    const noEventsWebhook: Webhook = { ...baseWebhook, eventTypes: '[]' };
    const api = makeApi({ list: vi.fn().mockResolvedValue([noEventsWebhook]) });
    render(<WebhooksList webhooksApi={api as never} isAdmin />);
    await waitFor(() => {
      expect(screen.getAllByTestId('webhook-row')).toHaveLength(1);
    });
    fireEvent.click(screen.getByTestId('webhook-test'));
    expect(api.test).not.toHaveBeenCalled();
    expect(screen.getByTestId('webhooks-error')).toHaveTextContent('Pick an event');
  });

  it('sends a test using the operator-picked event type', async () => {
    const api = makeApi({
      list: vi.fn().mockResolvedValue([baseWebhook]),
      test: vi.fn().mockResolvedValue({ success: true })
    });
    render(<WebhooksList webhooksApi={api as never} isAdmin />);
    await waitFor(() => {
      expect(screen.getAllByTestId('webhook-row')).toHaveLength(1);
    });
    fireEvent.click(screen.getByTestId('webhook-test'));
    await waitFor(() => {
      expect(api.test).toHaveBeenCalledWith('wh-1', { event: 'task.created' });
    });
  });

  it('toggles enabled state via the row switch', async () => {
    const api = makeApi({
      list: vi.fn().mockResolvedValue([baseWebhook]),
      update: vi.fn().mockResolvedValue({
        webhook: { ...baseWebhook, enabled: false }
      })
    });
    render(<WebhooksList webhooksApi={api as never} isAdmin />);
    await waitFor(() => {
      expect(screen.getAllByTestId('webhook-row')).toHaveLength(1);
    });
    fireEvent.click(screen.getByTestId('webhook-toggle'));
    await waitFor(() => {
      expect(api.update).toHaveBeenCalledWith('wh-1', { enabled: false });
    });
  });

  it('renders deliveries rows when the API returns them', async () => {
    const row: WebhookDelivery = {
      id: 'd1',
      webhookId: 'wh-1',
      eventId: 'env-1',
      eventType: 'task.created',
      status: 'SUCCESS',
      attempt: 1,
      responseCode: 200,
      startedAt: new Date().toISOString()
    };
    const api = makeApi({
      list: vi.fn().mockResolvedValue([baseWebhook]),
      listDeliveries: vi.fn().mockResolvedValue({
        deliveries: [row],
        count: 1,
        nextCursor: '',
        hasMore: false
      })
    });
    render(<WebhooksList webhooksApi={api as never} isAdmin />);
    await waitFor(() => {
      expect(screen.getAllByTestId('webhook-row')).toHaveLength(1);
    });
    fireEvent.click(screen.getByTestId('webhook-view-deliveries'));
    await waitFor(() => {
      expect(screen.getByTestId('webhook-delivery-row')).toBeInTheDocument();
    });
    expect(screen.getByTestId('webhook-delivery-status')).toHaveTextContent('success');
  });

  it('renders nothing until the operator clicks the add button again after a successful create', async () => {
    const api = makeApi({
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({
        webhook: { ...baseWebhook, id: 'wh-new' },
        plaintextSecret: 'fresh-secret'
      })
    });
    render(<WebhooksList webhooksApi={api as never} isAdmin />);
    fireEvent.click(await screen.findByTestId('webhook-add'));
    fireEvent.change(screen.getByTestId('webhook-field-name'), {
      target: { value: 'Hook' }
    });
    fireEvent.change(screen.getByTestId('webhook-field-url'), {
      target: { value: 'https://hooks.example.com/in' }
    });
    fireEvent.click(screen.getByTestId('webhook-event-task.created'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('webhook-form-submit'));
    });
    await waitFor(() => {
      expect(api.create).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByTestId('webhook-secret-dialog')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('webhook-secret-dismiss'));
    // Form dialog should close on successful create.
    await waitFor(() => {
      expect(screen.queryByTestId('webhook-form-dialog')).not.toBeInTheDocument();
    });
  });
});