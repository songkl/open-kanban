// End-to-end test for the `kanban tasks list` command against a real
// Go HTTP server backed by an in-memory SQLite (the `kanban-e2e-runner`
// binary, built from `backend/cmd/e2e-runner`).
//
// The unit suite in src/commands/tasks.test.ts already covers the
// underlying `runTasksList` function via mocked fetch; this file
// proves the wired-up CLI binary -- the version users actually run --
// produces the same observable behaviour end-to-end. Specifically:
//
//   1. `kanban tasks list` (no filter) returns every seeded task
//      across the board, matching what GET /api/v1/columns embeds.
//   2. `--column <id>` narrows the result to the targeted column.
//   3. `--board <id>` scopes the result to a single board.
//   4. `--search <query>`, `--priority <p>`, `--assignee <user>`
//      filter the list client-side over the embedded columns payload.
//   5. `--output json` and `--output table` produce both supported
//      output formats end-to-end.
//   6. Mutually-exclusive flag combinations (`--column` + `--status`)
//      are rejected with a non-zero exit code and a stderr hint.
//
// The seed columns use English names ("Todo" / "Doing" / "Review" /
// "Done") so `--status in_progress` cannot resolve to a column via the
// Chinese name map in src/commands/tasks.ts. The unit suite already
// covers the `--status` resolution against the Chinese-named
// `COLUMNS_PAYLOAD` fixture, so this e2e file focuses on the
// other surfaces. The mutually-exclusive case still proves the
// argument-validation path is wired up at the CLI layer.
//
// The test follows the same OAuth-bypass shortcut the runner suite
// uses: it writes the seeded bot-user bearer directly into the CLI's
// credential file so the CLI's request reaches the helper's
// RequireAuth middleware without spinning up a real device-flow.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { FileSecretProvider, type StoredCredentials } from "../../src/auth/token-store.js";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const CLI_DIST = join(REPO_ROOT, "cli", "dist", "index.js");
const BACKEND_DIR = join(REPO_ROOT, "backend");
const HELPER_DEFAULT_BIN = join(BACKEND_DIR, "bin", "kanban-e2e-runner");

const SEED_BOARD_ID = "b-tasks-list";
const SEED_TODO_COLUMN_ID = "c-e2e-todo";
const SEED_DOING_COLUMN_ID = "c-e2e-doing";
const SEED_TASKS = ["t-e2e-first", "t-e2e-second"] as const;

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
      rejectReady(
        new Error(`helper exited early (code=${code}) before ${pattern}; log:\n${buffer}`)
      );
    });
  });
}

async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = 18400 + Math.floor(Math.random() * 1000);
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
    clientId: "e2e-tasks-list",
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

interface TasksListResponse {
  apiUrl?: string;
  boardId?: string;
  columnId?: string;
  status?: string;
  tasks: Array<{
    id?: string;
    title?: string;
    priority?: string | null;
    assignee?: string | null;
    columnId?: string;
    createdAt?: string;
  }>;
}

const helperBin = resolveHelperBin();

