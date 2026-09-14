// Tests for `kanban run [--config FILE] [--board/--status | --mine] [--once]`.
//
// The command is exercised end-to-end via `runRunCommand` with a stub
// `buildLoop` so we don't have to spawn real agents. The flag-parsing
// and config-loading paths get focused unit tests of their own, since
// they fail fast and must reject bad inputs before the loop starts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildHttpHydrator,
  buildCommentPoster,
  defaultBuildLoop,
  defaultRunnerId,
  InvalidUsageError,
  oauthLoggedInPredicate,
  parseRunFlags,
  resolveAgentType,
  resolveRunnerConfig,
  runRunCommand,
  stderrLoopLogger,
} from "../../src/commands/run.js";
import { RunnerConfigError } from "../../src/runner/config.js";
import { RunLoop } from "../../src/runner/loop.js";
import type { RunnerConfig } from "../../src/runner/types.js";
import type { OAuthMetadata } from "../../src/auth/types.js";
import { HttpClient } from "../../src/http/client.js";
import { InMemorySecretProvider, OAuthClient } from "../../src/auth/client.js";

interface ScriptedResponse {
  status: number;
  body?: unknown;
}

function scriptFetch(responses: ScriptedResponse[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  let i = 0;
  const spy = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return new Response(
      r.body === undefined ? "" : JSON.stringify(r.body),
      { status: r.status, headers: { "Content-Type": "application/json" } }
    );
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(spy);
  return { calls, spy };
}

const metadata: OAuthMetadata = {
  issuer: "http://kanban.example.com",
  authorization_endpoint: "http://kanban.example.com/oauth/authorize",
  token_endpoint: "http://kanban.example.com/oauth/token",
  jwks_uri: "http://kanban.example.com/.well-known/jwks.json",
  registration_endpoint: "http://kanban.example.com/oauth/register",
  device_authorization_endpoint: "http://kanban.example.com/oauth/device",
  grant_types_supported: [
    "urn:ietf:params:oauth:grant-type:device_code",
    "refresh_token",
  ],
  response_types_supported: ["code"],
  token_endpoint_auth_methods_supported: ["none"],
};

function makeAuthedClient(apiUrl = "http://kanban.example.com"): {
  http: HttpClient;
  oauth: OAuthClient;
} {
  const provider = new InMemorySecretProvider();
  provider.write({
    apiUrl,
    clientId: "cid",
    accessToken: "at-fresh",
    refreshToken: "rt",
    accessExpiresAt: Date.now() + 60_000,
  });
  const oauth = new OAuthClient(apiUrl, metadata, provider);
  const http = new HttpClient({ apiUrl });
  http.attachOAuth(oauth);
  return { http, oauth };
}

const tempDirs: string[] = [];
function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  }
  delete process.env.KANBAN_RUNNER_AGENT_TYPE;
  vi.restoreAllMocks();
});

beforeEach(() => {
  delete process.env.KANBAN_RUNNER_AGENT_TYPE;
});

