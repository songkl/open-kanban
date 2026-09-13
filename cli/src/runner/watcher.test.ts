// Tests for `runner/watcher.ts` — the WebSocket subscription
// that lets the runner wake up immediately when the server
// broadcasts a new task instead of waiting for the next poll
// cycle.
//
// We exercise the module against a fake WebSocket factory so
// the test never touches a real network socket. The fake
// records every method call so the assertions can cover:
//   * the URL is built from the apiUrl + /ws path
//   * the cookie header carries the bearer token
//   * task_notification frames dispatch onNotification
//   * frames whose boardId doesn't match are filtered out
//   * reconnect after `onclose` with exponential backoff
//   * `close()` tears down the underlying WS cleanly

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildWsUrl,
  watchBoardNotifications,
  type TaskNotificationMessage,
} from "./watcher.js";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  static reset(): void {
    FakeWebSocket.instances = [];
  }

  static latest(): FakeWebSocket {
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    if (!ws) throw new Error("no FakeWebSocket instance captured");
    return ws;
  }

  url: string;
  options?: { headers?: Record<string, string> };
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string | Buffer }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  sentFrames: string[] = [];

  constructor(url: string, options?: { headers?: Record<string, string> }) {
    this.url = url;
    this.options = options;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sentFrames.push(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.onclose) this.onclose();
  }

  // Test helpers
  emitOpen(): void {
    this.onopen?.();
  }
  emitMessage(frame: unknown): void {
    this.onmessage?.({ data: frame as string });
  }
  emitServerClose(): void {
    this.closed = true;
    this.onclose?.();
  }
}

