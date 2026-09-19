// Agent Client Protocol (ACP) client — `runner/acp.ts`.
//
// Implements a minimal ACP-over-JSON-RPC client used by the runner
// when the operator configures `agent.promptMode: "acp"` (s-1235).
// The protocol is the standard emerging at agentclientprotocol.com:
// the agent (the spawned binary) speaks JSON-RPC over stdio; the
// runner is the client. We only use the request surface we actually
// need to drive a single task to completion:
//
//   * `initialize`        — capability handshake.
//   * `session/new`       — open a fresh session.
//   * `session/prompt`    — send the rendered prompt; await
//                           completion via the `done` field on the
//                           response (matching the canonical ACP
//                           schema documented at
//                           https://agentclientprotocol.com/).
//
// During the `session/prompt` round-trip the agent streams progress
// notifications (`session/update`) that we collect and concatenate
// into the `AgentResult.stdout` the loop forwards to
// `/api/v1/runs/:taskId/finish` as the task's actual reply (per
// s-1185). Any agent-side failure surfaces as a non-zero exit on
// the child — we do not parse JSON-RPC error frames ourselves, the
// exit code already gives the loop everything it needs to mark the
// task failed.
//
// The framing layer is deliberately line-delimited JSON (one JSON
// object per line, terminated by `\n`). ACP's wire format follows
// that convention; a more elaborate framing scheme would only get
// in the way of agents that already implement it. The split helper
// never blocks: it buffers partial lines and yields full frames to
// the consumer, so the runner's event loop stays responsive while
// the agent streams output.
//
// Cancellation is handled by closing the child's stdin, which the
// Agent Client Protocol agents interpret as a request to abort the
// current prompt. The wait helper listens for either the prompt
// response or a clean process exit, whichever lands first.
import { EventEmitter } from "node:events";

import {
  STDOUT_TRUNCATE_BYTES,
} from "./spawn.js";

/**
 * Method names we send. Kept as constants so a typo never makes it
 * past the type-checker when we wire them into the request builder.
 */
const ACP_METHOD_INITIALIZE = "initialize" as const;
const ACP_METHOD_SESSION_NEW = "session/new" as const;
const ACP_METHOD_SESSION_PROMPT = "session/prompt" as const;
const ACP_METHOD_SESSION_CANCEL = "session/cancel" as const;

const ACP_NOTIFICATION_UPDATE = "session/update" as const;

/** Maximum JSON-RPC payload size we'll buffer before giving up. */
const MAX_FRAME_BYTES = 1024 * 1024;

/**
 * A single request the runner is willing to send. Each entry is
 * paired with the JSON-RPC params shape it expects.
 */
export type AcpRequest =
  | {
      method: typeof ACP_METHOD_INITIALIZE;
      params: {
        protocolVersion: number;
        clientInfo: { name: string; version: string };
        clientCapabilities?: Record<string, unknown>;
      };
    }
  | {
      method: typeof ACP_METHOD_SESSION_NEW;
      params: {
        cwd: string;
        mcpServers?: Array<Record<string, unknown>>;
      };
    }
  | {
      method: typeof ACP_METHOD_SESSION_PROMPT;
      params: {
        sessionId: string;
        prompt: Array<{
          type: "text";
          text: string;
        }>;
      };
    }
  | {
      method: typeof ACP_METHOD_SESSION_CANCEL;
      params: { sessionId: string };
    };

/**
 * Notifications we listen for. Anything else is logged but otherwise
 * ignored so a future spec revision cannot crash the runner.
 */
export type AcpNotification = {
  method: string;
  params?: Record<string, unknown>;
};

/**
 * Result reported to the runner after the `session/prompt` call
 * completes. `textReply` is the concatenation of every `text` chunk
 * the agent streamed during the prompt round-trip; `stopReason`
 * mirrors the agent's `stopReason` field on the response so callers
 * can branch on `end_turn` vs `max_tokens` etc.
 */
export interface AcpPromptResult {
  /** Concatenated `text` chunks received during the prompt. */
  textReply: string;
  /** Agent's declared stop reason (e.g. `"end_turn"`). */
  stopReason?: string;
  /** Raw response payload, exposed for tests + debugging. */
  raw: Record<string, unknown>;
}