describe("parseRunFlags", () => {
  it("accepts mode-1 with both --board and --status", () => {
    const p = parseRunFlags({ board: "sys", status: "todo" });
    expect(p.boardId).toBe("sys");
    expect(p.status).toBe("todo");
    expect(p.mine).toBe(false);
    expect(p.once).toBe(false);
  });

  it("accepts mode-2 with --mine alone", () => {
    const p = parseRunFlags({ mine: true });
    expect(p.mine).toBe(true);
    expect(p.boardId).toBeUndefined();
    expect(p.status).toBeUndefined();
  });

  it("rejects --mine combined with --board", () => {
    expect(() => parseRunFlags({ mine: true, board: "sys" })).toThrowError(
      InvalidUsageError
    );
  });

  it("rejects --mine combined with --status", () => {
    expect(() => parseRunFlags({ mine: true, status: "todo" })).toThrowError(
      InvalidUsageError
    );
  });

  it("rejects --board without --status", () => {
    expect(() => parseRunFlags({ board: "sys" })).toThrowError(
      InvalidUsageError
    );
  });

  it("rejects --status without --board", () => {
    expect(() => parseRunFlags({ status: "todo" })).toThrowError(
      InvalidUsageError
    );
  });

  it("rejects an invalid --status value", () => {
    expect(() =>
      parseRunFlags({ board: "sys", status: "in-progress" })
    ).toThrowError(/invalid --status/);
  });

  it("trims whitespace from --board / --status / --config", () => {
    const p = parseRunFlags({
      board: "  sys  ",
      status: "\ttodo\n",
      config: " /tmp/cfg.yaml ",
    });
    expect(p.boardId).toBe("sys");
    expect(p.status).toBe("todo");
    expect(p.configPath).toBe("/tmp/cfg.yaml");
  });

  it("treats whitespace-only values as omitted", () => {
    const p = parseRunFlags({ board: "   ", status: "" });
    expect(p.boardId).toBeUndefined();
    expect(p.status).toBeUndefined();
  });

  it("passes through --once verbatim", () => {
    expect(parseRunFlags({ mine: true, once: true }).once).toBe(true);
    expect(parseRunFlags({ board: "sys", status: "todo", once: true }).once).toBe(
      true
    );
    expect(parseRunFlags({ mine: true }).once).toBe(false);
  });
});

describe("resolveRunnerConfig", () => {
  it("reads the file at --config when supplied", () => {
    const dir = freshDir("kanban-runner-cfg-");
    const path = join(dir, "custom.yaml");
    writeFileSync(
      path,
      [
        "version: 1",
        "boardId: from-config",
        "status: in_progress",
        "agent:",
        "  bin: opencode",
        "  cwd: .",
        "runner:",
        "  pollIntervalMs: 1234",
        "",
      ].join("\n"),
      "utf8"
    );
    const cfg = resolveRunnerConfig(
      dir,
      parseRunFlags({
        config: path,
        board: "override",
        status: "todo",
      })
    );
    expect(cfg.boardId).toBe("override");
    expect(cfg.status).toBe("todo");
    expect(cfg.runner.pollIntervalMs).toBe(1234);
  });

  it("overrides the on-disk boardId when --board / --status are given", () => {
    const dir = freshDir("kanban-runner-override-");
    writeFileSync(
      join(dir, ".kanban-runner.yaml"),
      [
        "version: 1",
        "boardId: file",
        "status: todo",
        "agent:",
        "  bin: opencode",
        "runner: {}",
        "",
      ].join("\n"),
      "utf8"
    );
    const cfg = resolveRunnerConfig(
      dir,
      parseRunFlags({ board: "cli", status: "review" })
    );
    expect(cfg.boardId).toBe("cli");
    expect(cfg.status).toBe("review");
  });

  it("forces mode=mine and clears boardId/status when --mine is passed", () => {
    const dir = freshDir("kanban-runner-mine-");
    writeFileSync(
      join(dir, ".kanban-runner.yaml"),
      [
        "version: 1",
        "boardId: file",
        "status: todo",
        "agent:",
        "  bin: opencode",
        "runner: {}",
        "",
      ].join("\n"),
      "utf8"
    );
    const cfg = resolveRunnerConfig(dir, parseRunFlags({ mine: true }));
    expect(cfg.mode).toBe("mine");
    expect(cfg.boardId).toBeUndefined();
    expect(cfg.status).toBeUndefined();
  });

  it("throws when the --config file is missing", () => {
    expect(() =>
      resolveRunnerConfig(
        freshDir("kanban-runner-missing-"),
        parseRunFlags({
          config: "/tmp/does-not-exist-kanban-runner.yaml",
          board: "sys",
          status: "todo",
        })
      )
    ).toThrowError(RunnerConfigError);
  });

  it("throws on malformed YAML in the --config file", () => {
    const dir = freshDir("kanban-runner-bad-");
    const path = join(dir, "broken.yaml");
    writeFileSync(path, "version: 1\n  bad indent:\nfoo: :", "utf8");
    expect(() =>
      resolveRunnerConfig(
        dir,
        parseRunFlags({
          config: path,
          board: "sys",
          status: "todo",
        })
      )
    ).toThrowError(RunnerConfigError);
  });
});

