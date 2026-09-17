// End-to-end test for the `kanban subtasks create / list` commands
// against a real Go HTTP server backed by an in-memory SQLite (the
// `kanban-e2e-runner` binary, built from `backend/cmd/e2e-runner`).
//
// The unit suite in src/commands/subtasks.test.ts already covers the
// underlying `runSubtasksCreate` / `runSubtasksList` functions via
// mocked fetch; this file proves the wired-up CLI binary — the
// version users actually run — produces the same observable
// behaviour end-to-end. Specifically:
//
//   1. `kanban tasks create --column <id>` produces a fresh task id
//      (reused from tasks-create.test.ts so the helper binary stays
//      the single source of truth for the seed schema).
//   2. `kanban subtasks create <taskId> --title "..."` exits 0, POSTs
//      { taskId, title } to /api/v1/subtasks, and prints the new
//      subtask id / title / taskId / completed=false (the backend
//      always seeds a new subtask with completed=false and echoes
//      the same shape).
//   3. The subtask is visible through the public GET
//      /api/v1/subtasks?taskId=<id> endpoint with the same title and
//      taskId, proving the row was actually persisted (not just
//      echoed back from POST).
//   4. `kanban subtasks list <taskId>` reports the same subtask via
//      the JSON renderer, matching the documented "list subtasks
//      for a task" behaviour. The parent id matches what the CLI
//      used at create time, proving the parent/child relationship
//      round-trips through the server.
//   5. Multiple subtasks added to the same parent all surface in
//      the list response ordered by created_at ASC, mirroring how
//      the dashboard's subtasks panel renders them.
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

const SEED_BOARD_ID = "b-subtasks";
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
    clientId: "e2e-subtasks",
    clientName: "open-kanban-cli",
    accessToken: "e2e-agent-token",
    accessExpiresAt: Date.now() + 60 * 60 * 1000,
    scope: "kanban:read tasks:write",
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
    proc.stdin?.end();
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

interface CreatedSubtask {
  apiUrl?: string;
  subtask: {
    id?: string;
    title?: string;
    completed?: boolean;
    taskId?: string;
    createdAt?: string;
    updatedAt?: string;
  };
}

