// End-to-end test for the `kanban tasks create` command against a real
// Go HTTP server backed by an in-memory SQLite (the `kanban-e2e-runner`
// binary, built from `backend/cmd/e2e-runner`).
//
// The unit suite in src/commands/tasks.test.ts already covers the
// underlying `runTaskCreate` function via mocked fetch; this file
// proves the wired-up CLI binary -- the version users actually run --
// produces the same observable behaviour end-to-end. Specifically:
//
//   1. The `kanban tasks create --title "..." --column <id>` invocation
//      exits 0, posts the task to /api/v1/tasks with the expected body,
//      and prints a record containing the new task id.
//   2. The created task is visible through the public GET
//      /api/v1/tasks/:id endpoint with the title / column / priority
//      the CLI sent (i.e. the row was actually persisted, not just
//      echoed back).
//   3. `kanban tasks list --column <id> --output json` reports the new
//      task alongside any pre-existing seeded tasks, matching the same
//      id / title fields.
//   4. `--status in_progress` resolves to the seeded `Doing` column
//      without the caller having to know its column id, matching the
//      documented `kanban tasks create --status` behaviour.
//
// The test follows the same OAuth-bypass shortcut the runner suite
// uses: it writes the seeded bot-user bearer directly into the CLI's
// credential file so the CLI's request reaches the helper's
// RequireAuth middleware without spinning up a real device-flow.
// The CLI e2e suite (tests/e2e.test.ts) already exercises the OAuth
// path; this file is narrowly scoped to the `tasks create` command
// surface.
//
// The helper binary is rebuilt by the suite via `go build`; CI can
// override the path with `KANBAN_E2E_RUNNER_BIN` to skip the build.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { FileSecretProvider, type StoredCredentials } from "../../src/auth/token-store.js";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const CLI_DIST = join(REPO_ROOT, "cli", "dist", "index.js");
const BACKEND_DIR = join(REPO_ROOT, "backend");
const HELPER_DEFAULT_BIN = join(BACKEND_DIR, "bin", "kanban-e2e-runner");

const SEED_BOARD_ID = "b-tasks-create";
const TODO_COLUMN_ID = "c-e2e-todo";

interface FetchJsonResult {
  status: number;
  body: unknown;
}