describe("resolveAgentType", () => {
  it("defaults to opencode when the env var is unset", () => {
    delete process.env.KANBAN_RUNNER_AGENT_TYPE;
    expect(resolveAgentType()).toBe("opencode");
  });

  it("honours KANBAN_RUNNER_AGENT_TYPE", () => {
    process.env.KANBAN_RUNNER_AGENT_TYPE = "claude";
    expect(resolveAgentType()).toBe("claude");
  });
});

describe("defaultRunnerId", () => {
  it("returns a host-pid-uuid string", () => {
    const id = defaultRunnerId();
    expect(id).toMatch(/.+\-\d+\-.+/);
    expect(id.length).toBeGreaterThan(8);
  });

  it("produces a unique id per invocation", () => {
    const a = defaultRunnerId();
    const b = defaultRunnerId();
    expect(a).not.toBe(b);
  });
});

describe("oauthLoggedInPredicate", () => {
  it("returns false when there is no OAuth client", () => {
    const check = oauthLoggedInPredicate(null);
    expect(check(undefined)).toBe(false);
  });

  it("returns true when the client has a stored access token", () => {
    const { oauth } = makeAuthedClient();
    const check = oauthLoggedInPredicate(oauth);
    expect(check(undefined)).toBe(true);
    expect(check("work")).toBe(true);
  });

  it("returns false after logout (no credentials stored)", () => {
    const oauth = new OAuthClient(
      "http://kanban.example.com",
      metadata,
      new InMemorySecretProvider()
    );
    const check = oauthLoggedInPredicate(oauth);
    expect(check(undefined)).toBe(false);
  });
});

