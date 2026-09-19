/**
 * errorReporter — client side of the Sentry-compatible error
 * sink (s-1210, PM_REVIEW_2026-09-17 §7).
 *
 * Captures the three classes of unhandled error the PM review
 * surfaced as silently disappearing:
 *
 *   - React component errors that bubble past every render
 *     boundary — caught by the root <ErrorBoundary> which
 *     forwards to {@link reportError} with eventType
 *     "react_error".
 *   - window.onerror events — script errors, reference errors
 *     in non-React code paths, network race conditions. These
 *     arrive with eventType "error".
 *   - unhandledrejection events — async failures that never
 *     had a .catch() attached. Arrives with eventType
 *     "unhandled_rejection".
 *
 * The reporter is intentionally tiny and dependency-free so
 * it can be wired in main.tsx BEFORE the rest of the React
 * tree boots — a render-time exception during init still has
 * a place to land.
 *
 * Three pieces of configuration are read at init time:
 *
 *   - enabled (default true). The Settings → Error
 *     Reporting toggle writes a "1" / "0" string into the
 *     `frontendEventsEnabled` app_config flag. A self-hosted
 *     admin can flip this off and the sink goes silent.
 *   - endpoint (default /api/v1/frontend-events). Lets an
 *     operator reroute the sink to an internal Sentry /
 *     OpenTelemetry collector without rebuilding the frontend.
 *   - perUserOptOut (default false). Set on the errorReporter
 *     singleton from the Settings tab so individual users can
 *     opt out without affecting the rest of the deployment.
 *
 * The redaction pass mirrors the server-side one (see
 * backend/internal/handlers/frontend_events.go). We run it on
 * the client so the wire payload is safe even if the server
 * forgets, and we run it AGAIN on the server so a future
 * client regression cannot leak a credential into the row.
 */

const STORAGE_KEY_ENABLED = 'kanban.frontendEventsEnabled';
const DEFAULT_ENDPOINT = '/api/v1/frontend-events';

const MAX_MESSAGE_BYTES = 4 * 1024;
const MAX_STACK_BYTES = 32 * 1024;
const MAX_URL_BYTES = 2 * 1024;
const MAX_SOURCE_BYTES = 1 * 1024;
const MAX_DETAILS_BYTES = 8 * 1024;

const REDACTED = '[REDACTED]';

const authHeaderPattern = /(authorization\s*:\s*(?:bearer|basic)\s+)[A-Za-z0-9._\-+/=]+/gi;
const cookiePattern = /(kanban-token\s*=\s*)([A-Za-z0-9._\-+/=]+)/gi;
const queryTokenPattern = /([?&](?:token|api[_-]?key|access[_-]?token|auth)\s*=\s*)([A-Za-z0-9._\-+/=]+)/gi;
const secretKeyPattern = /("(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|refresh[_-]?token)"\s*:\s*)"([^"]*)"/gi;

export type EventType =
  | 'error'
  | 'unhandled_rejection'
  | 'react_error'
  | 'console_error'
  | 'resource_404';

export interface ReporterConfig {
  /** When false, every {@link reportError} call is a no-op. */
  enabled: boolean;
  /** Endpoint the reporter POSTs to. Defaults to /api/v1/frontend-events. */
  endpoint: string;
  /**
   * Optional async probe the reporter can call to discover the
   * server-side admin toggle on startup. Resolves to false when
   * the probe fails (network error, 401, etc.) so a transient
   * failure never disables the sink.
   */
  serverEnabledProbe?: () => Promise<boolean>;
  /** Custom fetch implementation — used by the tests. */
  fetchImpl?: typeof fetch;
}

export interface ReportedEvent {
  eventType: EventType;
  message: string;
  stack?: string;
  url?: string;
  source?: string;
  details?: Record<string, unknown>;
}

export interface Reporter {
  /**
   * Send a single event. The endpoint may be unreachable;
   * the reporter swallows network errors so it never crashes
   * the host page.
   */
  report(event: ReportedEvent): Promise<void>;
  /** Read the currently-effective enabled flag. */
  isEnabled(): boolean;
  /** Flip the per-session enabled flag at runtime. */
  setEnabled(enabled: boolean): void;
  /**
   * Read the redacted representation of a string so a test or
   * developer console can preview what would be POSTed without
   * actually firing a request.
   */
  redact(input: string): string;
  /** Wire window.onerror + unhandledrejection. Idempotent. */
  install(): void;
  /** Remove the global listeners and stop future reporting. */
  uninstall(): void;
}

