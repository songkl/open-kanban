// End-to-end test for the `kanban tasks delete` command against a real
// Go HTTP server backed by an in-memory SQLite (the `kanban-e2e-runner`
// binary, built from `backend/cmd/e2e-runner`).
//
// The unit suite in src/commands/tasks.test.ts already covers the
// underlying `runTaskDelete` function via mocked fetch; this file
// proves the wired-up CLI binary -- the version users actually run --
// removes a task end-to-end. Specifically:
//
//   1. `kanban tasks create --column <id>` creates a task (see
//      tasks-create.test.ts for the create-side coverage; this file
//      reuses the same helper binary and create helper).
//   2. `kanban tasks delete <id> --yes` exits 0, DELETEs
//      /api/v1/tasks/:id, and prints a record whose `success` is true
//      and whose `id` matches the deleted task.
//   3. The deletion is observable via the public GET /api/v1/tasks/:id
//      endpoint: a follow-up fetch returns 404, proving the row was
//      actually removed (not just echoed back from DELETE).
//   4. `kanban tasks list` no longer includes the deleted id, proving
//      the row no longer shows up in the list view.
//   5. A second `kanban tasks delete <id>` call against the same id
//      exits non-zero, matching the backend's 404 + "Task not found"
//      behaviour the unit suite already covers with mocked fetch.
//   6. `kanban tasks delete` with no id rejects usage with a non-zero
//      exit and a stderr hint, matching the documented "requires a task
//      id" guard in runTaskDelete.
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

const SEED_BOARD_ID = "b-tasks-delete";
// Column ids come from the e2e-runner seed (cmd/e2e-runner/main.go).
// They are board-agnostic: every run of the helper uses these ids
// regardless of the --board flag.
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
    const port = 18600 + Math.floor(Math.random() * 1000);
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
    clientId: "e2e-tasks-delete",
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
    columnId?: string;
  };
}

interface DeletedTask {
  apiUrl?: string;
  id?: string;
  success?: boolean;
}

interface TasksListResponse {
  apiUrl?: string;
  tasks: Array<{ id?: string; title?: string; columnId?: string }>;
}