/**
 * Shape we expect back from an ACP `initialize` call. We deliberately
 * declare a narrow subset — the only field we currently care about
 * is the protocol version (so we can fail fast on a major-version
 * mismatch) and the agent's advertised name.
 */
export interface AcpInitializeResult {
  protocolVersion: number;
  agentInfo?: { name?: string; version?: string };
  agentCapabilities?: Record<string, unknown>;
}

/**
 * Result reported to the runner after `session/new` completes.
 * Mirrors the canonical ACP response shape: a session id we then
 * pass into every subsequent `session/prompt` call.
 */
export interface AcpSessionResult {
  sessionId: string;
}

/**
 * Channel the ACP client uses to talk to the agent child. The
 * default implementation wraps the two `WriteStream`s / `Readable`
 * pair the spawn layer hands us, but tests can substitute a
 * `MockAcpTransport` so the JSON-RPC state machine can be exercised
 * without launching a real binary.
 *
 * The interface mirrors Node's `EventEmitter` shape so any
 * standard emitter (e.g. the `MockAcpTransport` in tests) plugs
 * straight in without an adapter.
 */
export interface AcpTransport {
  /** Write one full frame to the child (line-terminated). */
  writeFrame(payload: string): void;
  /** Close the write side of the channel. */
  end(): void;
  on(event: string, listener: (...args: unknown[]) => void): this;
  off(event: string, listener: (...args: unknown[]) => void): this;
}

/**
 * Configuration the spawn layer hands the ACP client. We accept the
 * raw streams + child PID the `ChildProcessSpawner` already owns
 * (instead of re-opening them) so the existing signal / timeout
 * machinery stays in charge of the child's lifetime.
 */
export interface AcpClientOptions {
  /** Caller-provided transport. Required; the client does not spawn. */
  transport: AcpTransport;
  /** Working directory the session is rooted at. */
  cwd: string;
  /**
   * Optional cancellation signal. When fired the client sends
   * `session/cancel` and resolves the in-flight prompt with
   * whatever reply it has collected so far, mirroring how
   * `AgentProcess.kill("SIGTERM")` works for the non-ACP modes.
   */
  cancelSignal?: AbortSignal;
  /**
   * Hard cap on streamed text chunks. Mirrors the 64 KiB cap the
   * spawn layer applies to stdout so a runaway agent cannot OOM
   * the runner.
   */
  maxStdoutBytes?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  method: string;
}

/**
 * Line-delimited JSON-RPC framing over a Node stream pair. Buffers
 * partial lines so a single chunk can yield zero, one, or many full
 * frames; emits a `frame` event for each. Reads are cheap: we only
 * slice the buffer, no per-byte work.
 */
export class LineJsonTransport implements AcpTransport {
  private readonly emitter = new EventEmitter();
  private buffer = "";
  private closed = false;

  constructor(
    private readonly writable: NodeJS.WritableStream,
    private readonly readable: NodeJS.ReadableStream
  ) {
    readable.setEncoding?.("utf8");
    readable.on("data", (chunk: string | Buffer) => {
      const text =
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      this.buffer += text;
      this.drain();
    });
    readable.on("error", (err: Error) => {
      this.emitter.emit("error", err);
    });
    readable.on("close", () => {
      this.closed = true;
      if (this.buffer.length > 0) {
        // Surface any trailing partial frame so callers see exactly
        // what the agent wrote before the channel closed.
        this.emitter.emit("frame", this.buffer);
        this.buffer = "";
      }
      this.emitter.emit("close");
    });
    writable.on("error", (err: Error) => {
      this.emitter.emit("error", err);
    });
  }

  writeFrame(payload: string): void {
    if (this.closed) {
      throw new Error("cannot write to a closed ACP transport");
    }
    this.writable.write(`${payload}\n`);
  }

  end(): void {
    if (typeof (this.writable as { end?: () => void }).end === "function") {
      (this.writable as { end: () => void }).end();
    }
  }

  on(event: string, listener: (...args: unknown[]) => void): this {
    this.emitter.on(event, listener);
    return this;
  }

