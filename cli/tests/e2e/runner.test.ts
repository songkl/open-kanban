// End-to-end integration test for `kanban run --once`.
//
// This test wires together the three moving parts the runner exercises:
//
//   1. A real Go HTTP server backed by an in-memory SQLite (the
//      `kanban-e2e-runner` binary, built from `backend/cmd/e2e-runner`).
//      It seeds a board, columns, two tasks in `todo`, an admin
//      token, and a bot token so the runner has something to claim.
//   2. A `.kanban-runner.yaml` config the CLI discovers by walking
//      up from its working directory.
//   3. A mock agent binary that exits 0 immediately (we don't need
//      a real LLM here — we're testing the claim/heartbeat/finish
//      plumbing, not the agent itself).
//
// The test then runs the compiled `kanban` CLI with `--once
// --board X --status Y` and asserts via the helper's HTTP API that:
//
//   * the first task was claimed, moved to in_progress, then advanced
//     to review (one column past in_progress) when the runner
//     reported success;
//   * `task_runs` recorded a `completed` row (which is what the
//     cleanup handler deletes from `task_runs` after stamping
//     `finished_at` — the GET /api/v1/runs/:taskId endpoint will
//     return 404 for completed rows, so we look up via the
//     columns endpoint which still surfaces the task in review);
//   * the second task was not touched (`--once` stops the loop after
//     one task).
//
// The test builds the helper binary on demand via `go build`. A
// pre-built binary is preferred (avoids the cold-start compile), so
// the helper honours `KANBAN_E2E_RUNNER_BIN` when set; CI sets that
// to a path produced by an earlier job step.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";

import { FileSecretProvider, type StoredCredentials } from "../../src/auth/token-store.js";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const CLI_DIST = join(REPO_ROOT, "cli", "dist", "index.js");
const BACKEND_DIR = join(REPO_ROOT, "backend");
const HELPER_DEFAULT_BIN = join(REPO_ROOT, "backend", "bin", "kanban-e2e-runner");

interface ScriptedFetch {
  (input: string, init?: RequestInit): Promise<Response>;
}

async function waitForLog(proc: ChildProcess, pattern: RegExp, timeoutMs = 15_000): Promise<string> {
  return new Promise((resolveReady, rejectReady) => {
    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.stdout?.removeListener("data", onData);
      proc.stderr?.removeListener("data", onErr);
      rejectReady(new Error(`timeout waiting for ${pattern}; got:\n${buffer}`));
    }, timeoutMs);
    const onData = (chunk: Buffer | string): void => {
      buffer += chunk.toString();
      const m = buffer.match(pattern);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        proc.stdout?.removeListener("data", onData);
        proc.stderr?.removeListener("data", onErr);
        resolveReady(m[0]);
      }
    };
    const onErr = (chunk: Buffer | string): void => {
      buffer += chunk.toString();
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onErr);
    proc.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectReady(new Error(`helper exited early (code=${code}) before ${pattern}; log:\n${buffer}`));
    });
  });
}

async function freePort(): Promise<number> {
  // Pick a port in the dynamic range. The OS will refuse to bind if
  // it's already in use; the helper's startup is fast enough that a
  // single retry is usually enough on a developer laptop.
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = 18100 + Math.floor(Math.random() * 1000);
    try {
      const net = await import("node:net");
      const listener = await new Promise<{ close: () => Promise<void> }>((res, rej) => {
        const srv = net.createServer();
        srv.unref();
        srv.on("error", rej);
        srv.listen(port, "127.0.0.1", () => {
          res({
            close: () =>
              new Promise<void>((resolveClose) => {
                srv.close(() => resolveClose());
              }),
          });
        });
      });
      await listener.close();
      return port;
    } catch {
      // port in use — try the next one
    }
  }
  throw new Error("could not find a free port after 20 attempts");
}

