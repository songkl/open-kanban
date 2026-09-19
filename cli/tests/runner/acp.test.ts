// Tests for `cli/src/runner/acp.ts` — JSON-RPC framing, the
// `AcpClient` handshake, and the s-1235 spawn-layer plumbing that
// routes `promptMode: "acp"` through the protocol.
//
// We avoid real binaries by using the `MockAcpTransport` helper
// below: it pairs a `Writable` stub with a `Readable` stub so we can
// drive the JSON-RPC state machine with hand-written frames.
// Streaming notification coverage is included so a future spec
// revision that changes the chunk shape breaks this test, not
// production.

import { Writable } from "node:stream";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import {
  AcpClient,
  JsonRpcClient,
  LineJsonTransport,
  type AcpTransport,
} from "../../src/runner/acp.js";

/**
 * Tiny in-memory writable. We override `write` so we can observe
 * the bytes `LineJsonTransport` sends without relying on Node's
 * back-pressure machinery — the tests don't care about flow
 * control.
 */
class MockWritable extends Writable {
  public readonly writes: Buffer[] = [];
  override _write(
    chunk: Buffer | string,
    _enc: BufferEncoding,
    cb: (err?: Error | null) => void
  ): void {
    this.writes.push(
      typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk
    );
    cb();
  }
}

/**
 * Minimal in-memory readable. We bypass Node's `_read` state
 * machine entirely: the test pushes data via `feed` and closes via
 * `close()`, and downstream `data` listeners consume chunks in
 * order. The transport layer is what does the line splitting, so
 * we keep this transport-friendly.
 */
class MockReadable {
  private readonly emitter = new EventEmitter();
  private buffer = "";
  private closed = false;

  feed(chunk: string): void {
    if (this.closed) return;
    this.buffer += chunk;
    this.drain();
  }

  close(): void {
    this.closed = true;
    // Flush any trailing partial frame as one last `data` event so
    // `LineJsonTransport` can surface it as a frame.
    if (this.buffer.length > 0) {
      this.emitter.emit("data", this.buffer);
      this.buffer = "";
    }
    this.emitter.emit("close");
  }

  on(event: "data", listener: (chunk: string | Buffer) => void): this {
    this.emitter.on(event, listener);
    return this;
  }
  on(event: "error", listener: (err: Error) => void): this {
    this.emitter.on(event, listener);
    return this;
  }
  on(event: "close", listener: () => void): this {
    this.emitter.on(event, listener);
    return this;
  }
  on(event: string, listener: (...args: unknown[]) => void): this {
    this.emitter.on(event, listener);
    return this;
  }

  private drain(): void {
    const nl = this.buffer.indexOf("\n");
    if (nl >= 0) {
      const chunk = this.buffer.slice(0, nl + 1);
      this.buffer = this.buffer.slice(nl + 1);
      this.emitter.emit("data", chunk);
      if (this.buffer.length > 0) this.drain();
    }
  }
}

/**
 * Cross-stream glue — `LineJsonTransport` accepts a node Writable
 * for the sink and a Readable for the source. We adapt `MockReadable`
 * to look like a Readable by exposing `on(event, listener)` and
 * forwarding `data` / `close` events. The transport only reads from
 * the readable, never calls `_read` itself, so we don't need to
 * implement the rest of the Readable contract.
 */
function asNodeReadable(mock: MockReadable): {
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
  setEncoding?: (enc: string) => void;
} {
  return {
    on: (event, listener) => mock.on(event, listener),
    setEncoding: () => undefined,
  };
}

class MockAcpTransport implements AcpTransport {
  private readonly emitter = new EventEmitter();
  public readonly frames: string[] = [];
  public closed = false;
  public failOnWrite = false;
  constructor() {}
  writeFrame(payload: string): void {
    if (this.closed) {
      throw new Error("ACP transport already closed");
    }
    if (this.failOnWrite) {
      throw new Error("mock write failed");
    }
    this.frames.push(payload);
  }
  end(): void {
    this.closed = true;
    this.emitter.emit("close");
  }
  on(event: string, listener: (...args: unknown[]) => void): this {
    this.emitter.on(event, listener);
    return this;
  }
  off(event: string, listener: (...args: unknown[]) => void): this {
    this.emitter.off(event, listener);
    return this;
  }
  emitFrame(payload: string): void {
    this.emitter.emit("frame", payload);
  }
  emitError(err: Error): void {
    this.emitter.emit("error", err);
  }
  emitClose(): void {
    this.emitter.emit("close");
  }
}