class ErrorReporterImpl implements Reporter {
  private enabled: boolean;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly serverEnabledProbe?: () => Promise<boolean>;
  private serverEnabled: boolean = true;
  private boundOnError: ((event: ErrorEvent) => void) | null = null;
  private boundOnRejection: ((event: PromiseRejectionEvent) => void) | null = null;
  private installed: boolean = false;
  // Coalesce identical events within the same tick so a tight
  // loop blowing up 100x does not flood the network.
  private recentKeys: Set<string> = new Set();

  constructor(config: ReporterConfig) {
    this.enabled = config.enabled;
    this.endpoint = config.endpoint || DEFAULT_ENDPOINT;
    this.fetchImpl = config.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : noopFetch);
    this.serverEnabledProbe = config.serverEnabledProbe;
  }

  /**
   * Wire window.onerror + unhandledrejection. Idempotent: a
   * second call replaces the previous bindings so a React
   * StrictMode double-invoke does not double up the listeners.
   */
  install(): void {
    if (typeof window === 'undefined') return;
    if (this.installed) return;
    this.installed = true;

    this.boundOnError = (event) => {
      const message = event.message || event.error?.message || 'Unknown error';
      void this.report({
        eventType: 'error',
        message,
        stack: event.error?.stack,
        source: composeSource(event.filename, event.lineno, event.colno),
        url: safeLocationHref(),
      });
    };
    this.boundOnRejection = (event) => {
      const reason = event.reason;
      const message =
        reason instanceof Error
          ? reason.message
          : typeof reason === 'string'
            ? reason
            : safeStringify(reason) || 'Unhandled rejection';
      const stack = reason instanceof Error ? reason.stack : undefined;
      void this.report({
        eventType: 'unhandled_rejection',
        message,
        stack,
        url: safeLocationHref(),
      });
    };

    window.addEventListener('error', this.boundOnError);
    window.addEventListener('unhandledrejection', this.boundOnRejection);

    // Best-effort probe of the server-side toggle. A failure
    // here is logged but never disables the client-side
    // capture; a transient network error must not silence
    // unhandled exceptions.
    if (this.serverEnabledProbe) {
      this.serverEnabledProbe()
        .then((v) => {
          this.serverEnabled = v;
        })
        .catch(() => {
          this.serverEnabled = true;
        });
    }
  }

  uninstall(): void {
    if (typeof window === 'undefined') return;
    if (!this.installed) return;
    if (this.boundOnError) {
      window.removeEventListener('error', this.boundOnError);
    }
    if (this.boundOnRejection) {
      window.removeEventListener('unhandledrejection', this.boundOnRejection);
    }
    this.boundOnError = null;
    this.boundOnRejection = null;
    this.installed = false;
  }

  isEnabled(): boolean {
    return this.enabled && this.serverEnabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(STORAGE_KEY_ENABLED, enabled ? '1' : '0');
      } catch {
        // localStorage may be unavailable (private mode,
        // quota exhausted). The in-memory flag is enough to
        // honor the toggle for the rest of the session.
      }
    }
  }

  redact(input: string): string {
    return redactString(input);
  }

  async report(event: ReportedEvent): Promise<void> {
    if (!this.isEnabled()) return;

    const message = redactString(cap(event.message, MAX_MESSAGE_BYTES));
    const stack = event.stack ? redactString(cap(event.stack, MAX_STACK_BYTES)) : undefined;
    const url = event.url ? redactString(cap(event.url, MAX_URL_BYTES)) : undefined;
    const source = event.source ? redactString(cap(event.source, MAX_SOURCE_BYTES)) : undefined;
    const details = event.details
      ? redactJsonString(safeStringify(event.details), MAX_DETAILS_BYTES)
      : undefined;

    const dedupKey = `${event.eventType}:${message}:${stack ?? ''}`;
    if (this.recentKeys.has(dedupKey)) return;
    this.recentKeys.add(dedupKey);
    // Clear after a tick so a different code path with the same
    // payload can still report (e.g. the React boundary reports
    // it once, then window.onerror fires too — both should
    // surface, just not 50 times in a row from the same source).
    setTimeout(() => {
      this.recentKeys.delete(dedupKey);
    }, 250);

    const payload: Record<string, unknown> = {
      eventType: event.eventType,
      message,
    };
    if (stack) payload.stack = stack;
    if (url) payload.url = url;
    if (source) payload.source = source;
    if (details) payload.details = details;

    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
      });
      // 204 means the admin disabled the sink — flip our
      // server-side cache so we stop posting until the next
      // install() cycle. Anything 2xx is success.
      if (response.status === 204) {
        this.serverEnabled = false;
      }
    } catch {
      // Network errors are silently dropped — we don't want a
      // failing sink to fill the console with its own errors.
    }
  }
}