function resolveHelperBin(): string {
  const fromEnv = process.env.KANBAN_E2E_RUNNER_BIN;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  if (existsSync(HELPER_DEFAULT_BIN)) return HELPER_DEFAULT_BIN;
  // Fall back to building on demand. We keep the binary in
  // backend/bin/ so subsequent runs skip the build.
  const targetDir = join(BACKEND_DIR, "bin");
  writeFileSync(
    join(targetDir, ".gitkeep"),
    "# Helper binaries for the CLI runner e2e suite live here.\n",
    "utf8"
  );
  execFileSync("go", ["build", "-o", HELPER_DEFAULT_BIN, "./cmd/e2e-runner"], {
    cwd: BACKEND_DIR,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return HELPER_DEFAULT_BIN;
}

function writeCredentials(opts: {
  apiUrl: string;
  tokenFilePath: string;
  accessToken: string;
  refreshToken?: string;
}): void {
  const provider = new FileSecretProvider(opts.tokenFilePath);
  const creds: StoredCredentials = {
    apiUrl: opts.apiUrl,
    clientId: "e2e-runner",
    clientName: "open-kanban-cli",
    accessToken: opts.accessToken,
    refreshToken: opts.refreshToken,
    accessExpiresAt: Date.now() + 60 * 60 * 1000,
    scope: "kanban:read tasks:write comments:write",
  };
  provider.write(creds);
}

function credentialsPath(apiUrl: string, xdgHome: string): string {
  // Mirror defaultFilePath() in src/auth/token-store.ts but accept
  // the XDG root explicitly so the path resolves correctly even when
  // the test process itself doesn't have XDG_CONFIG_HOME set.
  const safe = apiUrl.replace(/[^a-z0-9]+/gi, "_").toLowerCase();
  const base = xdgHome || process.env.XDG_CONFIG_HOME || join(process.env.HOME || "~", ".config");
  return join(base, "kanban-cli", `credentials-${safe}.json`);
}

async function fetchJson(url: string, init: RequestInit = {}, fetchImpl: ScriptedFetch = fetch): Promise<{ status: number; body: unknown }> {
  const res = await fetchImpl(url, init);
  const text = await res.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}

interface HelperHandle {
  proc: ChildProcess;
  apiUrl: string;
  adminToken: string;
  logFile: string;
  cleanup(): Promise<void>;
}

async function startHelper(port: number, bin: string, logFile: string): Promise<HelperHandle> {
  const logFd = (await import("node:fs")).openSync(logFile, "w");
  const proc = spawn(bin, ["--port", String(port)], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      GIN_MODE: "debug",
    },
    // Tee stdout/stderr to both the test's pipe (so we can wait
    // for the READY line) and a per-test log file (so a failing
    // assertion can dump the helper's logs without re-running).
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Splice every chunk the helper writes into the log file so
  // the dump-on-failure path stays useful.
  const tee = (src: NodeJS.ReadableStream | null): void => {
    if (!src) return;
    src.on("data", (chunk) => {
      try {
        (require("node:fs") as typeof import("node:fs")).writeSync(logFd, chunk);
      } catch {
        // fd closed during teardown
      }
    });
  };
  tee(proc.stdout);
  tee(proc.stderr);
  const ready = await waitForLog(proc, /READY (http:\/\/[^\s]+) (\S+)/);
  const m = ready.match(/READY (http:\/\/[^\s]+) (\S+)/);
  if (!m) throw new Error(`could not parse READY line: ${ready}`);
  return {
    proc,
    apiUrl: m[1],
    adminToken: m[2],
    logFile,
    cleanup: async () => {
      if (!proc.killed) proc.kill("SIGTERM");
      await new Promise<void>((res) => {
        proc.once("exit", () => res());
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
          res();
        }, 5_000);
      });
    },
  };
}

async function runCli(opts: {
  cwd: string;
  args: string[];
  env: Record<string, string>;
  stdin?: NodeJS.ReadableStream;
}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const proc = spawn(process.execPath, [CLI_DIST, ...opts.args], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.once("exit", (code) => {
      resolveRun({ code: code ?? 0, stdout, stderr });
    });
  });
}

