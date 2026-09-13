import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        'webhooks.form.createTitle': 'New webhook',
        'webhooks.form.editTitle': 'Edit webhook',
        'webhooks.form.close': 'Close',
        'webhooks.form.name': 'Name',
        'webhooks.form.url': 'URL',
        'webhooks.form.eventTypes': 'Event types',
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
        'webhooks.form.cancel': 'Cancel',
        'webhooks.form.save': 'Save',
        'webhooks.form.saving': 'Saving…',
        'webhooks.form.saveFailed': 'Save failed',
        'webhooks.form.errors.nameLength': 'Name length 1-64',
        'webhooks.form.errors.urlInvalid': 'Invalid URL',
        'webhooks.form.errors.eventRequired': 'Pick an event',
        'webhooks.form.errors.timeoutRange': 'Timeout 5-60',
        'webhooks.form.errors.retriesRange': 'Retries 0-10',
        'webhooks.form.errors.headersTooMany': 'Max 10 headers',
        'webhooks.list.justNow': 'just now',
        'webhooks.list.minutesAgo': '{{count}} min ago',
        'webhooks.list.hoursAgo': '{{count}} hr ago',
        'webhooks.list.daysAgo': '{{count}} d ago'
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

import {
  WebhookFormDialog,
  isValidWebhookUrl,
  __test__
} from './WebhookFormDialog';
import type { WebhookEventCatalogueEntry, Webhook } from '@/types/kanban';

const catalogue: WebhookEventCatalogueEntry[] = [
  {
    event: 'task.created',
    displayName: 'Task created',
    description: 'A new task is created.',
    payloadSchema: { type: 'object' },
    filters: ['boardIds', 'priorities']
  },
  {
    event: 'task.moved',
    displayName: 'Task moved',
    description: 'A task crosses a column boundary.',
    payloadSchema: { type: 'object' },
    filters: ['columnIds']
  }
];

const baseInitial: Webhook = {
  id: 'wh-1',
  name: 'Staging',
  url: 'https://hooks.example.com/in',
  secret: '********',
  enabled: true,
  eventTypes: JSON.stringify(['task.created']),
  filters: JSON.stringify({ priorities: ['high'] }),
  headers: JSON.stringify({ 'X-Token': 'abc' }),
  timeoutSec: 15,
  maxRetries: 3,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z'
};

describe('WebhookFormDialog validation', () => {
  it('accepts https URLs and rejects plain http + empty', () => {
    expect(isValidWebhookUrl('https://hooks.example.com/in')).toBe(true);
    expect(isValidWebhookUrl('http://localhost:8080/in')).toBe(true);
    expect(isValidWebhookUrl('http://example.com/in')).toBe(false);
    expect(isValidWebhookUrl('ftp://example.com/in')).toBe(false);
    expect(isValidWebhookUrl('')).toBe(false);
  });

  it('flags empty name, missing events, out-of-range timeout and retries', () => {
    const errors = __test__.validate({
      name: '',
      url: 'https://hooks.example.com/in',
      eventTypes: [],
      filters: { boardIds: [], columnIds: [], priorities: [], assigneeIds: [] },
      headers: [],
      enabled: true,
      timeoutSec: 999,
      maxRetries: -1
    });
    expect(errors.name).toBe('webhooks.form.errors.nameLength');
    expect(errors.eventTypes).toBe('webhooks.form.errors.eventRequired');
    expect(errors.timeoutSec).toBe('webhooks.form.errors.timeoutRange');
    expect(errors.maxRetries).toBe('webhooks.form.errors.retriesRange');
  });

  it('flags invalid URL and headers exceeding the 10-row cap', () => {
    const headers = Array.from({ length: 11 }, () => ({
      id: `h${Math.random()}`,
      key: 'X-K',
      value: 'v'
    }));
    const errors = __test__.validate({
      name: 'ok',
      url: 'not-a-url',
      eventTypes: ['task.created'],
      filters: { boardIds: [], columnIds: [], priorities: [], assigneeIds: [] },
      headers,
      enabled: true,
      timeoutSec: 10,
      maxRetries: 5
    });
    expect(errors.url).toBe('webhooks.form.errors.urlInvalid');
    expect(errors.headers).toBe('webhooks.form.errors.headersTooMany');
  });

  it('serialises filters and headers to compact JSON', () => {
    expect(
      __test__.filtersToString({
        boardIds: [],
        columnIds: [],
        priorities: ['high'],
        assigneeIds: []
      })
    ).toBe('{"priorities":["high"]}');
    expect(
      __test__.headersToString([
        { id: 'a', key: ' X-K ', value: ' v ' },
        { id: 'b', key: '', value: 'ignored' }
      ])
    ).toBe('{"X-K":" v "}');
  });

  it('rehydrates filters and headers from a stored Webhook', () => {
    const form = __test__.formFromWebhook(baseInitial);
    expect(form.name).toBe('Staging');
    expect(form.eventTypes).toEqual(['task.created']);
    expect(form.filters.priorities).toEqual(['high']);
    expect(form.headers).toHaveLength(1);
    expect(form.headers[0].key).toBe('X-Token');
  });
});