async function createTaskViaCli(opts: {
  apiUrl: string;
  xdgHome: string;
  workDir: string;
  title: string;
  columnId: string;
}): Promise<{ code: number; stdout: string; stderr: string; taskId: string }> {
  const result = await runCli({
    cwd: opts.workDir,
    args: [
      "tasks",
      "create",
      "--title",
      opts.title,
      "--column",
      opts.columnId,
      "--output",
      "json",
    ],
    env: { KANBAN_API_URL: opts.apiUrl, XDG_CONFIG_HOME: opts.xdgHome },
  });
  expect(
    result.code,
    `tasks create exited non-zero.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  ).toBe(0);
  const parsed = JSON.parse(result.stdout) as CreatedTask;
  expect(parsed.task.id, "create response must include task.id").toBeTruthy();
  return { ...result, taskId: parsed.task.id! };
}

const helperBin = resolveHelperBin();

describe("CLI `kanban tasks delete` e2e (against a real Go server)", () => {
  let workDir: string;
  let xdgHome: string;
  let helper: HelperHandle | null = null;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "kanban-tasks-delete-"));
    xdgHome = mkdtempSync(join(tmpdir(), "kanban-tasks-delete-xdg-"));
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
    "DELETEs /api/v1/tasks/:id and the row is gone from the server",
    async () => {
      const port = await freePort();
      helper = await startHelper(port, helperBin, join(workDir, "helper.log"));
      const apiUrl = helper.apiUrl;

      writeBotCredentials({
        apiUrl,
        tokenFilePath: credentialsPath(apiUrl, xdgHome),
      });

      const created = await createTaskViaCli({
        apiUrl,
        xdgHome,
        workDir,
        title: "delete-me",
        columnId: TODO_COLUMN_ID,
      });

      const result = await runCli({
        cwd: workDir,
        args: [
          "tasks",
          "delete",
          created.taskId,
          "--yes",
          "--output",
          "json",
        ],
        env: { KANBAN_API_URL: apiUrl, XDG_CONFIG_HOME: xdgHome },
      });

      // eslint-disable-next-line no-console
      console.log("kanban tasks delete stdout:\n" + result.stdout);
      // eslint-disable-next-line no-console
      console.log("kanban tasks delete stderr:\n" + result.stderr);
      // eslint-disable-next-line no-console
      console.log("helper log:\n" + readFileSync(helper.logFile, "utf8"));

      expect(
        result.code,
        `CLI exited with non-zero status.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
      ).toBe(0);

      let parsed: DeletedTask;
      try {
        parsed = JSON.parse(result.stdout) as DeletedTask;
      } catch (err) {
        throw new Error(
          `failed to parse --output json payload: ${(err as Error).message}\nstdout:\n${result.stdout}`
        );
      }
      expect(parsed.id).toBe(created.taskId);
      expect(parsed.success).toBe(true);

      // Round-trip via the public GET endpoint to prove the row was
      // actually removed (not just echoed back from DELETE).
      const getRes = await fetchJson(`${apiUrl}/api/v1/tasks/${created.taskId}`, {
        headers: { Authorization: `Bearer ${helper.adminToken}` },
      });
      expect(getRes.status).toBe(404);
    },
    30_000
  );

  it(
    "no longer includes the deleted task in the list view",
    async () => {
      const port = await freePort();
      helper = await startHelper(port, helperBin, join(workDir, "helper.log"));
      const apiUrl = helper.apiUrl;

      writeBotCredentials({
        apiUrl,
        tokenFilePath: credentialsPath(apiUrl, xdgHome),
      });

      const created = await createTaskViaCli({
        apiUrl,
        xdgHome,
        workDir,
        title: "ephemeral",
        columnId: TODO_COLUMN_ID,
      });

      // Sanity-check: the task is in the list immediately after create.
      const beforeDelete = await runCli({
        cwd: workDir,
        args: ["tasks", "list", "--output", "json"],
        env: { KANBAN_API_URL: apiUrl, XDG_CONFIG_HOME: xdgHome },
      });
      expect(beforeDelete.code).toBe(0);
      const beforeList = JSON.parse(beforeDelete.stdout) as TasksListResponse;
      const beforeIds = (beforeList.tasks ?? []).map((t) => t.id);
      expect(beforeIds).toContain(created.taskId);

      const result = await runCli({
        cwd: workDir,
        args: ["tasks", "delete", created.taskId, "--yes"],
        env: { KANBAN_API_URL: apiUrl, XDG_CONFIG_HOME: xdgHome },
      });
      expect(
        result.code,
        `tasks delete exited non-zero.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
      ).toBe(0);

      const afterDelete = await runCli({
        cwd: workDir,
        args: ["tasks", "list", "--output", "json"],
        env: { KANBAN_API_URL: apiUrl, XDG_CONFIG_HOME: xdgHome },
      });
      expect(afterDelete.code).toBe(0);
      const afterList = JSON.parse(afterDelete.stdout) as TasksListResponse;
      const afterIds = (afterList.tasks ?? []).map((t) => t.id);
      expect(afterIds).not.toContain(created.taskId);
    },
    30_000
  );

  it(
    "returns a non-zero exit when deleting a task that no longer exists",
    async () => {
      const port = await freePort();
      helper = await startHelper(port, helperBin, join(workDir, "helper.log"));
      const apiUrl = helper.apiUrl;

      writeBotCredentials({
        apiUrl,
        tokenFilePath: credentialsPath(apiUrl, xdgHome),
      });

      const created = await createTaskViaCli({
        apiUrl,
        xdgHome,
        workDir,
        title: "ghost",
        columnId: TODO_COLUMN_ID,
      });

      const first = await runCli({
        cwd: workDir,
        args: ["tasks", "delete", created.taskId, "--yes"],
        env: { KANBAN_API_URL: apiUrl, XDG_CONFIG_HOME: xdgHome },
      });
      expect(first.code).toBe(0);

      const second = await runCli({
        cwd: workDir,
        args: ["tasks", "delete", created.taskId, "--yes"],
        env: { KANBAN_API_URL: apiUrl, XDG_CONFIG_HOME: xdgHome },
      });
      expect(
        second.code,
        `second delete should fail with non-zero exit.\nstdout:\n${second.stdout}\nstderr:\n${second.stderr}`
      ).not.toBe(0);
      expect(second.stderr.toLowerCase()).toMatch(/task not found|not found/i);
    },
    30_000
  );

  it(
    "rejects a missing task id with a non-zero exit and stderr hint",
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
        args: ["tasks", "delete"],
        env: { KANBAN_API_URL: apiUrl, XDG_CONFIG_HOME: xdgHome },
      });
      expect(result.code).not.toBe(0);
      expect(result.stderr.toLowerCase()).toMatch(/requires a task id|task id|missing required argument/);
    },
    30_000
  );
});

// Sanity-check the test bootstrap itself so a missing CLI build or
// helper binary fails loudly instead of mid-test.
describe("tasks-delete e2e prerequisites", () => {
  it("has a built CLI at dist/index.js", () => {
    expect(existsSync(CLI_DIST)).toBe(true);
  });

  it("has a built (or buildable) e2e-runner binary", () => {
    const bin = resolveHelperBin();
    expect(existsSync(bin)).toBe(true);
  });
});