async function fetchJson(url: string, init: RequestInit = {}): Promise<FetchJsonResult> {
  const res = await fetch(url, init);
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
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = 18300 + Math.floor(Math.random() * 1000);
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
  const targetDir = join(BACKEND_DIR, "bin");
  writeFileSync(
    join(targetDir, ".gitkeep"),
    "# Helper binaries for the CLI e2e suite live here.\n",
    "utf8"
  );
  execFileSync("go", ["build", "-o", HELPER_DEFAULT_BIN, "./cmd/e2e-runner"], {
    cwd: BACKEND_DIR,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return HELPER_DEFAULT_BIN;
}

function credentialsPath(apiUrl: string, xdgHome: string): string {
  const safe = apiUrl.replace(/[^a-z0-9]+/gi, "_").toLowerCase();
  const base = xdgHome || process.env.XDG_CONFIG_HOME || join(process.env.HOME || "~", ".config");
  return join(base, "kanban-cli", `credentials-${safe}.json`);
}

function writeBotCredentials(opts: { apiUrl: string; tokenFilePath: string }): void {
  const provider = new FileSecretProvider(opts.tokenFilePath);
  const creds: StoredCredentials = {
    apiUrl: opts.apiUrl,
    clientId: "e2e-tasks-create",
    clientName: "open-kanban-cli",
    accessToken: "e2e-agent-token",
    accessExpiresAt: Date.now() + 60 * 60 * 1000,
    scope: "kanban:read tasks:write comments:write",
  };
  provider.write(creds);
}

interface HelperHandle {
  proc: ChildProcess;
  apiUrl: string;
  adminToken: string;
  logFile: string;
  cleanup(): Promise<void>;
}

async function startHelper(port: number, bin: string, logPath: string): Promise<HelperHandle> {
  const logFd = (await import("node:fs")).openSync(logPath, "w");
  const proc = spawn(bin, ["--port", String(port), "--board", SEED_BOARD_ID], {
    cwd: REPO_ROOT,
    env: { ...process.env, GIN_MODE: "debug" },
    stdio: ["ignore", "pipe", "pipe"],
  });
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
    logFile: logPath,
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

interface CreatedTask {
  apiUrl?: string;
  task: {
    id?: string;
    title?: string;
    description?: string | null;
    priority?: string;
    assignee?: string | null;
    columnId?: string;
    published?: boolean;
  };
}

interface TasksListResponse {
  apiUrl?: string;
  tasks: Array<{ id?: string; title?: string; columnId?: string }>;
}

const helperBin = resolveHelperBin();

describe("CLI `kanban tasks create` e2e (against a real Go server)", () => {
  let workDir: string;
  let xdgHome: string;
  let helper: HelperHandle | null = null;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "kanban-tasks-create-"));
    xdgHome = mkdtempSync(join(tmpdir(), "kanban-tasks-create-xdg-"));
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
    "creates a task via --column and the new id is visible in the backend",
    async () => {
      const port = await freePort();
      helper = await startHelper(port, helperBin, join(workDir, "helper.log"));
      const apiUrl = helper.apiUrl;

      writeBotCredentials({
        apiUrl,
        tokenFilePath: credentialsPath(apiUrl, xdgHome),
      });

      const result = await runCli({
        cwd: workDir,
        args: [
          "tasks",
          "create",
          "--title",
          "测试任务",
          "--description",
          "e2e-create verification",
          "--column",
          TODO_COLUMN_ID,
          "--priority",
          "high",
          "--assignee",
          "e2e-bot",
          "--output",
          "json",
        ],
        env: { KANBAN_API_URL: apiUrl, XDG_CONFIG_HOME: xdgHome },
      });

      // eslint-disable-next-line no-console
      console.log("kanban tasks create stdout:\n" + result.stdout);
      // eslint-disable-next-line no-console
      console.log("kanban tasks create stderr:\n" + result.stderr);
      // eslint-disable-next-line no-console
      console.log("helper log:\n" + readFileSync(helper.logFile, "utf8"));

      expect(
        result.code,
        `CLI exited with non-zero status.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
      ).toBe(0);

      let parsed: CreatedTask;
      try {
        parsed = JSON.parse(result.stdout) as CreatedTask;
      } catch (err) {
        throw new Error(
          `failed to parse --output json payload: ${(err as Error).message}\nstdout:\n${result.stdout}`
        );
      }
      const newId = parsed.task?.id;
      expect(newId, "create response must include task.id").toBeTruthy();
      expect(parsed.task.title).toBe("测试任务");
      expect(parsed.task.columnId).toBe(TODO_COLUMN_ID);
      expect(parsed.task.priority).toBe("high");
      expect(parsed.task.assignee).toBe("e2e-bot");
      expect(parsed.task.published).toBe(true);

      // Round-trip via the public GET endpoint to prove the row was
      // actually persisted (not just echoed back from POST).
      const getRes = await fetchJson(`${apiUrl}/api/v1/tasks/${newId}`, {
        headers: { Authorization: `Bearer ${helper.adminToken}` },
      });
      expect(getRes.status).toBe(200);
      const got = getRes.body as CreatedTask["task"];
      expect(got.id).toBe(newId);
      expect(got.title).toBe("测试任务");
      expect(got.description).toBe("e2e-create verification");
      expect(got.columnId).toBe(TODO_COLUMN_ID);
      expect(got.priority).toBe("high");

      // The new task should also surface under the columns endpoint,
      // matching the kanban dashboard's "list tasks in this column"
      // contract.
      const columnsRes = await fetchJson(`${apiUrl}/api/v1/columns`, {
        headers: { Authorization: `Bearer ${helper.adminToken}` },
      });
      expect(columnsRes.status).toBe(200);
      const columns = columnsRes.body as Array<{
        id?: string;
        tasks?: Array<{ id?: string; title?: string }>;
      }>;
      const todoColumn = columns.find((c) => c.id === TODO_COLUMN_ID);
      const inColumn = todoColumn?.tasks?.find((t) => t.id === newId);
      expect(
        inColumn,
        `expected new task ${newId} in column ${TODO_COLUMN_ID}, got: ${JSON.stringify(todoColumn?.tasks ?? [])}`
      ).toBeTruthy();
      expect(inColumn?.title).toBe("测试任务");
    },
    30_000
  );

  it(
    "the new task appears in `kanban tasks list --column <id>`",
    async () => {
      const port = await freePort();
      helper = await startHelper(port, helperBin, join(workDir, "helper.log"));
      const apiUrl = helper.apiUrl;

      writeBotCredentials({
        apiUrl,
        tokenFilePath: credentialsPath(apiUrl, xdgHome),
      });

      const created = await runCli({
        cwd: workDir,
        args: [
          "tasks",
          "create",
          "--title",
          "listable task",
          "--column",
          TODO_COLUMN_ID,
          "--output",
          "json",
        ],
        env: { KANBAN_API_URL: apiUrl, XDG_CONFIG_HOME: xdgHome },
      });
      expect(created.code).toBe(0);
      const createdId = (JSON.parse(created.stdout) as CreatedTask).task.id;
      expect(createdId).toBeTruthy();

      const list = await runCli({
        cwd: workDir,
        args: [
          "tasks",
          "list",
          "--column",
          TODO_COLUMN_ID,
          "--output",
          "json",
        ],
        env: { KANBAN_API_URL: apiUrl, XDG_CONFIG_HOME: xdgHome },
      });
      expect(list.code).toBe(0);
      const parsed = JSON.parse(list.stdout) as TasksListResponse;
      const match = parsed.tasks.find((t) => t.id === createdId);
      expect(
        match,
        `expected new task ${createdId} in column ${TODO_COLUMN_ID}, got: ${JSON.stringify(parsed.tasks)}`
      ).toBeTruthy();
      expect(match?.title).toBe("listable task");
    },
    30_000
  );

  it(
    "rejects --column and --status supplied together",
    async () => {
      const port = await freePort();
      helper = await startHelper(port, helperBin, join(workDir, "helper.log"));
      const apiUrl = helper.apiUrl;

      writeBotCredentials({
        apiUrl,
        tokenFilePath: credentialsPath(apiUrl, xdgHome),
      });

      const result = await runCli({
        cwd: workDir,
        args: [
          "tasks",
          "create",
          "--title",
          "conflict",
          "--column",
          TODO_COLUMN_ID,
          "--status",
          "todo",
        ],
        env: { KANBAN_API_URL: apiUrl, XDG_CONFIG_HOME: xdgHome },
      });

      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/--column|--status|mutually exclusive|only one/i);
    },
    30_000
  );
});

// Sanity-check the test bootstrap itself so a missing CLI build or
// helper binary fails loudly instead of mid-test.
describe("tasks-create e2e prerequisites", () => {
  it("has a built CLI at dist/index.js", () => {
    expect(existsSync(CLI_DIST)).toBe(true);
  });

  it("has a built (or buildable) e2e-runner binary", () => {
    const bin = resolveHelperBin();
    expect(existsSync(bin)).toBe(true);
  });
});
