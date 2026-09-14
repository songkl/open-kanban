// End-to-end test for the `kanban tasks move` command against a real
// Go HTTP server backed by an in-memory SQLite (the `kanban-e2e-runner`
// binary, built from `backend/cmd/e2e-runner`).
//
// The unit suite in src/commands/tasks.test.ts already covers the
// underlying `runTaskMove` function via mocked fetch; this file proves
// the wired-up CLI binary — the version users actually run — moves a
// task to a target column end-to-end. Specifically:
//
//   1. `kanban tasks create --column <id>` produces a fresh task id
//      (reused from tasks-create.test.ts so the helper binary stays
//      the single source of truth for the seed schema).
//   2. `kanban tasks move <id> --column <targetColumnId>` exits 0,
//      PUTs { columnId } to /api/v1/tasks/:id, and prints a record
//      whose columnId matches the target.
//   3. The new column id is observable via the public GET
//      /api/v1/tasks/:id endpoint, proving the row was actually
//      mutated (not just echoed back from PUT).
//   4. Listing the source column via /api/v1/columns shows the
//      task is no longer there, while the target column now contains
//      it — matching the documented "task appears in the target
//      column, original column no longer has it" acceptance criteria.
//   5. `kanban tasks move <id> --status done` resolves to the
//      seeded Done column without the caller having to know its
//      column id, matching the documented move --status behaviour.
//   6. The command rejects calls that supply neither --column nor
//      --status, and rejects simultaneous --column + --status, with
//      a non-zero exit (mutually exclusive / required flags).
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

const SEED_BOARD_ID = "b-tasks-move";
// Column ids come from the e2e-runner seed (cmd/e2e-runner/main.go).
// They are board-agnostic: every run of the helper uses these ids
// regardless of the --board flag.
const TODO_COLUMN_ID = "c-e2e-todo";
const DOING_COLUMN_ID = "c-e2e-doing";
const REVIEW_COLUMN_ID = "c-e2e-review";
const DONE_COLUMN_ID = "c-e2e-done";

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
    const port = 18500 + Math.floor(Math.random() * 1000);
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
    clientId: "e2e-tasks-move",
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

interface MovedTask {
  apiUrl?: string;
  task: {
    id?: string;
    title?: string;
    columnId?: string;
  };
}

interface ColumnWithTasks {
  id?: string;
  name?: string;
  tasks?: Array<{ id?: string }>;
}

async function createTaskViaCli(opts: {
  apiUrl: string;
  xdgHome: string;
  workDir: string;
  title: string;
  columnId: string;
}): Promise<{ code: number; stdout: string; stderr: string; taskId: string; sourceColumnId: string }> {
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
  expect(parsed.task.columnId).toBe(opts.columnId);
  return { ...result, taskId: parsed.task.id!, sourceColumnId: opts.columnId };
}