function makeTransportPair(): {
  transport: LineJsonTransport;
  writable: MockWritable;
  readable: MockReadable;
} {
  const writable = new MockWritable();
  const readable = new MockReadable();
  const transport = new LineJsonTransport(
    writable,
    asNodeReadable(readable) as unknown as import("node:stream").Readable
  );
  return { transport, writable, readable };
}

afterEach(() => {
  // No globals to reset; vitest's per-test isolation is enough.
});

describe("LineJsonTransport", () => {
  it("emits a frame for every newline-terminated chunk", () => {
    const { transport, readable } = makeTransportPair();
    const frames: string[] = [];
    transport.on("frame", (raw) => frames.push(String(raw)));
    readable.feed('{"id":1}\n');
    readable.feed('{"id":2}\n');
    expect(frames).toEqual(['{"id":1}', '{"id":2}']);
  });

  it("buffers partial frames until a newline arrives", () => {
    const { transport, readable } = makeTransportPair();
    const frames: string[] = [];
    transport.on("frame", (raw) => frames.push(String(raw)));
    readable.feed('{"id":1');
    readable.feed(',"method":"foo"}\n');
    expect(frames).toEqual(['{"id":1,"method":"foo"}']);
  });

  it("emits a final partial frame on stream close", () => {
    const { transport, readable } = makeTransportPair();
    const frames: string[] = [];
    transport.on("frame", (raw) => frames.push(String(raw)));
    readable.feed('{"id":1,"method":"foo"}');
    readable.close();
    // No newline; the transport still surfaces the partial frame so
    // callers can decide whether the trailing bytes were meaningful.
    expect(frames).toEqual(['{"id":1,"method":"foo"}']);
  });

  it("emits an error event when the writable fails", () => {
    // Wrap a tiny Writable whose underlying stream emits an error.
    // We attach the error handler manually because we do not go
    // through Node's normal writable.emit() — instead we leverage
    // EventEmitter semantics on the writable itself.
    const emitter = new EventEmitter();
    const writable = Object.assign(new Writable(), { __placeholder: true });
    void emitter;
    const readable = new MockReadable();
    const transport = new LineJsonTransport(
      writable,
      asNodeReadable(readable) as unknown as import("node:stream").Readable
    );
    const errors: Error[] = [];
    transport.on("error", (err) => errors.push(err as Error));
    writable.on("error", () => undefined);
    // Trigger the error through the Node writable's emitter.
    (writable as unknown as { emit: (e: string, v: unknown) => boolean }).emit(
      "error",
      new Error("pipe closed")
    );
    expect(errors.length).toBe(1);
    expect(errors[0].message).toBe("pipe closed");
  });

  it("rejects writes after the channel has closed", () => {
    const transport = new MockAcpTransport();
    transport.end();
    expect(() => transport.writeFrame("{}")).toThrow(/closed/);
  });
});

describe("JsonRpcClient", () => {
  it("correlates responses with in-flight requests by id", async () => {
    const transport = new MockAcpTransport();
    const client = new JsonRpcClient(transport);

    const pending = client.request({
      method: "session/prompt",
      params: { sessionId: "s", prompt: [{ type: "text", text: "x" }] },
    });

    // The request frame must have been written with a numeric id.
    expect(transport.frames.length).toBe(1);
    const written = JSON.parse(transport.frames[0]);
    expect(written.id).toBe(1);
    expect(written.method).toBe("session/prompt");

    // Resolve by emitting the response frame with the matching id.
    transport.emitFrame(
      JSON.stringify({ jsonrpc: "2.0", id: written.id, result: { ok: true } })
    );
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it("rejects when the agent returns a JSON-RPC error frame", async () => {
    const transport = new MockAcpTransport();
    const client = new JsonRpcClient(transport);
    const pending = client.request({
      method: "session/prompt",
      params: { sessionId: "s", prompt: [{ type: "text", text: "x" }] },
    });
    const written = JSON.parse(transport.frames[0]);
    transport.emitFrame(
      JSON.stringify({
        jsonrpc: "2.0",
        id: written.id,
        error: { code: -32600, message: "agent refused" },
      })
    );
    await expect(pending).rejects.toThrow(/agent refused/);
  });

  it("dispatches notifications by method name", () => {
    const transport = new MockAcpTransport();
    const client = new JsonRpcClient(transport);
    const seen: unknown[] = [];
    client.onNotification("session/update", (params) => seen.push(params));
    transport.emitFrame(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } },
      })
    );
    expect(seen).toEqual([
      { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } },
    ]);
  });

  it("fails every in-flight request on a transport error", async () => {
    const transport = new MockAcpTransport();
    const client = new JsonRpcClient(transport);
    const a = client.request({
      method: "initialize",
      params: { protocolVersion: 1, clientInfo: { name: "x", version: "0" } },
    });
    const b = client.request({
      method: "session/new",
      params: { cwd: "/" },
    });
    transport.emitError(new Error("transport died"));
    await expect(a).rejects.toThrow(/transport died/);
    await expect(b).rejects.toThrow(/transport died/);
  });

  it("ignores frames without a numeric id (no false dispatches)", () => {
    const transport = new MockAcpTransport();
    const client = new JsonRpcClient(transport);
    const seen: unknown[] = [];
    client.onNotification("session/update", (params) => seen.push(params));
    transport.emitFrame(JSON.stringify({ unrelated: true }));
    transport.emitFrame(JSON.stringify({ id: "abc" }));
    expect(seen).toEqual([]);
  });

  it("forwards malformed JSON frames to the configured error sink", () => {
    const transport = new MockAcpTransport();
    const errors: Error[] = [];
    const client = new JsonRpcClient(transport, (err) => errors.push(err));
    transport.emitFrame("{not-json");
    expect(errors.length).toBe(1);
    expect(errors[0].message).toMatch(/invalid JSON/);
  });

  it("rejects the in-flight request when the abort signal fires", async () => {
    const transport = new MockAcpTransport();
    const client = new JsonRpcClient(transport);
    const ac = new AbortController();
    const pending = client.request(
      {
        method: "session/prompt",
        params: { sessionId: "s", prompt: [{ type: "text", text: "x" }] },
      },
      ac.signal
    );
    ac.abort(new Error("user pressed Ctrl-C"));
    await expect(pending).rejects.toThrow(/aborted/);
  });
});