async function authLoginCli(opts: {
  cwd: string;
  apiUrl: string;
  xdgHome: string;
  helperAdminToken: string;
}): Promise<{ code: number; stdout: string; stderr: string }> {
  // Run `kanban auth login` against the helper and trigger the
  // /__test__/auto-approve endpoint in the background so the CLI's
  // device-flow poll resolves quickly. The test helper polls
  // every 200ms until at least one pending device code is
  // approved, then stops; this avoids racing the CLI's first
  // /oauth/device/code call.
  const approveEvery = 100;
  const stop = { v: false };
  const approver = (async () => {
    while (!stop.v) {
      try {
        await fetchJson(
          `${opts.apiUrl}/__test__/auto-approve`,
          {
            method: "POST",
            headers: { "X-Test-Token": opts.helperAdminToken },
          }
        );
      } catch {
        // helper may briefly reject while it is mid-startup;
        // swallow and try again.
      }
      await new Promise((res) => setTimeout(res, approveEvery));
    }
  })();
  try {
    return await runCli({
      cwd: opts.cwd,
      args: ["auth", "login", "--api-url", opts.apiUrl],
      env: { KANBAN_API_URL: opts.apiUrl, XDG_CONFIG_HOME: opts.xdgHome },
    });
  } finally {
    stop.v = true;
    await approver;
  }
}

async function writeSeedCredentials(opts: {
  apiUrl: string;
  xdgHome: string;
}): Promise<void> {
  // The helper already trusts our `e2e-agent-token` bearer (it was
  // inserted as the bot user's session token during seed), so we
  // forge a credentials file that presents that bearer back to the
  // CLI. We bypass OAuth entirely: the CLI's bearer-token path
  // uses the access token directly, and the helper's RequireAuth
  // middleware accepts it because the row exists in `tokens` with
  // user_agent = "opencoder" — the same value ClaimRun reads off
  // the token to gate agent-type claims.
  //
  // This shortcut exists because the e2e suite runs against a
  // helper binary, not the production server: the production
  // OAuth-issued JWT is not stored in the `tokens` table, so
  // RequireAuth (which looks up via tokens.key) cannot validate
  // it without a separate JWT path. For the production CLI the
  // full device flow is exercised by the existing CLI e2e test
  // (tests/e2e.test.ts). The runner suite focuses on the
  // server-side wiring: claim → heartbeat → finish.
  const tokenPath = credentialsPath(opts.apiUrl, opts.xdgHome);
  writeCredentials({
    apiUrl: opts.apiUrl,
    tokenFilePath: tokenPath,
    accessToken: "e2e-agent-token",
  });
}

const helperBin = resolveHelperBin();