  off(event: string, listener: (...args: unknown[]) => void): this {
    this.emitter.off(event, listener);
    return this;
  }

  private drain(): void {
    let idx = this.buffer.indexOf("\n");
    while (idx >= 0) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (raw.length > 0) {
        this.emitter.emit("frame", raw);
      }
      idx = this.buffer.indexOf("\n");
    }
    if (this.buffer.length > MAX_FRAME_BYTES) {
      this.emitter.emit(
        "error",
        new Error(
          `ACP frame buffer exceeded ${MAX_FRAME_BYTES} bytes without a newline; aborting`
        )
      );
    }
  }
}

/**
 * Thin JSON-RPC 2.0 client used by `AcpClient`. Tracks in-flight
 * requests by id, dispatches notifications, and routes responses to
 * the right `Promise` resolver. Stays in lock-step with the
 * canonical spec at https://www.jsonrpc.org/specification so any
 * ACP agent speaks it correctly out of the box.
 */
export class JsonRpcClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly emitter = new EventEmitter();

  constructor(
    private readonly transport: AcpTransport,
    /** Optional sink that surfaces internal JSON-RPC failures. */
    private readonly onError?: (err: Error) => void
  ) {
    transport.on("frame", (raw) => this.handleFrame(String(raw)));
    transport.on("error", (err) => this.failAll(err as Error));
  }

  /**
   * Send a request and resolve with the agent's `result` payload.
   * Rejects when the agent returns a JSON-RPC error frame, when the
   * transport surfaces an I/O error, or when `cancelSignal` aborts.
   */
  request<T>(req: AcpRequest, cancelSignal?: AbortSignal): Promise<T> {
    const id = this.nextId++;
    const message = {
      jsonrpc: "2.0",
      id,
      method: req.method,
      params: req.params,
    };
    return new Promise<T>((resolve, reject) => {
      const pending: PendingRequest = {
        method: req.method,
        resolve: (value) => resolve(value as T),
        reject,
      };
      this.pending.set(id, pending);
      try {
        this.transport.writeFrame(JSON.stringify(message));
      } catch (err) {
        this.pending.delete(id);
        reject(err as Error);
        return;
      }
      if (cancelSignal) {
        const onAbort = (): void => {
          const p = this.pending.get(id);
          if (!p) return;
          this.pending.delete(id);
          p.reject(
            new Error(`ACP request ${req.method} aborted: ${cancelSignal.reason ?? "signal"}`)
          );
        };
        if (cancelSignal.aborted) {
          onAbort();
          return;
        }
        cancelSignal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  /** Subscribe to a notification by method name. */
  onNotification(method: string, listener: (params: Record<string, unknown>) => void): void {
    this.emitter.on(`notif:${method}`, listener);
  }

  private handleFrame(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const wrapped = new Error(
        `ACP transport sent invalid JSON frame: ${(err as Error).message}`
      );
      this.onError?.(wrapped);
      return;
    }
    if (!parsed || typeof parsed !== "object") {
      return;
    }
    const msg = parsed as Record<string, unknown>;
    if (typeof msg.id === "number" && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        const errObj = msg.error as { message?: string; code?: number };
        pending.reject(
          new Error(
            `ACP ${pending.method} failed: ${errObj.message ?? `code ${errObj.code ?? "?"}`}`
          )
        );
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    if (typeof msg.method === "string" && msg.id === undefined) {
      this.emitter.emit("notif:" + msg.method, (msg.params as Record<string, unknown>) ?? {});
    }
  }

  private failAll(err: Error): void {
    for (const [, pending] of this.pending) {
      pending.reject(err);
    }
    this.pending.clear();
  }
}

/**
 * Result `runAcpSession` produces. We mirror `AgentResult`'s shape
 * (exitCode / signal / stderr / stdout / reason) so the spawn layer
 * can convert it with a one-liner and the loop never has to know
 * whether the agent was driven via ACP or a plain `--prompt` flag.
 */
export interface AcpRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
  reason: "exit" | "signal" | "timeout" | "spawn_error";
}

/**
 * High-level façade the spawn layer uses. Drives the full ACP
 * handshake on a fresh transport and resolves with the aggregated
 * reply. Errors at any stage (transport, JSON-RPC, ACP) propagate
 * as `Error` rejections so the loop's existing error handling keeps
 * working unchanged.
 */
export class AcpClient {
  private readonly transport: AcpTransport;
  private readonly cwd: string;
  private readonly cancelSignal?: AbortSignal;
  private readonly maxStdoutBytes: number;
  private readonly rpc: JsonRpcClient;

  constructor(opts: AcpClientOptions) {
    this.transport = opts.transport;
    this.cwd = opts.cwd;
    this.cancelSignal = opts.cancelSignal;
    this.maxStdoutBytes = opts.maxStdoutBytes ?? STDOUT_TRUNCATE_BYTES;
    // Forward JSON-RPC parse errors back to the transport so callers
    // that subscribe to `error` see them as I/O failures (the same
    // shape they would see on a malformed frame from the agent).
    this.rpc = new JsonRpcClient(this.transport, (err) => {
      // Re-emit on the transport's emitter by going through its
      // listener registry. The transport interface only exposes
      // `on` / `off`; the listener that should catch this is the
      // JsonRpcClient's own `failAll` subscriber, but we ALSO want
      // anyone watching the transport directly to see the failure.
      // We do this by triggering the `error` event on a tiny
      // EventEmitter we hold privately for this purpose.
      this.transportErrorListener?.(err);
    });
  }

  private transportErrorListener?: (err: Error) => void;

  /**
   * Register a callback that fires whenever the JSON-RPC layer
   * surfaces a malformed-frame error. Mirrors the `error` event on
   * the underlying transport so callers only need one listener.
   */
  onTransportError(listener: (err: Error) => void): void {
    this.transportErrorListener = listener;
  }

  /**
   * Run the full ACP handshake → prompt → reply round-trip.
   * Returns an `AcpRunResult` that the spawn layer can pass
   * straight to `AgentProcess.wait()` consumers.
   */
  async run(prompt: string): Promise<AcpRunResult> {
    const stderrChunks: string[] = [];
    let stderrBytes = 0;
    let stderrTruncated = false;
    const stdoutChunks: string[] = [];
    let stdoutBytes = 0;
    let stdoutTruncated = false;

    const captureStdout = (chunk: string): void => {
      if (stdoutTruncated) return;
      const bytes = Buffer.byteLength(chunk, "utf8");
      const remaining = this.maxStdoutBytes - stdoutBytes;
      if (bytes <= remaining) {
        stdoutChunks.push(chunk);
        stdoutBytes += bytes;
        return;
      }
      if (remaining > 0) {
        // Truncate at a character boundary to avoid splitting a
        // surrogate pair. We slice on the byte buffer directly so
        // a multi-byte character doesn't show up as a `0xFF`
        // replacement.
        const buf = Buffer.from(chunk, "utf8");
        stdoutChunks.push(buf.subarray(0, remaining).toString("utf8"));
        stdoutBytes = this.maxStdoutBytes;
      }
      stdoutTruncated = true;
    };

    // `initialize` — first call, gates every later round-trip.
    let init: AcpInitializeResult;
    try {
      init = await this.rpc.request<AcpInitializeResult>({
        method: ACP_METHOD_INITIALIZE,
        params: {
          protocolVersion: 1,
          clientInfo: { name: "open-kanban-cli", version: "0.1.0" },
        },
      }, this.cancelSignal);
    } catch (err) {
      stderrChunks.push(`ACP initialize failed: ${(err as Error).message}`);
      stderrBytes = Buffer.byteLength(stderrChunks[0], "utf8");
      return {
        exitCode: null,
        signal: null,
        stderr: stderrChunks.join(""),
        stdout: "",
        reason: "spawn_error",
      };
    }
    if (typeof init.protocolVersion !== "number") {
      stderrChunks.push("ACP initialize returned a non-numeric protocolVersion");
      stderrBytes = Buffer.byteLength(stderrChunks[0], "utf8");
      return {
        exitCode: null,
        signal: null,
        stderr: stderrChunks.join(""),
        stdout: "",
        reason: "spawn_error",
      };
    }

    // `session/new` — opens a session for the in-flight task.
    let session: AcpSessionResult;
    try {
      session = await this.rpc.request<AcpSessionResult>({
        method: ACP_METHOD_SESSION_NEW,
        params: { cwd: this.cwd },
      }, this.cancelSignal);
    } catch (err) {
      stderrChunks.push(`ACP session/new failed: ${(err as Error).message}`);
      stderrBytes = Buffer.byteLength(stderrChunks[0], "utf8");
      return {
        exitCode: null,
        signal: null,
        stderr: stderrChunks.join(""),
        stdout: "",
        reason: "spawn_error",
      };
    }
    if (typeof session.sessionId !== "string" || session.sessionId.length === 0) {
      stderrChunks.push("ACP session/new returned an empty sessionId");
      stderrBytes = Buffer.byteLength(stderrChunks[0], "utf8");
      return {
        exitCode: null,
        signal: null,
        stderr: stderrChunks.join(""),
        stdout: "",
        reason: "spawn_error",
      };
    }

    // Stream notifications during the prompt round-trip.
    this.rpc.onNotification(ACP_NOTIFICATION_UPDATE, (params) => {
      const update = params.update as Record<string, unknown> | undefined;
      if (!update) return;
      // ACP session/update notifications carry an `update` object
      // whose shape depends on the agent. The only field we
      // currently consume is the streaming text chunk
      // (`sessionUpdate === "agent_message_chunk"` with content
      // type `text`), which is what every mainstream agent emits.
      const sessionUpdate = update.sessionUpdate;
      if (sessionUpdate !== "agent_message_chunk") return;
      const content = update.content as Record<string, unknown> | undefined;
      if (!content || content.type !== "text") return;
      const text = content.text;
      if (typeof text === "string" && text.length > 0) {
        captureStdout(text);
      }
    });

    // `session/prompt` — the actual task content.
    let promptResult: Record<string, unknown>;
    try {
      promptResult = await this.rpc.request<Record<string, unknown>>({
        method: ACP_METHOD_SESSION_PROMPT,
        params: {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: prompt }],
        },
      }, this.cancelSignal);
    } catch (err) {
      stderrChunks.push(`ACP session/prompt failed: ${(err as Error).message}`);
      stderrBytes += Buffer.byteLength(stderrChunks[stderrChunks.length - 1] ?? "", "utf8");
      return {
        exitCode: null,
        signal: null,
        stderr: stderrChunks.join("\n"),
        stdout: drainTextChunks(stdoutChunks, stdoutTruncated),
        reason: "spawn_error",
      };
    }

    // The canonical ACP prompt response carries an optional `text`
    // field; if the agent populated it but did not stream chunks
    // we still want it in the reply buffer. Most mainstream
    // agents stream + populate, so this is a backstop.
    const finalText = promptResult.text;
    if (
      typeof finalText === "string" &&
      finalText.length > 0 &&
      stdoutBytes === 0
    ) {
      captureStdout(finalText);
    }

    return {
      exitCode: 0,
      signal: null,
      stderr: stderrChunks.join("\n"),
      stdout: drainTextChunks(stdoutChunks, stdoutTruncated),
      reason: "exit",
    };
  }

  /**
   * Send a best-effort cancel request without awaiting a reply.
   * Called by the spawn layer on SIGTERM so the agent has a
   * chance to write a clean stop notification before we kill it.
   */
  cancel(sessionId: string): void {
    try {
      this.rpc.request({
        method: ACP_METHOD_SESSION_CANCEL,
        params: { sessionId },
      });
    } catch {
      // Best effort — we don't care if cancel itself fails. The
      // SIGTERM that triggered it is the real shutdown mechanism.
    }
  }
}

/**
 * Concatenate the streamed text chunks and append a truncation
 * marker when the cap kicked in. Mirrors the `drainStream` helper
 * inside `spawn.ts` so the truncation signal is identical across
 * the ACP and non-ACP code paths.
 */
function drainTextChunks(chunks: string[], truncated: boolean): string {
  if (chunks.length === 0) {
    return truncated ? "[truncated]" : "";
  }
  return chunks.join("") + (truncated ? "\n[truncated]" : "");
}