// Runner-side WebSocket subscription — the "WS push replaces 5s
// polling" half of the s-1130 deliverable.
//
// The runner loop (`runner/loop.ts`) historically polls the
// server every `pollIntervalMs` (default 5s) for the next
// claimable task. That cadence keeps idle-runner CPU near zero
// but adds a worst-case `pollIntervalMs` latency between "task
// lands in the column" and "runner starts working on it".
//
// This module opens a WebSocket to the server's `/ws` endpoint
// and wakes the loop the moment a `task_notification` arrives
// for the watched board/column. The loop's underlying poll
// remains as a fallback so a WS disconnect / failed handshake
// can't strand the runner — the wake-up just shaves the
// latency off the common case.
//
// Wire shape (matches the existing broadcast_queue plumbing
// in backend/internal/handlers/websocket_broadcast.go):
//
//   in  →  ws://<api>/ws  (header: Cookie: kanban-token=<token>)
//   out →  text frames:
//            { "type": "task_notification",
//              "boardId": "...",
//              "taskId":  "...",
//              "action":  "create|update|update_status|attach|..." }
//
// The runner does not need to interact with the WS frames
// beyond reading them — the existing server already filters
// broadcasts by board, so any frame we receive is by definition
// something we wanted to hear about.

import WebSocket from "ws";
import { HttpClient } from "../http/client.js";

/**
 * Minimal subset of the WebSocket message envelope we care
 * about. We type it loosely so older server versions that
 * surface slightly different shapes still parse cleanly.
 */
export interface TaskNotificationMessage {
  type?: string;
  boardId?: string;
  taskId?: string;
  action?: string;
}

export interface RunWatchOptions {
  apiUrl: string;
  boardId: string;
  /** Bearer token forwarded as the `kanban-token` cookie. */
  token: string;
  /** Test seam: replace the WS factory. Receives the resolved
   *  URL plus the cookie header so a test fake can assert on
   *  the upgrade request shape. */
  wsFactory?: (url: string, headers: Record<string, string>) => WebSocket;
  /** Test seam: replace the bearer-token getter. */
  tokenProvider?: (client: HttpClient) => Promise<string | null>;
  /** Called whenever the server pushes a notification we care about. */
  onNotification: (msg: TaskNotificationMessage) => void;
  /** Called when the WS connection drops. */
  onDisconnect?: (err: Error | null) => void;
  /** Called when the WS connection comes up. */
  onConnect?: () => void;
  /** Test seam: override the connect delay so the test suite doesn't wait. */
  reconnectBaseMs?: number;
  /** Optional abort signal so callers (the loop) can shut the watch down cleanly. */
  signal?: AbortSignal;
  /** Test seam: capture the underlying WS instance for assertions. */
  captureWs?: (ws: WebSocket) => void;
}

export interface RunWatchHandle {
  /** Stop watching and tear down the underlying WS connection. */
  close(): void;
}

const DEFAULT_RECONNECT_BASE_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;

/**
 * Open a WebSocket subscription against the server and call
 * `onNotification` for every task_notification frame whose
 * boardId matches the supplied `boardId`.
 *
 * Reconnect strategy: exponential backoff capped at 30s,
 * matching the existing `useBoardWebSocket` front-end hook so
 * operators see consistent behaviour across both clients. The
 * loop's own polling continues running while we wait for a
 * reconnect — the wake-up path is a latency optimisation, not
 * a hard dependency.
 */
export function watchBoardNotifications(
  opts: RunWatchOptions
): RunWatchHandle {
  const wsUrl = buildWsUrl(opts.apiUrl);
  const headers = { cookie: `kanban-token=${opts.token}` };
  let closed = false;
  let attempt = 0;
  let currentWs: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = (): void => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const scheduleReconnect = (): void => {
    if (closed) return;
    const base = opts.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
    const delay = Math.min(
      base * Math.pow(2, attempt),
      DEFAULT_RECONNECT_MAX_MS
    );
    reconnectTimer = setTimeout(connect, delay);
  };

  const onAbort = (): void => {
    closed = true;
    clearTimer();
    if (currentWs) {
      try {
        currentWs.onclose = null;
        currentWs.onerror = null;
        currentWs.onmessage = null;
        currentWs.onopen = null;
        currentWs.close();
      } catch {
        // already closed
      }
      currentWs = null;
    }
  };

  if (opts.signal) {
    if (opts.signal.aborted) {
      onAbort();
      return { close: () => undefined };
    }
    opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  const connect = (): void => {
    if (closed) return;
    const factory = opts.wsFactory ?? defaultWsFactory;
    let ws: WebSocket;
    try {
      ws = factory(wsUrl, headers);
    } catch (err) {
      opts.onDisconnect?.(err as Error);
      attempt += 1;
      scheduleReconnect();
      return;
    }
    currentWs = ws;
    opts.captureWs?.(ws);

    ws.onopen = () => {
      attempt = 0;
      opts.onConnect?.();
    };

    ws.onmessage = (event) => {
      const data = event.data;
      if (typeof data !== "string" && !(data instanceof Buffer)) return;
      const text = typeof data === "string" ? data : data.toString("utf8");
      let parsed: TaskNotificationMessage;
      try {
        parsed = JSON.parse(text) as TaskNotificationMessage;
      } catch {
        return;
      }
      if (parsed.type !== "task_notification") return;
      if (opts.boardId && parsed.boardId && parsed.boardId !== opts.boardId) {
        return;
      }
      try {
        opts.onNotification(parsed);
      } catch (err) {
        // Don't kill the WS on a callback throw — the loop
        // is hot and an exception in one notification should
        // not strand the subscription.
        opts.onDisconnect?.(err as Error);
      }
    };

    ws.onerror = () => {
      // Browsers fire `error` before `close`; Node `ws`
      // mirrors that. The actual reconnect logic lives in
      // `onclose` so we don't double-schedule here.
    };

    ws.onclose = () => {
      if (closed) return;
      attempt += 1;
      opts.onDisconnect?.(null);
      scheduleReconnect();
    };
  };

  // Inject the cookie so the existing WS upgrade handler
  // accepts the handshake. The HTTP path stores the token in
  // the same cookie via `auth_token_handlers.go`.
  function defaultWsFactory(
    url: string,
    wsHeaders: Record<string, string>
  ): WebSocket {
    return new WebSocket(url, { headers: wsHeaders });
  }

  connect();

  return {
    close: () => {
      onAbort();
    },
  };
}

/**
 * Convert an http(s) base URL into the matching ws(s) URL and
 * append the canonical `/ws` upgrade path. Mirrors the
 * front-end `getWsUrl` helper in
 * `frontend/src/hooks/useBoardWebSocket.ts`.
 */
export function buildWsUrl(apiUrl: string): string {
  const trimmed = apiUrl.replace(/\/+$/, "");
  const replaced = trimmed.replace(/^http/i, "ws");
  return `${replaced}/ws`;
}