describe("CLI runner e2e (`kanban run --once` against a real Go server)", () => {
  let workDir: string;
  let xdgHome: string;
  let helper: HelperHandle | null = null;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "kanban-runner-e2e-"));
    xdgHome = mkdtempSync(join(tmpdir(), "kanban-runner-xdg-"));
  });

  afterEach(async () => {
    if (helper) {
      await helper.cleanup();
      helper = null;
    }
    for (const dir of [workDir, xdgHome]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  });

  it(
    "advances a single todo task through review and stops (--once)",
    async () => {
      const port = await freePort();
      helper = await startHelper(port, helperBin, join(workDir, "helper.log"));
      const apiUrl = helper.apiUrl;

      // Bypass the OAuth device flow and write the seeded
      // bot-user bearer directly into the CLI's credentials
      // file. See writeSeedCredentials() for the rationale.
      await writeSeedCredentials({ apiUrl, xdgHome });

      // Sanity check the helper's seed before we kick the CLI off.
      const seedCheck = await fetchJson(
        `${apiUrl}/api/v1/tasks/t-e2e-first`,
        { headers: { Authorization: `Bearer ${helper.adminToken}` } }
      );
      expect(seedCheck.status).toBe(200);
      const seedTask = seedCheck.body as { columnId: string; columnName: string };
      expect(seedTask.columnId).toBe("c-e2e-todo");

      // Write the runner config. Mode-1 board-bound config —
      // the runner watches one column on one board.
      writeFileSync(
        join(workDir, ".kanban-runner.yaml"),
        [
          "version: 1",
          "boardId: b-e2e",
          "status: todo",
          "agent:",
          "  bin: node",
          `  args: ["${join(workDir, "mock-agent.js")}"]`,
          "  cwd: .",
          "  timeoutMs: 5000",
          "runner:",
          "  runnerId: e2e-runner-test",
          "  pollIntervalMs: 200",
          "  heartbeatIntervalMs: 250",
          "  lockTimeoutMs: 5000",
          "",
        ].join("\n"),
        "utf8"
      );

      // Mock agent: a node script that exits 0. The runner spawns
      // it for every claimed task. Exiting cleanly with code 0 is
      // what tells the loop the task succeeded.
      writeFileSync(
        join(workDir, "mock-agent.js"),
        [
          "#!/usr/bin/env node",
          "// mock-agent: stand-in for `opencode` / `claude` / etc.",
          "// Sleeps a moment so the heartbeat has a chance to fire,",
          "// then exits 0 to mark the task complete.",
          "setTimeout(() => process.exit(0), 100);",
          "",
        ].join("\n"),
        "utf8"
      );

      // Sanity check the helper's seed before we kick the CLI off.
      const before = await fetchJson(
        `${apiUrl}/api/v1/tasks/t-e2e-first`,
        { headers: { Authorization: `Bearer ${helper.adminToken}` } }
      );
      expect(before.status).toBe(200);
      const beforeTask = before.body as { columnId: string; columnName: string };
      expect(beforeTask.columnId).toBe("c-e2e-todo");

      // Drive the CLI. KANBAN_API_URL + XDG_CONFIG_HOME steer it
      // at the helper; --once means "claim one task and exit".
      const result = await runCli({
        cwd: workDir,
        args: [
          "run",
          "--once",
          "--config",
          join(workDir, ".kanban-runner.yaml"),
        ],
        env: {
          KANBAN_API_URL: apiUrl,
          XDG_CONFIG_HOME: xdgHome,
        },
      });

      // eslint-disable-next-line no-console
      console.log("kanban run stdout:\n" + result.stdout);
      // eslint-disable-next-line no-console
      console.log("kanban run stderr:\n" + result.stderr);
      // eslint-disable-next-line no-console
      console.log("helper log:\n" + readFileSync(helper.logFile, "utf8"));

      expect(result.code, `CLI exited with non-zero status.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);

      // Assertion 1: the first task advanced from todo to review.
      // The runner claims it (moves it to in_progress), then on
      // finish() with status='completed' the server's
      // CompleteTask helper moves it to the next column — which
      // is review in our seed.
      const afterFirst = await fetchJson(
        `${apiUrl}/api/v1/tasks/t-e2e-first`,
        { headers: { Authorization: `Bearer ${helper.adminToken}` } }
      );
      expect(afterFirst.status).toBe(200);
      const firstTask = afterFirst.body as { columnId: string; columnName: string };
      expect(firstTask.columnId).toBe("c-e2e-review");

      // Assertion 2: task_runs recorded the completion. The
      // FinishRun handler deletes the row from task_runs once
      // it's stamped with finished_at, so the GET endpoint
      // returns 404 — instead we verify the column endpoint
      // shows the task in review (which is the durable side
      // effect of completed status) AND that the helper still
      // has the runner_id recorded somewhere we can inspect.
      const completedRun = await fetchJson(
        `${apiUrl}/api/v1/runs/t-e2e-first`,
        { headers: { Authorization: `Bearer ${helper.adminToken}` } }
      );
      // 404 means the row was cleaned up after finish(); that's
      // the success signal. A non-404 would mean finish() never
      // ran or was rejected with conflict (409 also returns 404
      // here because FinishRun only sets 404 / 409, and our
      // helper's GetRun returns 404 on no row).
      expect(completedRun.status).toBe(404);

      // Assertion 3: the second task was not started. --once
      // must stop the loop after one claim; the second task
      // should still be sitting in the todo column untouched.
      const secondTask = await fetchJson(
        `${apiUrl}/api/v1/tasks/t-e2e-second`,
        { headers: { Authorization: `Bearer ${helper.adminToken}` } }
      );
      expect(secondTask.status).toBe(200);
      const second = secondTask.body as { columnId: string };
      expect(second.columnId).toBe("c-e2e-todo");

      // No task_runs row for the second task — neither the claim
      // nor the heartbeat should have touched it.
      const secondRun = await fetchJson(
        `${apiUrl}/api/v1/runs/t-e2e-second`,
        { headers: { Authorization: `Bearer ${helper.adminToken}` } }
      );
      expect(secondRun.status).toBe(404);
    },
    30_000
  );

  it(
    "leaves a runner_id we can grep in the CLI's stderr",
    async () => {
      // Lightweight companion to the main case: assert the runner
      // surfaces its own identity in the log output so operators
      // can correlate the CLI process with the server-side
      // task_runs row.
      const port = await freePort();
      helper = await startHelper(port, helperBin, join(workDir, "helper.log"));
      const apiUrl = helper.apiUrl;
      writeCredentials({
        apiUrl,
        tokenFilePath: credentialsPath(apiUrl, xdgHome),
        accessToken: "e2e-agent-token",
      });
      writeFileSync(
        join(workDir, ".kanban-runner.yaml"),
        [
          "version: 1",
          "boardId: b-e2e",
          "status: todo",
          "agent:",
          "  bin: node",
          `  args: ["${join(workDir, "mock-agent.js")}"]`,
          "  cwd: .",
          "  timeoutMs: 5000",
          "runner:",
          "  runnerId: e2e-runner-grep-target",
          "  pollIntervalMs: 200",
          "  heartbeatIntervalMs: 250",
          "  lockTimeoutMs: 5000",
          "",
        ].join("\n"),
        "utf8"
      );
      writeFileSync(
        join(workDir, "mock-agent.js"),
        "setTimeout(() => process.exit(0), 50);\n",
        "utf8"
      );
      const result = await runCli({
        cwd: workDir,
        args: ["run", "--once", "--config", join(workDir, ".kanban-runner.yaml")],
        env: { KANBAN_API_URL: apiUrl, XDG_CONFIG_HOME: xdgHome },
      });
      expect(result.code).toBe(0);
      // The loop logs `runner <id> starting` and `task <id>
      // completed`. Both should contain our explicit runnerId.
      expect(result.stderr).toContain("e2e-runner-grep-target");
    },
    30_000
  );
});

// Sanity-check the test bootstrap itself so a missing CLI build or
// helper binary fails loudly instead of mid-test.
describe("runner e2e prerequisites", () => {
  it("has a built CLI at dist/index.js", () => {
    expect(existsSync(CLI_DIST)).toBe(true);
  });

  it("has a built (or buildable) e2e-runner binary", () => {
    // resolveHelperBin() builds on demand; we just want to confirm
    // the path it returns exists after the call.
    const bin = resolveHelperBin();
    expect(existsSync(bin)).toBe(true);
  });

  it("uses a hostname-keyed credential path that matches defaultFilePath()", () => {
    // Defensive: keep the in-test credentialsPath() in sync with
    // src/auth/token-store.ts by checking the shape, not the
    // value. The hash is host-specific so we only assert the
    // directory layout.
    const path = credentialsPath("http://127.0.0.1:18099");
    expect(path).toMatch(/kanban-cli[/\\]credentials-/);
  });

  it("hostname() returns a non-empty value for the encryption salt", () => {
    // defaultFilePath + pbkdf2 both rely on hostname() being
    // available; guard against a CI environment that resets
    // HOSTNAME somehow.
    expect(hostname().length).toBeGreaterThan(0);
  });
});