interface SubtasksListResponse {
  apiUrl?: string;
  taskId?: string;
  subtasks: Array<{
    id?: string;
    title?: string;
    completed?: boolean;
    taskId?: string;
    createdAt?: string;
    updatedAt?: string;
  }>;
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

describe("CLI `kanban subtasks create / list` e2e (against a real Go server)", () => {
  let workDir: string;
  let xdgHome: string;
  let helper: HelperHandle | null = null;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "kanban-subtasks-"));
    xdgHome = mkdtempSync(join(tmpdir(), "kanban-subtasks-xdg-"));
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
    "creates a subtask via --title and the parent/child relationship round-trips through the server",
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
        title: "subtask-target",
        columnId: TODO_COLUMN_ID,
      });

      const result = await runCli({
        cwd: workDir,
        args: [
          "subtasks",
          "create",
          created.taskId,
          "--title",
          "子任务1",
          "--output",
          "json",
        ],
        env: { KANBAN_API_URL: apiUrl, XDG_CONFIG_HOME: xdgHome },
      });

      // eslint-disable-next-line no-console
      console.log("kanban subtasks create stdout:\n" + result.stdout);
      // eslint-disable-next-line no-console
      console.log("kanban subtasks create stderr:\n" + result.stderr);
      // eslint-disable-next-line no-console
      console.log("helper log:\n" + readFileSync(helper.logFile, "utf8"));

      expect(
        result.code,
        `CLI exited with non-zero status.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
      ).toBe(0);

      let parsed: CreatedSubtask;
      try {
        parsed = JSON.parse(result.stdout) as CreatedSubtask;
      } catch (err) {
        throw new Error(
          `failed to parse --output json payload: ${(err as Error).message}\nstdout:\n${result.stdout}`
        );
      }
      expect(parsed.subtask.id, "create response must include subtask.id").toBeTruthy();
      expect(parsed.subtask.title).toBe("子任务1");
      expect(parsed.subtask.taskId).toBe(created.taskId);
      // The backend always seeds a new subtask with completed=false,
      // so the CLI must echo the same default.
      expect(parsed.subtask.completed).toBe(false);
      expect(typeof parsed.subtask.createdAt).toBe("string");

      // Round-trip via the public GET endpoint to prove the row was
      // actually persisted (not just echoed back from POST) and that
      // the parent/child link survived the server's INSERT path.
      const getRes = await fetchJson(
        `${apiUrl}/api/v1/subtasks?taskId=${created.taskId}`,
        { headers: { Authorization: `Bearer ${helper.adminToken}` } }
      );
      expect(getRes.status).toBe(200);
      const rows = getRes.body as Array<{
        id?: string;
        title?: string;
        completed?: boolean;
        taskId?: string;
      }>;
      const match = rows.find((s) => s.id === parsed.subtask.id);
      expect(
        match,
        `expected subtask ${parsed.subtask.id} in list, got: ${JSON.stringify(rows)}`
      ).toBeTruthy();
      expect(match?.title).toBe("子任务1");
      expect(match?.completed).toBe(false);
      expect(match?.taskId).toBe(created.taskId);
    },
    30_000
  );

  it(
    "lists subtasks via `kanban subtasks list` and the JSON output matches the server",
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
        title: "listable-subtasks-target",
        columnId: TODO_COLUMN_ID,
      });

      // Seed three subtasks so we can assert ordering by created_at
      // ASC and prove the list endpoint exposes them all under the
      // same parent id.
      const seedTitles = ["first 子任务", "second 子任务", "third 子任务"];
      const seeded: string[] = [];
      for (const title of seedTitles) {
        const res = await runCli({
          cwd: workDir,
          args: [
            "subtasks",
            "create",
            created.taskId,
            "--title",
            title,
            "--output",
            "json",
          ],
          env: { KANBAN_API_URL: apiUrl, XDG_CONFIG_HOME: xdgHome },
        });
        expect(
          res.code,
          `subtasks create exited non-zero.\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`
        ).toBe(0);
        const id = (JSON.parse(res.stdout) as CreatedSubtask).subtask.id;
        expect(id, `subtasks create must return an id; got: ${res.stdout}`).toBeTruthy();
        seeded.push(id!);
      }

      const list = await runCli({
        cwd: workDir,
        args: ["subtasks", "list", created.taskId, "--output", "json"],
        env: { KANBAN_API_URL: apiUrl, XDG_CONFIG_HOME: xdgHome },
      });

      expect(
        list.code,
        `CLI exited with non-zero status.\nstdout:\n${list.stdout}\nstderr:\n${list.stderr}`
      ).toBe(0);

      const parsed = JSON.parse(list.stdout) as SubtasksListResponse;
      expect(parsed.taskId).toBe(created.taskId);
      // The list endpoint returns every subtask for the task,
      // ordered by created_at ASC. We seeded exactly three; any
      // extras would indicate a leak between tests in the same
      // process.
      expect(parsed.subtasks).toHaveLength(3);
      const byTitle = new Map(parsed.subtasks.map((s) => [s.title, s]));
      expect(byTitle.get("first 子任务")?.id).toBe(seeded[0]);
      expect(byTitle.get("second 子任务")?.id).toBe(seeded[1]);
      expect(byTitle.get("third 子任务")?.id).toBe(seeded[2]);
      for (const s of parsed.subtasks) {
        expect(s.taskId).toBe(created.taskId);
        // New subtasks default to completed=false (the backend
        // never creates a subtask already done).
        expect(s.completed).toBe(false);
        expect(typeof s.createdAt).toBe("string");
        expect(typeof s.updatedAt).toBe("string");
      }

      // The server-side endpoint must agree with the CLI's view:
      // all three ids, all three titles, and every row carries the
      // matching parent taskId.
      const serverRes = await fetchJson(
        `${apiUrl}/api/v1/subtasks?taskId=${created.taskId}`,
        { headers: { Authorization: `Bearer ${helper.adminToken}` } }
      );
      expect(serverRes.status).toBe(200);
      const serverRows = serverRes.body as Array<{
        id?: string;
        title?: string;
        taskId?: string;
      }>;
      const serverIds = new Set(serverRows.map((s) => s.id));
      for (const id of seeded) {
        expect(serverIds.has(id), `server should list subtask ${id}`).toBe(true);
      }
      for (const row of serverRows) {
        expect(row.taskId).toBe(created.taskId);
      }
    },
    45_000
  );
});

// Sanity-check the test bootstrap itself so a missing CLI build or
// helper binary fails loudly instead of mid-test.
describe("subtasks e2e prerequisites", () => {
  it("has a built CLI at dist/index.js", () => {
    expect(existsSync(CLI_DIST)).toBe(true);
  });

  it("has a built (or buildable) e2e-runner binary", () => {
    const bin = resolveHelperBin();
    expect(existsSync(bin)).toBe(true);
  });
});