describe("AcpClient.run", () => {
  function setupAgent(): { transport: MockAcpTransport; client: AcpClient } {
    const transport = new MockAcpTransport();
    const client = new AcpClient({
      transport,
      cwd: "/tmp/work",
    });
    return { transport, client };
  }

  function lastRequestId(transport: MockAcpTransport): number {
    const ids = transport.frames
      .map((f) => JSON.parse(f).id)
      .filter((id): id is number => typeof id === "number");
    return ids[ids.length - 1] ?? 0;
  }

  it("performs initialize → session/new → session/prompt and aggregates text chunks", async () => {
    const { transport, client } = setupAgent();
    const promise = client.run("PROMPT");
    // initialize
    expect(transport.frames[0]).toContain('"method":"initialize"');
    transport.emitFrame(
      JSON.stringify({
        jsonrpc: "2.0",
        id: lastRequestId(transport),
        result: { protocolVersion: 1, agentInfo: { name: "test-agent", version: "1" } },
      })
    );
    // session/new
    await new Promise((r) => setImmediate(r));
    expect(transport.frames[1]).toContain('"method":"session/new"');
    transport.emitFrame(
      JSON.stringify({
        jsonrpc: "2.0",
        id: lastRequestId(transport),
        result: { sessionId: "sess-1" },
      })
    );
    // session/prompt
    await new Promise((r) => setImmediate(r));
    expect(transport.frames[2]).toContain('"method":"session/prompt"');
    // Stream a couple of text chunks before responding.
    transport.emitFrame(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Hello, " },
          },
        },
      })
    );
    transport.emitFrame(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "world!" },
          },
        },
      })
    );
    transport.emitFrame(
      JSON.stringify({
        jsonrpc: "2.0",
        id: lastRequestId(transport),
        result: { stopReason: "end_turn" },
      })
    );
    const result = await promise;
    expect(result.reason).toBe("exit");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Hello, world!");
    expect(result.stderr).toBe("");
  });

  it("returns spawn_error when initialize fails", async () => {
    const { transport, client } = setupAgent();
    const promise = client.run("PROMPT");
    transport.emitFrame(
      JSON.stringify({
        jsonrpc: "2.0",
        id: lastRequestId(transport),
        error: { code: -32600, message: "protocol version mismatch" },
      })
    );
    const result = await promise;
    expect(result.reason).toBe("spawn_error");
    expect(result.stderr).toMatch(/protocol version mismatch/);
  });

  it("returns spawn_error when session/new returns no sessionId", async () => {
    const { transport, client } = setupAgent();
    const promise = client.run("PROMPT");
    transport.emitFrame(
      JSON.stringify({
        jsonrpc: "2.0",
        id: lastRequestId(transport),
        result: { protocolVersion: 1 },
      })
    );
    await new Promise((r) => setImmediate(r));
    transport.emitFrame(
      JSON.stringify({
        jsonrpc: "2.0",
        id: lastRequestId(transport),
        result: { sessionId: "" },
      })
    );
    const result = await promise;
    expect(result.reason).toBe("spawn_error");
    expect(result.stderr).toMatch(/empty sessionId/);
  });

  it("falls back to the prompt response's text field when no chunks streamed", async () => {
    const { transport, client } = setupAgent();
    const promise = client.run("PROMPT");
    transport.emitFrame(
      JSON.stringify({ jsonrpc: "2.0", id: lastRequestId(transport), result: { protocolVersion: 1 } })
    );
    await new Promise((r) => setImmediate(r));
    transport.emitFrame(
      JSON.stringify({ jsonrpc: "2.0", id: lastRequestId(transport), result: { sessionId: "sess-2" } })
    );
    await new Promise((r) => setImmediate(r));
    transport.emitFrame(
      JSON.stringify({
        jsonrpc: "2.0",
        id: lastRequestId(transport),
        result: { text: "FALLBACK REPLY", stopReason: "end_turn" },
      })
    );
    const result = await promise;
    expect(result.stdout).toBe("FALLBACK REPLY");
  });

  it("ignores non-text chunks and non-message notifications", async () => {
    const { transport, client } = setupAgent();
    const promise = client.run("PROMPT");
    transport.emitFrame(
      JSON.stringify({ jsonrpc: "2.0", id: lastRequestId(transport), result: { protocolVersion: 1 } })
    );
    await new Promise((r) => setImmediate(r));
    transport.emitFrame(
      JSON.stringify({ jsonrpc: "2.0", id: lastRequestId(transport), result: { sessionId: "s" } })
    );
    await new Promise((r) => setImmediate(r));
    // Non-text chunk and a chunk without sessionUpdate should both
    // be ignored without throwing.
    transport.emitFrame(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          update: { sessionUpdate: "tool_call", content: { type: "text", text: "ignored" } },
        },
      })
    );
    transport.emitFrame(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          update: { sessionUpdate: "agent_message_chunk", content: { type: "image", text: "ignored" } },
        },
      })
    );
    transport.emitFrame(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "some/unrelated",
        params: { foo: 1 },
      })
    );
    transport.emitFrame(
      JSON.stringify({ jsonrpc: "2.0", id: lastRequestId(transport), result: { stopReason: "end_turn" } })
    );
    const result = await promise;
    expect(result.stdout).toBe("");
    expect(result.reason).toBe("exit");
  });

  it("truncates streamed text chunks at the configured byte cap", async () => {
    const transport = new MockAcpTransport();
    const client = new AcpClient({
      transport,
      cwd: "/tmp",
      maxStdoutBytes: 16,
    });
    const promise = client.run("PROMPT");
    transport.emitFrame(
      JSON.stringify({ jsonrpc: "2.0", id: lastRequestId(transport), result: { protocolVersion: 1 } })
    );
    await new Promise((r) => setImmediate(r));
    transport.emitFrame(
      JSON.stringify({ jsonrpc: "2.0", id: lastRequestId(transport), result: { sessionId: "s" } })
    );
    await new Promise((r) => setImmediate(r));
    // Send one big chunk; only the first 16 bytes survive plus the
    // truncation marker.
    transport.emitFrame(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "A".repeat(64),
            },
          },
        },
      })
    );
    transport.emitFrame(
      JSON.stringify({ jsonrpc: "2.0", id: lastRequestId(transport), result: { stopReason: "end_turn" } })
    );
    const result = await promise;
    expect(result.stdout.length).toBeGreaterThan(0);
    expect(result.stdout).toContain("[truncated]");
  });

  it("returns spawn_error when the prompt round-trip fails", async () => {
    const { transport, client } = setupAgent();
    const promise = client.run("PROMPT");
    transport.emitFrame(
      JSON.stringify({ jsonrpc: "2.0", id: lastRequestId(transport), result: { protocolVersion: 1 } })
    );
    await new Promise((r) => setImmediate(r));
    transport.emitFrame(
      JSON.stringify({ jsonrpc: "2.0", id: lastRequestId(transport), result: { sessionId: "s" } })
    );
    await new Promise((r) => setImmediate(r));
    transport.emitFrame(
      JSON.stringify({
        jsonrpc: "2.0",
        id: lastRequestId(transport),
        error: { code: -32603, message: "agent crashed" },
      })
    );
    const result = await promise;
    expect(result.reason).toBe("spawn_error");
    expect(result.stderr).toMatch(/agent crashed/);
  });
});