describe("runRunCommand", () => {
  it("rejects invalid flags before constructing the loop", async () => {
    const { http, oauth } = makeAuthedClient();
    const buildLoop = vi.fn();
    await expect(
      runRunCommand(
        { apiUrl: "http://kanban.example.com", mine: true, boardId: "sys" },
        { http, oauth, cwd: process.cwd(), buildLoop }
      )
    ).rejects.toBeInstanceOf(InvalidUsageError);
    expect(buildLoop).not.toHaveBeenCalled();
  });

  it("invokes buildLoop with the resolved config and runner id", async () => {
    const dir = freshDir("kanban-runner-buildloop-");
    const cfgPath = join(dir, "runner.yaml");
    writeFileSync(
      cfgPath,
      [
        "version: 1",
        "boardId: sys",
        "status: todo",
        "agent:",
        "  bin: opencode",
        "runner:",
        "  runnerId: explicit-runner",
        "  pollIntervalMs: 100",
        "  heartbeatIntervalMs: 200",
        "  lockTimeoutMs: 500",
        "",
      ].join("\n"),
      "utf8"
    );
    const { http, oauth } = makeAuthedClient();
    const fakeLoop = Object.create(RunLoop.prototype) as RunLoop;
    const run = vi.fn(async () => ({
      processed: 0,
      completed: 0,
      failed: 0,
      shutdown: true,
    }));
    (fakeLoop as unknown as { run: typeof run }).run = run;
    (fakeLoop as unknown as { tick: () => Promise<boolean> }).tick = async () => false;
    (fakeLoop as unknown as { requestShutdown: () => void }).requestShutdown = () => undefined;
    const buildLoop = vi.fn(async () => fakeLoop);
    const result = await runRunCommand(
      { apiUrl: "http://kanban.example.com", configPath: cfgPath, once: true },
      { http, oauth, cwd: dir, buildLoop }
    );
    expect(buildLoop).toHaveBeenCalledOnce();
    const call = buildLoop.mock.calls[0][0];
    expect(call.runnerId).toBe("explicit-runner");
    expect(call.config.boardId).toBe("sys");
    expect(call.config.status).toBe("todo");
    expect(call.agentType).toBe("opencode");
    expect(result.summary.shutdown).toBe(true);
    expect(run).toHaveBeenCalled();
  });

  it("generates a runnerId when the config does not supply one", async () => {
    const dir = freshDir("kanban-runner-noid-");
    const cfgPath = join(dir, "runner.yaml");
    writeFileSync(
      cfgPath,
      [
        "version: 1",
        "boardId: sys",
        "status: todo",
        "agent:",
        "  bin: opencode",
        "runner:",
        "  pollIntervalMs: 100",
        "  heartbeatIntervalMs: 200",
        "  lockTimeoutMs: 500",
        "",
      ].join("\n"),
      "utf8"
    );
    const { http, oauth } = makeAuthedClient();
    const fakeLoop = Object.create(RunLoop.prototype) as RunLoop;
    (fakeLoop as unknown as { run: () => Promise<unknown> }).run = async () => ({
      processed: 0,
      completed: 0,
      failed: 0,
      shutdown: true,
    });
    (fakeLoop as unknown as { tick: () => Promise<boolean> }).tick = async () => false;
    (fakeLoop as unknown as { requestShutdown: () => void }).requestShutdown = () => undefined;
    const buildLoop = vi.fn(async () => fakeLoop);
    const result = await runRunCommand(
      { apiUrl: "http://kanban.example.com", configPath: cfgPath, once: true },
      { http, oauth, cwd: dir, buildLoop }
    );
    expect(result.runnerId).toMatch(/.+\-\d+\-.+/);
    expect(result.runnerId.length).toBeGreaterThan(8);
  });

  it("surfaces RunnerConfigError as InvalidUsageError", async () => {
    const { http, oauth } = makeAuthedClient();
    // No boardId / status / mine → validator should reject.
    await expect(
      runRunCommand(
        { apiUrl: "http://kanban.example.com" },
        { http, oauth, cwd: process.cwd() }
      )
    ).rejects.toBeInstanceOf(InvalidUsageError);
  });

  it("rejects --mine when the profile is not logged in", async () => {
    const dir = freshDir("kanban-runner-mine-noauth-");
    const cfgPath = join(dir, "runner.yaml");
    writeFileSync(
      cfgPath,
      [
        "version: 1",
        "mode: mine",
        "agent:",
        "  bin: opencode",
        "runner:",
        "  pollIntervalMs: 100",
        "  heartbeatIntervalMs: 200",
        "  lockTimeoutMs: 500",
        "",
      ].join("\n"),
      "utf8"
    );
    const http = new HttpClient({ apiUrl: "http://kanban.example.com" });
    // No OAuth client attached → not logged in.
    const buildLoop = vi.fn();
    await expect(
      runRunCommand(
        { apiUrl: "http://kanban.example.com", configPath: cfgPath, once: true },
        { http, oauth: null, cwd: dir, buildLoop }
      )
    ).rejects.toBeInstanceOf(InvalidUsageError);
    expect(buildLoop).not.toHaveBeenCalled();
  });

  it("drives the loop to shutdown via the abort signal", async () => {
    const dir = freshDir("kanban-runner-abort-");
    const cfgPath = join(dir, "runner.yaml");
    writeFileSync(
      cfgPath,
      [
        "version: 1",
        "boardId: sys",
        "status: todo",
        "agent:",
        "  bin: opencode",
        "runner:",
        "  pollIntervalMs: 1",
        "  heartbeatIntervalMs: 1",
        "  lockTimeoutMs: 5",
        "",
      ].join("\n"),
      "utf8"
    );
    const { http, oauth } = makeAuthedClient();
    const fakeLoop = Object.create(RunLoop.prototype) as RunLoop;
    let signal: AbortSignal | undefined;
    const settled = { processed: 0, completed: 0, failed: 0, shutdown: true };
    (fakeLoop as unknown as { run: () => Promise<unknown> }).run = async () => {
      // Already aborted? Return immediately so the test doesn't deadlock.
      if (signal?.aborted) return settled;
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return settled;
    };
    (fakeLoop as unknown as { tick: () => Promise<boolean> }).tick = async () => {
      return !signal?.aborted;
    };
    (fakeLoop as unknown as { requestShutdown: () => void }).requestShutdown = () => undefined;
    const abortController = new AbortController();
    // Pre-abort so loop.run() returns immediately without blocking.
    abortController.abort();
    const buildLoop = vi.fn(async (deps: { signal?: AbortSignal }) => {
      signal = deps.signal;
      return fakeLoop;
    });
    const result = await runRunCommand(
      {
        apiUrl: "http://kanban.example.com",
        configPath: cfgPath,
        abortController,
      },
      { http, oauth, cwd: dir, buildLoop }
    );
    expect(result.summary.shutdown).toBe(true);
    expect(signal?.aborted).toBe(true);
  });

  it("--once returns a summary after at most one processed task", async () => {
    const dir = freshDir("kanban-runner-once-");
    const cfgPath = join(dir, "runner.yaml");
    writeFileSync(
      cfgPath,
      [
        "version: 1",
        "boardId: sys",
        "status: todo",
        "agent:",
        "  bin: opencode",
        "runner:",
        "  pollIntervalMs: 1",
        "  heartbeatIntervalMs: 1",
        "  lockTimeoutMs: 5",
        "",
      ].join("\n"),
      "utf8"
    );
    const { http, oauth } = makeAuthedClient();
    const fakeLoop = Object.create(RunLoop.prototype) as RunLoop;
    const tickCalls = vi.fn(async () => false);
    (fakeLoop as unknown as { tick: () => Promise<boolean> }).tick = tickCalls;
    (fakeLoop as unknown as { requestShutdown: () => void }).requestShutdown = () => undefined;
    (fakeLoop as unknown as { run: () => Promise<unknown> }).run = async () => ({
      processed: 0,
      completed: 0,
      failed: 0,
      shutdown: true,
    });
    const buildLoop = vi.fn(async () => fakeLoop);
    await runRunCommand(
      { apiUrl: "http://kanban.example.com", configPath: cfgPath, once: true },
      { http, oauth, cwd: dir, buildLoop }
    );
    // --once should request shutdown before calling run() so the loop
    // does not poll indefinitely.
    expect(tickCalls).toHaveBeenCalled();
  });
});