beforeEach(() => {
  FakeWebSocket.reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeFactory(): (url: string, headers: Record<string, string>) => FakeWebSocket {
  return (url: string, headers: Record<string, string>) =>
    new FakeWebSocket(url, { headers }) as unknown as never;
}

describe("buildWsUrl", () => {
  it("rewrites http to ws", () => {
    expect(buildWsUrl("http://localhost:8080")).toBe("ws://localhost:8080/ws");
  });

  it("rewrites https to wss", () => {
    expect(buildWsUrl("https://api.example.com")).toBe(
      "wss://api.example.com/ws"
    );
  });

  it("strips trailing slashes before appending /ws", () => {
    expect(buildWsUrl("http://api.example.com/")).toBe(
      "ws://api.example.com/ws"
    );
  });
});

describe("watchBoardNotifications", () => {
  it("opens a WS at the canonical /ws path with the bearer cookie", () => {
    const factory = vi.fn(makeFactory());
    const onNotification = vi.fn();

    watchBoardNotifications({
      apiUrl: "https://api.example.com",
      boardId: "board-1",
      token: "test-token",
      wsFactory: factory as unknown as (url: string) => never,
      onNotification,
      reconnectBaseMs: 1,
    });

    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0][0]).toBe("wss://api.example.com/ws");
    const ws = FakeWebSocket.latest();
    expect(ws.options?.headers?.cookie).toBe("kanban-token=test-token");
  });

  it("dispatches task_notification frames to onNotification", () => {
    const onNotification = vi.fn();

    watchBoardNotifications({
      apiUrl: "https://api.example.com",
      boardId: "board-1",
      token: "t",
      wsFactory: makeFactory() as unknown as (url: string) => never,
      onNotification,
      reconnectBaseMs: 1,
    });

    const ws = FakeWebSocket.latest();
    ws.emitOpen();
    ws.emitMessage(
      JSON.stringify({
        type: "task_notification",
        boardId: "board-1",
        taskId: "task-1",
        action: "create",
      })
    );

    expect(onNotification).toHaveBeenCalledTimes(1);
    expect(onNotification.mock.calls[0][0]).toMatchObject({
      type: "task_notification",
      boardId: "board-1",
      taskId: "task-1",
      action: "create",
    });
  });

  it("filters out frames whose boardId does not match", () => {
    const onNotification = vi.fn();

    watchBoardNotifications({
      apiUrl: "https://api.example.com",
      boardId: "board-1",
      token: "t",
      wsFactory: makeFactory() as unknown as (url: string) => never,
      onNotification,
      reconnectBaseMs: 1,
    });

    const ws = FakeWebSocket.latest();
    ws.emitOpen();
    ws.emitMessage(
      JSON.stringify({
        type: "task_notification",
        boardId: "board-other",
        taskId: "task-1",
        action: "create",
      })
    );

    expect(onNotification).not.toHaveBeenCalled();
  });

  it("ignores non-task_notification frames (heartbeat_ack etc.)", () => {
    const onNotification = vi.fn();

    watchBoardNotifications({
      apiUrl: "https://api.example.com",
      boardId: "board-1",
      token: "t",
      wsFactory: makeFactory() as unknown as (url: string) => never,
      onNotification,
      reconnectBaseMs: 1,
    });

    const ws = FakeWebSocket.latest();
    ws.emitOpen();
    ws.emitMessage(JSON.stringify({ type: "heartbeat_ack" }));
    ws.emitMessage(JSON.stringify({ type: "refresh" }));
    ws.emitMessage("not-json");

    expect(onNotification).not.toHaveBeenCalled();
  });

  it("reconnects with exponential backoff after a server-side close", () => {
    const factory = vi.fn(makeFactory());
    const onDisconnect = vi.fn();

    watchBoardNotifications({
      apiUrl: "https://api.example.com",
      boardId: "board-1",
      token: "t",
      wsFactory: factory as unknown as (url: string) => never,
      onNotification: () => undefined,
      onDisconnect,
      reconnectBaseMs: 100,
    });

    // First connection opens.
    FakeWebSocket.latest().emitOpen();
    // Server closes.
    FakeWebSocket.latest().emitServerClose();
    expect(onDisconnect).toHaveBeenCalledTimes(1);

    // After the back-off window the factory should be re-invoked.
    vi.advanceTimersByTime(200);
    expect(factory.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("closes the WS and stops reconnecting when close() is called", () => {
    const factory = vi.fn(makeFactory());

    const handle = watchBoardNotifications({
      apiUrl: "https://api.example.com",
      boardId: "board-1",
      token: "t",
      wsFactory: factory as unknown as (url: string) => never,
      onNotification: () => undefined,
      reconnectBaseMs: 1,
    });

    const ws = FakeWebSocket.latest();
    handle.close();

    expect(ws.closed).toBe(true);

    // Advancing time should NOT trigger another reconnect.
    vi.advanceTimersByTime(10_000);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("aborts immediately when the signal is already aborted", () => {
    const factory = vi.fn(makeFactory());
    const controller = new AbortController();
    controller.abort();

    watchBoardNotifications({
      apiUrl: "https://api.example.com",
      boardId: "board-1",
      token: "t",
      wsFactory: factory as unknown as (url: string) => never,
      onNotification: () => undefined,
      reconnectBaseMs: 1,
      signal: controller.signal,
    });

    expect(factory).not.toHaveBeenCalled();
  });

  it("survives a callback throw so a single bad notification does not strand the subscription", () => {
    const onDisconnect = vi.fn();

    watchBoardNotifications({
      apiUrl: "https://api.example.com",
      boardId: "board-1",
      token: "t",
      wsFactory: makeFactory() as unknown as (url: string) => never,
      onNotification: () => {
        throw new Error("kaboom");
      },
      onDisconnect,
      reconnectBaseMs: 1,
    });

    const ws = FakeWebSocket.latest();
    ws.emitOpen();
    ws.emitMessage(
      JSON.stringify({
        type: "task_notification",
        boardId: "board-1",
        action: "create",
      })
    );

    expect(onDisconnect).toHaveBeenCalled();
  });

  it("forwards notifications even when boardId is absent (legacy broadcasts)", () => {
    const onNotification = vi.fn<(msg: TaskNotificationMessage) => void>();

    watchBoardNotifications({
      apiUrl: "https://api.example.com",
      boardId: "board-1",
      token: "t",
      wsFactory: makeFactory() as unknown as (url: string) => never,
      onNotification,
      reconnectBaseMs: 1,
    });

    const ws = FakeWebSocket.latest();
    ws.emitOpen();
    ws.emitMessage(
      JSON.stringify({
        type: "task_notification",
        taskId: "task-1",
        action: "create",
      })
    );

    expect(onNotification).toHaveBeenCalledTimes(1);
  });
});