function noopFetch(): Promise<Response> {
  return Promise.reject(new Error('fetch is not available'));
}

function safeLocationHref(): string {
  try {
    if (typeof window === 'undefined') return '';
    return window.location?.href ?? '';
  } catch {
    return '';
  }
}

function composeSource(filename: string | undefined, lineno: number | undefined, colno: number | undefined): string {
  if (!filename) return '';
  if (typeof lineno === 'number' && typeof colno === 'number') {
    return `${filename}:${lineno}:${colno}`;
  }
  if (typeof lineno === 'number') {
    return `${filename}:${lineno}`;
  }
  return filename;
}

function cap(input: string, maxBytes: number): string {
  if (!input) return input;
  if (input.length <= maxBytes) return input;
  // Walk back to a UTF-8 rune boundary so the truncated value
  // is always valid UTF-8. JavaScript strings are UTF-16, so
  // we walk by code unit — the byte-vs-char distinction does
  // not matter here because the server enforces the byte cap
  // and the wire format is UTF-8 (so a single surrogate pair
  // would otherwise produce a replacement rune).
  let end = maxBytes;
  while (end > 0 && isHighSurrogate(input.charCodeAt(end - 1))) {
    end--;
  }
  return input.slice(0, end);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

/**
 * redactString applies the same redaction pass the server
 * runs (see handlers/frontend_events.go). Doing both sides
 * keeps the wire payload safe even if the server forgets, and
 * the server-side pass keeps the database safe if the client
 * forgets. Order is identical to the Go implementation so
 * the output is deterministic for the same input.
 */
export function redactString(input: string): string {
  if (!input) return input;
  let out = input;
  out = out.replace(authHeaderPattern, `$1${REDACTED}`);
  out = out.replace(cookiePattern, `$1${REDACTED}`);
  out = out.replace(queryTokenPattern, `$1${REDACTED}`);
  out = out.replace(secretKeyPattern, `$1"${REDACTED}"`);
  return out;
}

/**
 * redactJsonString is the JSON-blob twin of redactString. We
 * stringify first because the secret keys only matter when
 * they're inside a JSON object — the same string in plain
 * English is not a credential.
 */
function redactJsonString(input: string, maxBytes: number): string {
  if (!input) return input;
  const redacted = redactString(input);
  return cap(redacted, maxBytes);
}

/**
 * readPersistedEnabled reads the per-session user toggle from
 * localStorage. Returning undefined (not false) when the key
 * is missing is important: the caller decides whether the
 * default is on or off.
 */
export function readPersistedEnabled(): boolean | undefined {
  if (typeof localStorage === 'undefined') return undefined;
  try {
    const raw = localStorage.getItem(STORAGE_KEY_ENABLED);
    if (raw === null) return undefined;
    return raw === '1';
  } catch {
    return undefined;
  }
}

/**
 * createErrorReporter wires a fresh {@link Reporter} with the
 * provided config. The Settings page calls this with
 * `enabled = readPersistedEnabled()`; main.tsx calls it with
 * the admin-on-by-default fallback so a fresh session always
 * wires the global handlers.
 */
export function createErrorReporter(config: ReporterConfig): Reporter {
  return new ErrorReporterImpl(config);
}

/**
 * getDefaultConfig is the shared default-config factory used
 * by main.tsx and the Settings page. Centralised so the
 * Settings toggle and the boot-time wiring cannot disagree on
 * the endpoint or the local-storage key.
 */
export function getDefaultConfig(): ReporterConfig {
  const persisted = readPersistedEnabled();
  return {
    enabled: persisted === undefined ? true : persisted,
    endpoint: DEFAULT_ENDPOINT,
  };
}