describe("buildHttpHydrator / buildCommentPoster", () => {
  it("buildHttpHydrator returns empty arrays when endpoints fail", async () => {
    scriptFetch([
      { status: 500 },
      { status: 500 },
      { status: 500 },
      { status: 500 },
      { status: 500 },
    ]);
    const { http } = makeAuthedClient();
    const hydrator = buildHttpHydrator(http, { boardId: "sys" });
    const comments = await hydrator.fetchComments("t-1");
    const subtasks = await hydrator.fetchSubtasks("t-1");
    const task = await hydrator.fetchTask("t-1");
    const board = await hydrator.fetchBoard("sys");
    const column = await hydrator.fetchColumn("col-1");
    expect(comments).toEqual([]);
    expect(subtasks).toEqual([]);
    expect(task.id).toBe("t-1");
    expect(board.id).toBe("sys");
    expect(column.id).toBe("col-1");
  });

  it("buildHttpHydrator parses successful responses", async () => {
    scriptFetch([
      { status: 200, body: { comments: [{ author: "alice", content: "hi" }] } },
      { status: 200, body: { subtasks: [{ title: "do the thing" }] } },
      { status: 200, body: { id: "t-1", title: "ok" } },
      { status: 200, body: { id: "sys", name: "Sys", description: "demo" } },
      { status: 200, body: { id: "col-1", name: "Todo", status: "todo" } },
    ]);
    const { http } = makeAuthedClient();
    const hydrator = buildHttpHydrator(http, { boardId: "sys" });
    expect(await hydrator.fetchComments("t-1")).toEqual([
      { author: "alice", content: "hi" },
    ]);
    expect(await hydrator.fetchSubtasks("t-1")).toEqual([
      { title: "do the thing" },
    ]);
    expect(await hydrator.fetchTask("t-1")).toEqual({ id: "t-1", title: "ok" });
    expect(await hydrator.fetchBoard("sys")).toEqual({
      id: "sys",
      name: "Sys",
      description: "demo",
    });
    expect(await hydrator.fetchColumn("col-1")).toEqual({
      id: "col-1",
      name: "Todo",
      status: "todo",
      description: null,
    });
  });

  it("buildCommentPoster posts to /api/v1/comments with taskId + content", async () => {
    const { calls } = scriptFetch([{ status: 201, body: { id: "c-1" } }]);
    const { http } = makeAuthedClient();
    const poster = buildCommentPoster(http);
    await poster.postComment("t-1", "agent crashed");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/api/v1/comments");
    expect(calls[0].init?.method).toBe("POST");
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body).toEqual({ taskId: "t-1", content: "agent crashed" });
  });
});