async function fetchColumns(apiUrl: string, adminToken: string): Promise<ColumnWithTasks[]> {
  const res = await fetchJson(`${apiUrl}/api/v1/columns?boardId=${SEED_BOARD_ID}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  expect(res.status, `GET /api/v1/columns returned ${res.status}`).toBe(200);
  return Array.isArray(res.body) ? (res.body as ColumnWithTasks[]) : [];
}

const helperBin = resolveHelperBin();

describe("CLI `kanban tasks move` e2e (against a real Go server)", () => {
  let workDir: string;
  let xdgHome: string;
  let helper: HelperHandle | null = null;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "kanban-tasks-move-"));
    xdgHome = mkdtempSync(join(tmpdir(), "kanban-tasks-move-xdg-"));
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
    "moves a Todo task to Doing via --column and the change is persisted",
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
        title: "move-me",
        columnId: TODO_COLUMN_ID,
      });

      const result = await runCli({
        cwd: workDir,
        args: [
          "tasks",
          "move",
          created.taskId,
          "--column",
          DOING_COLUMN_ID,
          "--output",
          "json",
        ],
        env: { KANBAN_API_URL: apiUrl, XDG_CONFIG_HOME: xdgHome },
      });

      // eslint-disable-next-line no-console
      console.log("kanban tasks move stdout:\n" + result.stdout);
      // eslint-disable-next-line no-console
      console.log("kanban tasks move stderr:\n" + result.stderr);
      // eslint-disable-next-line no-console
      console.log("helper log:\n" + readFileSync(helper.logFile, "utf8"));

      expect(
        result.code,
        `CLI exited with non-zero status.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
      ).toBe(0);

      let parsed: MovedTask;
      try {
        parsed = JSON.parse(result.stdout) as MovedTask;
      } catch (err) {
        throw new Error(
          `failed to parse --output json payload: ${(err as Error).message}\nstdout:\n${result.stdout}`
        );
      }
      expect(parsed.task.id).toBe(created.taskId);
      expect(parsed.task.columnId).toBe(DOING_COLUMN_ID);

      // Round-trip via the public GET endpoint to prove the row was
      // actually mutated (not just echoed back from PUT).
      const getRes = await fetchJson(`${apiUrl}/api/v1/tasks/${created.taskId}`, {
        headers: { Authorization: `Bearer ${helper.adminToken}` },
      });
      expect(getRes.status).toBe(200);
      const got = getRes.body as MovedTask["task"];
      expect(got.id).toBe(created.taskId);
      expect(got.columnId).toBe(DOING_COLUMN_ID);
    },
    30_000
  );

  it(
    "the task appears in the target column and the source column no longer has it",
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
        title: "track-columns",
        columnId: TODO_COLUMN_ID,
      });

      // Sanity-check the pre-move state: the source column lists the
      // task, the target column does not.
      const beforeColumns = await fetchColumns(apiUrl, helper.adminToken);
      const beforeTodo = beforeColumns.find((c) => c.id === TODO_COLUMN_ID);
      const beforeDoing = beforeColumns.find((c) => c.id === DOING_COLUMN_ID);
      expect(
        beforeTodo?.tasks?.some((t) => t.id === created.taskId),
        "task should start in the TODO column"
      ).toBe(true);
      expect(
        beforeDoing?.tasks?.some((t) => t.id === created.taskId),
        "task should NOT be in Doing before the move"
      ).toBe(false);

      const result = await runCli({
        cwd: workDir,
        args: [
          "tasks",
          "move",
          created.taskId,
          "--column",
          DOING_COLUMN_ID,
        ],
        env: { KANBAN_API_URL: apiUrl, XDG_CONFIG_HOME: xdgHome },
      });

      expect(
        result.code,
        `CLI exited with non-zero status.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
      ).toBe(0);

      // After the move: source column must no longer list the task,
      // target column must list it. This is the documented acceptance
      // criterion from the task description.
      const afterColumns = await fetchColumns(apiUrl, helper.adminToken);
      const afterTodo = afterColumns.find((c) => c.id === TODO_COLUMN_ID);
      const afterDoing = afterColumns.find((c) => c.id === DOING_COLUMN_ID);
      expect(
        afterTodo?.tasks?.some((t) => t.id === created.taskId),
        "task should no longer be in TODO after the move"
      ).toBe(false);
      expect(
        afterDoing?.tasks?.some((t) => t.id === created.taskId),
        "task should be in Doing after the move"
      ).toBe(true);
    },
    30_000
  );

  it(
    "resolves --status to a columnId via the columns endpoint",
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
        title: "move-via-status",
        columnId: TODO_COLUMN_ID,
      });

      const result = await runCli({
        cwd: workDir,
        args: [
          "tasks",
          "move",
          created.taskId,
          "--status",
          "review",
          "--output",
          "json",
        ],
        env: { KANBAN_API_URL: apiUrl, XDG_CONFIG_HOME: xdgHome },
      });

      expect(
        result.code,
        `CLI exited with non-zero status.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
      ).toBe(0);

      const parsed = JSON.parse(result.stdout) as MovedTask;
      expect(parsed.task.id).toBe(created.taskId);
      expect(parsed.task.columnId).toBe(REVIEW_COLUMN_ID);

      const getRes = await fetchJson(`${apiUrl}/api/v1/tasks/${created.taskId}`, {
        headers: { Authorization: `Bearer ${helper.adminToken}` },
      });
      expect(getRes.status).toBe(200);
      const got = getRes.body as MovedTask["task"];
      expect(got.columnId).toBe(REVIEW_COLUMN_ID);
    },
    30_000
  );

  it(
    "can hop across multiple columns by repeated move calls",
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
        title: "hop-around",
        columnId: TODO_COLUMN_ID,
      });

      // Walk Todo → Doing → Review → Done using --column explicitly
      // each time. The move command is more flexible than complete
      // (which only advances to the next column), so this exercises
      // arbitrary column targets.
      const hops: Array<{ from: string; to: string }> = [
        { from: TODO_COLUMN_ID, to: DOING_COLUMN_ID },
        { from: DOING_COLUMN_ID, to: REVIEW_COLUMN_ID },
        { from: REVIEW_COLUMN_ID, to: DONE_COLUMN_ID },
      ];
      for (const hop of hops) {
        const result = await runCli({
          cwd: workDir,
          args: [
            "tasks",
            "move",
            created.taskId,
            "--column",
            hop.to,
            "--output",
            "json",
          ],
          env: { KANBAN_API_URL: apiUrl, XDG_CONFIG_HOME: xdgHome },
        });
        expect(
          result.code,
          `expected exit 0 moving from ${hop.from} to ${hop.to}, got ${result.code}.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
        ).toBe(0);
        const parsed = JSON.parse(result.stdout) as MovedTask;
        expect(parsed.task.columnId).toBe(hop.to);

        const columns = await fetchColumns(apiUrl, helper.adminToken);
        const fromCol = columns.find((c) => c.id === hop.from);
        const toCol = columns.find((c) => c.id === hop.to);
        expect(
          fromCol?.tasks?.some((t) => t.id === created.taskId),
          `task should be gone from ${hop.from} after the move`
        ).toBe(false);
        expect(
          toCol?.tasks?.some((t) => t.id === created.taskId),
          `task should be in ${hop.to} after the move`
        ).toBe(true);
      }
    },
    45_000
  );

  it(
    "rejects calls with neither --column nor --status",
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
        title: "missing-flags",
        columnId: TODO_COLUMN_ID,
      });

      const result = await runCli({
        cwd: workDir,
        args: ["tasks", "move", created.taskId],
        env: { KANBAN_API_URL: apiUrl, XDG_CONFIG_HOME: xdgHome },
      });

      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/--column|--status|one of/i);
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

      const created = await createTaskViaCli({
        apiUrl,
        xdgHome,
        workDir,
        title: "conflict",
        columnId: TODO_COLUMN_ID,
      });

      const result = await runCli({
        cwd: workDir,
        args: [
          "tasks",
          "move",
          created.taskId,
          "--column",
          DOING_COLUMN_ID,
          "--status",
          "done",
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
describe("tasks-move e2e prerequisites", () => {
  it("has a built CLI at dist/index.js", () => {
    expect(existsSync(CLI_DIST)).toBe(true);
  });

  it("has a built (or buildable) e2e-runner binary", () => {
    const bin = resolveHelperBin();
    expect(existsSync(bin)).toBe(true);
  });
});