describe('WebhookFormDialog render', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('renders nothing when closed', () => {
    const { container } = render(
      <WebhookFormDialog
        open={false}
        events={catalogue}
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows validation errors and skips the submit call when fields are invalid', async () => {
    const onSubmit = vi.fn();
    render(
      <WebhookFormDialog
        open
        events={catalogue}
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />
    );
    fireEvent.click(screen.getByTestId('webhook-form-submit'));
    await waitFor(() => {
      expect(screen.getByTestId('webhook-error-name')).toHaveTextContent('Name length 1-64');
    });
    expect(screen.getByTestId('webhook-error-url')).toHaveTextContent('Invalid URL');
    expect(screen.getByTestId('webhook-error-events')).toHaveTextContent('Pick an event');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits a valid create payload with parsed eventTypes + headers', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <WebhookFormDialog
        open
        events={catalogue}
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />
    );
    fireEvent.change(screen.getByTestId('webhook-field-name'), {
      target: { value: 'Hook A' }
    });
    fireEvent.change(screen.getByTestId('webhook-field-url'), {
      target: { value: 'https://hooks.example.com/in' }
    });
    fireEvent.click(screen.getByTestId('webhook-event-task.created'));
    fireEvent.click(screen.getByTestId('webhook-header-add'));
    fireEvent.change(screen.getByTestId('webhook-header-key'), {
      target: { value: 'X-Token' }
    });
    fireEvent.change(screen.getByTestId('webhook-header-value'), {
      target: { value: 'abc' }
    });
    fireEvent.click(screen.getByTestId('webhook-form-submit'));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.name).toBe('Hook A');
    expect(payload.url).toBe('https://hooks.example.com/in');
    expect(JSON.parse(payload.eventTypes)).toEqual(['task.created']);
    expect(JSON.parse(payload.headers)).toEqual({ 'X-Token': 'abc' });
    expect(payload.timeoutSec).toBe(10);
    expect(payload.maxRetries).toBe(5);
    expect(payload.enabled).toBe(true);
  });

  it('prefills the form when editing and submits as update', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <WebhookFormDialog
        open
        initial={baseInitial}
        events={catalogue}
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />
    );
    expect((screen.getByTestId('webhook-field-name') as HTMLInputElement).value).toBe('Staging');
    expect((screen.getByTestId('webhook-field-url') as HTMLInputElement).value).toBe(
      'https://hooks.example.com/in'
    );
    expect((screen.getByTestId('webhook-field-timeout') as HTMLInputElement).value).toBe('15');
    expect(screen.getByTestId('webhook-event-task.created')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByTestId('webhook-form-submit'));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    expect(onSubmit.mock.calls[0][0].name).toBe('Staging');
  });

  it('falls back to the empty catalogue message when no events load', () => {
    render(
      <WebhookFormDialog
        open
        events={[]}
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
      />
    );
    expect(screen.getByTestId('webhook-event-empty')).toHaveTextContent('Catalogue empty');
  });

  it('invokes onCancel on Escape and backdrop click', () => {
    const onCancel = vi.fn();
    const { container } = render(
      <WebhookFormDialog
        open
        events={catalogue}
        onCancel={onCancel}
        onSubmit={vi.fn()}
      />
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.click(container.firstChild as HTMLElement);
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it('surfaces onSubmit rejection as an error toast and keeps the dialog open', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('boom'));
    render(
      <WebhookFormDialog
        open
        events={catalogue}
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />
    );
    fireEvent.change(screen.getByTestId('webhook-field-name'), {
      target: { value: 'Hook A' }
    });
    fireEvent.change(screen.getByTestId('webhook-field-url'), {
      target: { value: 'https://hooks.example.com/in' }
    });
    fireEvent.click(screen.getByTestId('webhook-event-task.created'));
    fireEvent.click(screen.getByTestId('webhook-form-submit'));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    // Dialog stays mounted so the operator can correct the
    // form rather than losing state on a transient backend 4xx.
    expect(screen.getByTestId('webhook-form-dialog')).toBeInTheDocument();
  });
});