describe("defaultBuildLoop", () => {
  it("constructs a RunLoop with all collaborators wired", () => {
    const { http } = makeAuthedClient();
    const cfg: RunnerConfig = {
      version: 1,
      boardId: "sys",
      status: "todo",
      agent: { bin: "opencode", cwd: ".", timeoutMs: 1000 },
      runner: { heartbeatIntervalMs: 1000, lockTimeoutMs: 5_000 },
    };
    const loop = defaultBuildLoop({
      config: cfg,
      runnerId: "r-1",
      agentType: "opencode",
      http,
    });
    expect(loop).toBeInstanceOf(RunLoop);
    expect(loop.state).toEqual({
      inFlight: null,
      processed: 0,
      completed: 0,
      failed: 0,
      shutdown: false,
    });
  });
});

describe("stderrLoopLogger — debug mode", () => {
  function makeCapture(): {
    stderr: { write: (chunk: string) => boolean };
    output: string[];
  } {
    const output: string[] = [];
    return {
      output,
      stderr: {
        write: (chunk: string): boolean => {
          output.push(chunk);
          return true;
        },
      },
    };
  }

  it("emits info / warn / error lines without a debug prefix", () => {
    const { stderr, output } = makeCapture();
    const logger = stderrLoopLogger({ stderr: stderr as unknown as NodeJS.WritableStream });
    logger.info("hello");
    logger.warn("careful");
    logger.error("boom");
    expect(output.join("")).toBe(
      "[kanban-runner] hello\n[kanban-runner] warn: careful\n[kanban-runner] error: boom\n"
    );
  });

  it("silences debug() when debug is false / unset", () => {
    const { stderr, output } = makeCapture();
    const logger = stderrLoopLogger({ stderr: stderr as unknown as NodeJS.WritableStream });
    logger.debug("should not appear");
    expect(output).toEqual([]);
  });

  it("emits debug lines when debug is true", () => {
    const { stderr, output } = makeCapture();
    const logger = stderrLoopLogger({
      debug: true,
      stderr: stderr as unknown as NodeJS.WritableStream,
    });
    logger.debug("trace: claim attempt");
    expect(output).toEqual(["[kanban-runner] debug: trace: claim attempt\n"]);
  });

  it("coexists: info / warn / error still flow when debug is enabled", () => {
    const { stderr, output } = makeCapture();
    const logger = stderrLoopLogger({
      debug: true,
      stderr: stderr as unknown as NodeJS.WritableStream,
    });
    logger.info("info");
    logger.debug("trace");
    logger.warn("warn");
    logger.error("err");
    expect(output.join("")).toBe(
      "[kanban-runner] info\n" +
        "[kanban-runner] debug: trace\n" +
        "[kanban-runner] warn: warn\n" +
        "[kanban-runner] error: err\n"
    );
  });
});