describe("CLI `kanban tasks list` e2e (against a real Go server)", () => {
  let workDir: string;
  let xdgHome: string;
  let helper: HelperHandle | null = null;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "kanban-tasks-list-"));
    xdgHome = mkdtempSync(join(tmpdir(), "kanban-tasks-list-xdg-"));
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

  async function startHelperWithBot(): Promise<string> {
    const port = await freePort();
    helper = await startHelper(port, helperBin, join(workDir, "helper.log"));
    const apiUrl = helper.apiUrl;
    writeBotCredentials({
      apiUrl,
      tokenFilePath: credentialsPath(apiUrl, xdgHome),
    });
    return apiUrl;
  }

  it(
    "lists every seeded task with no filter (--output json)",
    async () => {
      const apiUrl = await startHelperWithBot();

      const result = await runCli({
        cwd: workDir,
        args: ["tasks", "list", "--output", "json"],
        env: { KANBAN_API_URL: apiUrl, XDG_CONFIG_HOME: xdgHome },
      });

      // eslint-disable-next-line no-console
      console.log("kanban tasks list stdout:\n" + result.stdout);
      // eslint-disable-next-line no-console
      console.log("kanban tasks list stderr:\n" + result.stderr);

      expect(
        result.code,
        `CLI exited with non-zero status.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
      ).toBe(0);

      const parsed = JSON.parse(result.stdout) as TasksListResponse;
      const ids = parsed.tasks.map((t) => t.id).sort();
      expect(ids).toEqual([...SEED_TASKS].sort());
      // The default projection is id / title / priority / assignee /
      // createdAt -- none of columnId / description.
      for (const task of parsed.tasks) {
        expect(Object.keys(task).sort()).toEqual([
          "assignee",
          "createdAt",
          "id",
          "priority",
          "title",
        ]);
      }
    },
    30_000
  );

  it(
    "filters by --column id and the result contains only that column's tasks",
    async () => {
      const apiUrl = await startHelperWithBot();

      const result = await runCli({
        cwd: workDir,
        args: [
          "tasks",
          "list",
          "--column",
          SEED_TODO_COLUMN_ID,
          "--output",
          "json",
        ],
        env: { KANBAN_API_URL: apiUrl, XDG_CONFIG_HOME: xdgHome },
      });
      expect(result.code).toBe(0);
      const parsed = JSON.parse(result.stdout) as TasksListResponse;
      expect(parsed.columnId).toBe(SEED_TODO_COLUMN_ID);
      const ids = parsed.tasks.map((t) => t.id).sort();
      expect(ids).toEqual([...SEED_TASKS].sort());
    },
    30_000
  );

  it(
    "returns an empty list when --column targets an empty column",
    async () => {
      const apiUrl = await startHelperWithBot();

      const result = await runCli({
        cwd: workDir,
        args: [
          "tasks",
          "list",
          "--column",
          SEED_DOING_COLUMN_ID,
          "--output",
          "json",
        ],
        env: { KANBAN_API_URL: apiUrl, XDG_CONFIG_HOME: xdgHome },
      });
      expect(result.code).toBe(0);
      const parsed = JSON.parse(result.stdout) as TasksListResponse;
      expect(parsed.tasks).toEqual([]);
    },
    30_000
  );

  it(
    "scopes by --board id and matches the embedded columns payload",
    async () => {
      const apiUrl = await startHelperWithBot();

      const result = await runCli({
        cwd: workDir,
        args: [
          "tasks",
          "list",
          "--board",
          SEED_BOARD_ID,
          "--output",
          "json",
        ],
        env: { KANBAN_API_URL: apiUrl, XDG_CONFIG_HOME: xdgHome },
      });
      expect(result.code).toBe(0);
      const parsed = JSON.parse(result.stdout) as TasksListResponse;
      expect(parsed.boardId).toBe(SEED_BOARD_ID);
      const ids = parsed.tasks.map((t) => t.id).sort();
      expect(ids).toEqual([...SEED_TASKS].sort());
    },
    30_000
  );

  it(
    "filters by --search substring across title and description",
    async () => {
      const apiUrl = await startHelperWithBot();

      const firstOnly = await runCli({
        cwd: workDir,
        args: [
          "tasks",
          "list",
          "--search",
          "First",
          "--output",
          "json",
        ],
        env: { KANBAN_API_URL: apiUrl, XDG_CONFIG_HOME: xdgHome },
      });
      expect(firstOnly.code).toBe(0);
      const parsed = JSON.parse(firstOnly.stdout) as TasksListResponse;
      expect(parsed.tasks.map((t) => t.id)).toEqual(["t-e2e-first"]);

      // The description of both seeded tasks contains the same
      // substring; verify the search spans description as well.
      const both = await runCli({
        cwd: workDir,
        args: [
          "tasks",
          "list",
          "--search",
          "seeded for runner e2e",
          "--output",
          "json",
        ],
        env: { KANBAN_API_URL: apiUrl, XDG_CONFIG_HOME: xdgHome },
      });
      expect(both.code).toBe(0);
      const parsedBoth = JSON.parse(both.stdout) as TasksListResponse;
      expect(parsedBoth.tasks.map((t) => t.id).sort()).toEqual(
        [...SEED_TASKS].sort()
      );
    },
    30_000
  );

  it(
    "filters by --priority and --assignee",
    async () => {
      const apiUrl = await startHelperWithBot();

      const byPriority = await runCli({
        cwd: workDir,
        args: [
          "tasks",
          "list",
          "--priority",
          "medium",
          "--output",
          "json",
        ],
        env: { KANBAN_API_URL: apiUrl, XDG_CONFIG_HOME: xdgHome },
      });
      expect(byPriority.code).toBe(0);
      const parsed = JSON.parse(byPriority.stdout) as TasksListResponse;
      expect(parsed.tasks.map((t) => t.id).sort()).toEqual(
        [...SEED_TASKS].sort()
      );

      const byAssignee = await runCli({
        cwd: workDir,
        args: [
          "tasks",
          "list",
          "--assignee",
          "e2e-bot",
          "--output",
          "json",
        ],
        env: { KANBAN_API_URL: apiUrl, XDG_CONFIG_HOME: xdgHome },
      });
      expect(byAssignee.code).toBe(0);
      const parsedAssignee = JSON.parse(byAssignee.stdout) as TasksListResponse;
      expect(parsedAssignee.tasks.map((t) => t.id).sort()).toEqual(
        [...SEED_TASKS].sort()
      );

      const noMatch = await runCli({
        cwd: workDir,
        args: [
          "tasks",
          "list",
          "--priority",
          "high",
          "--output",
          "json",
        ],
        env: { KANBAN_API_URL: apiUrl, XDG_CONFIG_HOME: xdgHome },
      });
      expect(noMatch.code).toBe(0);
      const parsedNoMatch = JSON.parse(noMatch.stdout) as TasksListResponse;
      expect(parsedNoMatch.tasks).toEqual([]);
    },
    30_000
  );

  it(
    "renders a table with --output table and a header line containing the apiUrl",
    async () => {
      const apiUrl = await startHelperWithBot();

      const result = await runCli({
        cwd: workDir,
        args: ["tasks", "list", "--output", "table"],
        env: { KANBAN_API_URL: apiUrl, XDG_CONFIG_HOME: xdgHome },
      });
      expect(result.code).toBe(0);
      // Header line is `Tasks  <apiUrl>  ...` from formatTasksTable.
      expect(result.stdout).toContain("Tasks");
      expect(result.stdout).toContain(apiUrl);
      // Each seeded task id should appear in the rendered table.
      for (const id of SEED_TASKS) {
        expect(result.stdout).toContain(id);
      }
    },
    30_000
  );

  it(
    "rejects --column and --status supplied together",
    async () => {
      const apiUrl = await startHelperWithBot();

      const result = await runCli({
        cwd: workDir,
        args: [
          "tasks",
          "list",
          "--column",
          SEED_TODO_COLUMN_ID,
          "--status",
          "todo",
        ],
        env: { KANBAN_API_URL: apiUrl, XDG_CONFIG_HOME: xdgHome },
      });

      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(
        /--column|--status|mutually exclusive|only one/i
      );
    },
    30_000
  );

  it(
    "rejects an invalid --priority value with a non-zero exit code",
    async () => {
      const apiUrl = await startHelperWithBot();

      const result = await runCli({
        cwd: workDir,
        args: ["tasks", "list", "--priority", "urgent"],
        env: { KANBAN_API_URL: apiUrl, XDG_CONFIG_HOME: xdgHome },
      });

      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/--priority|invalid|allowed/i);
    },
    30_000
  );

  it(
    "the listed task ids match the embedded /api/v1/columns payload",
    async () => {
      // Sanity check: the CLI's --output json result must agree with
      // the public columns endpoint, so the client-side filter is
      // not silently dropping rows.
      const apiUrl = await startHelperWithBot();

      const cliResult = await runCli({
        cwd: workDir,
        args: ["tasks", "list", "--output", "json"],
        env: { KANBAN_API_URL: apiUrl, XDG_CONFIG_HOME: xdgHome },
      });
      expect(cliResult.code).toBe(0);
      const cli = JSON.parse(cliResult.stdout) as TasksListResponse;

      const apiResult = await fetchJson(`${apiUrl}/api/v1/columns`);
      expect(apiResult.status).toBe(200);
      const columns = apiResult.body as Array<{
        id?: string;
        tasks?: Array<{ id?: string }>;
      }>;
      const apiIds = columns
        .flatMap((c) => c.tasks ?? [])
        .map((t) => t.id)
        .sort();

      expect(cli.tasks.map((t) => t.id).sort()).toEqual(apiIds);
      // eslint-disable-next-line no-console
      console.log("helper log:\n" + readFileSync(helper!.logFile, "utf8"));
    },
    30_000
  );
});

// Sanity-check the test bootstrap itself so a missing CLI build or
// helper binary fails loudly instead of mid-test.
describe("tasks-list e2e prerequisites", () => {
  it("has a built CLI at dist/index.js", () => {
    expect(existsSync(CLI_DIST)).toBe(true);
  });

  it("has a built (or buildable) e2e-runner binary", () => {
    const bin = resolveHelperBin();
    expect(existsSync(bin)).toBe(true);
  });
});
