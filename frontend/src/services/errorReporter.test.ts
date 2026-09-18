import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createErrorReporter,
  redactString,
  readPersistedEnabled,
  getDefaultConfig,
  type ReporterConfig,
  type ReportedEvent,
} from './errorReporter';

/**
 * Tests for the Sentry-compatible error sink client
 * (s-1210, PM_REVIEW_2026-09-17 §7). The redaction logic is
 * the safety-critical path: a failure here could leak a
 * credential into the captured payload. Each test below
 * pins a specific input shape and asserts the redacted
 * output so a future maintainer cannot accidentally widen
 * the redaction surface.
 */

describe('errorReporter.redactString (s-1210)', () => {
  it('redacts Bearer tokens in the Authorization header', () => {
    const redacted = redactString(
      'fetch failed: Authorization: Bearer abc.def.ghi'
    );
    expect(redacted).toBe('fetch failed: Authorization: Bearer [REDACTED]');
    expect(redacted).not.toContain('abc.def.ghi');
  });

  it('redacts Basic auth credentials', () => {
    const redacted = redactString('Authorization: Basic dXNlcjpwYXNz');
    expect(redacted).toBe('Authorization: Basic [REDACTED]');
    expect(redacted).not.toContain('dXNlcjpwYXNz');
  });

  it('is case-insensitive on the Authorization keyword', () => {
    const redacted = redactString('AUTHORIZATION: bearer abc');
    expect(redacted).toBe('AUTHORIZATION: bearer [REDACTED]');
  });

  it('redacts kanban-token cookie values', () => {
    const redacted = redactString('Cookie: kanban-token=secret-cookie-value');
    expect(redacted).toBe('Cookie: kanban-token=[REDACTED]');
    expect(redacted).not.toContain('secret-cookie-value');
  });

  it('redacts ?token= and ?api_key= query strings', () => {
    const redacted = redactString(
      'GET /api/v1/boards?token=alpha&api_key=beta failed'
    );
    expect(redacted).toContain('[REDACTED]');
    expect(redacted).not.toContain('alpha');
    expect(redacted).not.toContain('beta');
  });

  it('redacts JSON-shape secret values inside details', () => {
    const redacted = redactString(
      JSON.stringify({ password: 'hunter2', apiKey: 'ABC123', clientSecret: 'def456' })
    );
    expect(redacted).toContain('[REDACTED]');
    expect(redacted).not.toContain('hunter2');
    expect(redacted).not.toContain('ABC123');
    expect(redacted).not.toContain('def456');
  });

  it('leaves non-sensitive strings untouched', () => {
    const plain = 'TypeError: x is not a function\n    at BoardPage (board.js:42:13)';
    expect(redactString(plain)).toBe(plain);
  });

  it('handles an empty string without throwing', () => {
    expect(redactString('')).toBe('');
  });

  it('redacts tokens that appear multiple times', () => {
    const redacted = redactString(
      'first: Authorization: Bearer foo; second: Authorization: Bearer bar'
    );
    expect(redacted).not.toContain('foo');
    expect(redacted).not.toContain('bar');
    expect((redacted.match(/\[REDACTED\]/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  it('redacts ?access_token= and ?auth= variants', () => {
    const redacted = redactString(
      'failed /api/v1/x?access_token=t1&auth=t2'
    );
    expect(redacted).not.toContain('t1');
    expect(redacted).not.toContain('t2');
  });
});

describe('errorReporter.report', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalLocation: Location;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ status: 200, ok: true });
    originalLocation = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, href: 'http://localhost/board/gbk' },
    });
    localStorage.clear();
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
    vi.useRealTimers();
  });

  function makeReporter(overrides: Partial<ReporterConfig> = {}): ReturnType<typeof createErrorReporter> {
    return createErrorReporter({
      enabled: true,
      endpoint: '/api/v1/frontend-events',
      fetchImpl: fetchMock as unknown as typeof fetch,
      ...overrides,
    });
  }

  it('POSTs to the configured endpoint with redacted payload', async () => {
    const reporter = makeReporter();
    const event: ReportedEvent = {
      eventType: 'error',
      message: 'fetch failed with Authorization: Bearer abc.def.ghi',
      stack: 'at foo',
      url: 'http://localhost/board/gbk',
    };
    await reporter.report(event);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/v1/frontend-events');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    const body = JSON.parse(init.body);
    expect(body.eventType).toBe('error');
    expect(body.message).toBe('fetch failed with Authorization: Bearer [REDACTED]');
    expect(body.message).not.toContain('abc.def.ghi');
    expect(body.stack).toBe('at foo');
    expect(body.url).toBe('http://localhost/board/gbk');
  });

  it('is a no-op when enabled=false', async () => {
    const reporter = makeReporter({ enabled: false });
    await reporter.report({ eventType: 'error', message: 'boom' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('flips serverEnabled=false when the server returns 204', async () => {
    fetchMock.mockResolvedValue({ status: 204 });
    const reporter = makeReporter();
    await reporter.report({ eventType: 'error', message: 'boom' });
    expect(reporter.isEnabled()).toBe(false);
    // A second call must short-circuit because serverEnabled is
    // now false — proves the client caches the disable signal
    // without re-probing.
    await reporter.report({ eventType: 'error', message: 'boom2' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('coalesces identical messages within the same tick', async () => {
    vi.useFakeTimers();
    const reporter = makeReporter();
    await reporter.report({ eventType: 'error', message: 'boom' });
    await reporter.report({ eventType: 'error', message: 'boom' });
    await reporter.report({ eventType: 'error', message: 'boom' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('silently swallows network failures', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const reporter = makeReporter();
    // The promise from report() resolves cleanly so the
    // caller's catch chain is not poisoned.
    await expect(
      reporter.report({ eventType: 'error', message: 'boom' })
    ).resolves.toBeUndefined();
  });

  it('caps oversized message and stack fields', async () => {
    const reporter = makeReporter();
    await reporter.report({
      eventType: 'error',
      message: 'a'.repeat(20 * 1024),
      stack: 'b'.repeat(100 * 1024),
    });
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.message.length).toBeLessThanOrEqual(4 * 1024 + 32); // allow one surrogate walk
    expect(body.stack.length).toBeLessThanOrEqual(32 * 1024 + 32);
  });

  it('honors setEnabled at runtime and persists to localStorage', async () => {
    const reporter = makeReporter();
    reporter.setEnabled(false);
    expect(reporter.isEnabled()).toBe(false);
    expect(readPersistedEnabled()).toBe(false);
    await reporter.report({ eventType: 'error', message: 'boom' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('errorReporter.install', () => {
  it('wires window.onerror and unhandledrejection listeners', () => {
    const reporter = createErrorReporter({
      enabled: true,
      endpoint: '/api/v1/frontend-events',
      fetchImpl: vi.fn().mockResolvedValue({ status: 200 }),
    });
    const addSpy = vi.spyOn(window, 'addEventListener');
    reporter.install();
    const events = addSpy.mock.calls.map((c) => c[0]);
    expect(events).toContain('error');
    expect(events).toContain('unhandledrejection');
    addSpy.mockRestore();
    reporter.uninstall();
  });

  it('is idempotent — a second install() does not double-bind', () => {
    const reporter = createErrorReporter({
      enabled: true,
      endpoint: '/api/v1/frontend-events',
      fetchImpl: vi.fn(),
    });
    const addSpy = vi.spyOn(window, 'addEventListener');
    reporter.install();
    reporter.install();
    const errorCount = addSpy.mock.calls.filter((c) => c[0] === 'error').length;
    expect(errorCount).toBe(1);
    addSpy.mockRestore();
    reporter.uninstall();
  });
});

describe('errorReporter defaults', () => {
  it('getDefaultConfig returns the canonical endpoint', () => {
    expect(getDefaultConfig().endpoint).toBe('/api/v1/frontend-events');
  });

  it('getDefaultConfig defaults enabled to true when no persisted value', () => {
    localStorage.clear();
    expect(getDefaultConfig().enabled).toBe(true);
  });

  it('getDefaultConfig respects a persisted opt-out', () => {
    localStorage.setItem('kanban.frontendEventsEnabled', '0');
    expect(getDefaultConfig().enabled).toBe(false);
  });
});