describe("parseRunFlags — --debug", () => {
  it("defaults to false when --debug is omitted", () => {
    const p = parseRunFlags({ board: "sys", status: "todo" });
    expect(p.debug).toBe(false);
  });

  it("returns true when --debug is set", () => {
    const p = parseRunFlags({ board: "sys", status: "todo", debug: true });
    expect(p.debug).toBe(true);
  });

  it("treats a truthy non-boolean as false", () => {
    // Commander passes `true | undefined`; anything else means the flag
    // was not provided.
    const p = parseRunFlags({ board: "sys", status: "todo", debug: "yes" as unknown as boolean });
    expect(p.debug).toBe(false);
  });
});

describe("runRunCommand — --debug plumbing", () => {
  it("forwards debug=true to buildLoop", async () => {
    const dir = freshDir("kanban-runner-debug-");
    const cfgPath = join(dir, "runner.yaml");
    writeFileSync(
      cfgPath,
      [
        "version: 1",
        "boardId: sys",
        "status: todo",
        "agent:",
        "  bin: opencode",
        "runner:",
        "  runnerId: debug-runner",
        "  pollIntervalMs: 100",
        "  heartbeatIntervalMs: 200",
        "  lockTimeoutMs: 500",
        "",
      ].join("\n"),
      "utf8"
    );
    const { http, oauth } = makeAuthedClient();
    const fakeLoop = Object.create(RunLoop.prototype) as RunLoop;
    (fakeLoop as unknown as { run: () => Promise<unknown> }).run = async () => ({
      processed: 0,
      completed: 0,
      failed: 0,
      shutdown: true,
    });
    (fakeLoop as unknown as { tick: () => Promise<boolean> }).tick = async () => false;
    (fakeLoop as unknown as { requestShutdown: () => void }).requestShutdown = () => undefined;
    const buildLoop = vi.fn(async () => fakeLoop);
    await runRunCommand(
      {
        apiUrl: "http://kanban.example.com",
        configPath: cfgPath,
        once: true,
        debug: true,
      },
      { http, oauth, cwd: dir, buildLoop }
    );
    expect(buildLoop).toHaveBeenCalledOnce();
    const call = buildLoop.mock.calls[0][0] as { debug?: boolean };
    expect(call.debug).toBe(true);
  });

  it("defaults debug to false on buildLoop when not supplied", async () => {
    const dir = freshDir("kanban-runner-nodebug-");
    const cfgPath = join(dir, "runner.yaml");
    writeFileSync(
      cfgPath,
      [
        "version: 1",
        "boardId: sys",
        "status: todo",
        "agent:",
        "  bin: opencode",
        "runner:",
        "  runnerId: nodebug-runner",
        "  pollIntervalMs: 100",
        "  heartbeatIntervalMs: 200",
        "  lockTimeoutMs: 500",
        "",
      ].join("\n"),
      "utf8"
    );
    const { http, oauth } = makeAuthedClient();
    const fakeLoop = Object.create(RunLoop.prototype) as RunLoop;
    (fakeLoop as unknown as { run: () => Promise<unknown> }).run = async () => ({
      processed: 0,
      completed: 0,
      failed: 0,
      shutdown: true,
    });
    (fakeLoop as unknown as { tick: () => Promise<boolean> }).tick = async () => false;
    (fakeLoop as unknown as { requestShutdown: () => void }).requestShutdown = () => undefined;
    const buildLoop = vi.fn(async () => fakeLoop);
    await runRunCommand(
      { apiUrl: "http://kanban.example.com", configPath: cfgPath, once: true },
      { http, oauth, cwd: dir, buildLoop }
    );
    const call = buildLoop.mock.calls[0][0] as { debug?: boolean };
    expect(call.debug).toBe(false);
  });
});
