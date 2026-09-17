// End-to-end test for the `kanban boards list` / `kanban columns list`
// commands against a real Go HTTP server backed by an in-memory SQLite
// (the `kanban-e2e-runner` binary, built from
// `backend/cmd/e2e-runner`).
//
// The unit suites in src/commands/boards.test.ts and
// src/commands/columns.test.ts already cover `runBoardsList` /
// `runColumnsList` with mocked fetch; this file proves the wired-up CLI
// binary — the version users actually run — produces the same observable
// behaviour end-to-end. Specifically:
//
//   1. `kanban boards list --output json` exits 0, GETs
//      /api/v1/boards, and prints the seeded board (id + name +
//      createdAt — the default projection).
//   2. `kanban boards list --fields id,name,columnCount --output json`
//      honours the `--fields` projection end-to-end and reports the
//      seeded board's column count (4) via the `_count.columns`
//      summary the backend emits alongside every board.
//   3. `kanban boards list` (default table output) renders the seeded
//      board name + id inside a table-shaped string with the `Boards`
//      header line, proving the table renderer is wired through the
//      CLI bootstrap layer.
//   4. `kanban columns list --board <id> --output json` filters by
//      boardId, GETs /api/v1/columns?boardId=<id>, and prints the four
//      seeded columns (待办 / 进行中 / 待审核 / 已完成) with the right
//      positions + statuses.
//   5. The id returned by `boards list` matches the boardId embedded
//      in every row of the filtered `columns list` response, proving
//      cross-command consistency.
//   6. The server-side `/api/v1/boards` endpoint agrees with the CLI's
//      view (same id + name), so the CLI isn't silently trimming rows
//      or re-shaping the payload.
//
// The `boards` and `columns` GET endpoints are both registered before
// `RequireAuth` in cmd/server/main.go, so the CLI reaches them
// without a real OAuth bearer. The seed e2e-runner still requires a
// bot credential for any future auth-gated writes (e.g. to add
// additional boards via the API), so we write one into the
// FileSecretProvider-shaped credential file just like the other e2e
// tests — it is unused by the read paths exercised below.
//
// The helper binary is rebuilt by the suite via `go build`; CI can
// override the path with `KANBAN_E2E_RUNNER_BIN` to skip the build.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { FileSecretProvider, type StoredCredentials } from "../../src/auth/token-store.js";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const CLI_DIST = join(REPO_ROOT, "cli", "dist", "index.js");
const BACKEND_DIR = join(REPO_ROOT, "backend");
const HELPER_DEFAULT_BIN = join(BACKEND_DIR, "bin", "kanban-e2e-runner");

const SEED_BOARD_ID = "b-boards-list";
// Column ids come from the e2e-runner seed (cmd/e2e-runner/main.go).
// They are board-agnostic: every run of the helper uses these ids
// regardless of the --board flag.
const SEED_COLUMN_IDS = [
  "c-e2e-todo",
  "c-e2e-doing",
  "c-e2e-review",
  "c-e2e-done",
] as const;

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
    const port = 18700 + Math.floor(Math.random() * 1000);
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
    clientId: "e2e-boards-list",
    clientName: "open-kanban-cli",
    accessToken: "e2e-agent-token",
    accessExpiresAt: Date.now() + 60 * 60 * 1000,
    scope: "kanban:read boards:read columns:read",
  };
  provider.write(creds);
}

interface HelperHandle {
  proc: ChildProcess;
  apiUrl: string;
  adminToken: string;
  cleanup(): Promise<void>;
}

async function startHelper(port: number, bin: string): Promise<HelperHandle> {
  const proc = spawn(bin, ["--port", String(port), "--board", SEED_BOARD_ID], {
    cwd: REPO_ROOT,
    env: { ...process.env, GIN_MODE: "debug" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ready = await waitForLog(proc, /READY (http:\/\/[^\s]+) (\S+)/);
  const m = ready.match(/READY (http:\/\/[^\s]+) (\S+)/);
  if (!m) throw new Error(`could not parse READY line: ${ready}`);
  return {
    proc,
    apiUrl: m[1],
    adminToken: m[2],
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

interface BoardsListResponse {
  apiUrl?: string;
  boards: Array<{
    id?: string;
    name?: string;
    description?: string;
    createdAt?: string;
    _count?: { columns?: number };
  }>;
}

interface ColumnsListResponse {
  apiUrl?: string;
  boardId?: string;
  positions?: number[];
  columns: Array<{
    id?: string;
    name?: string;
    boardId?: string;
    position?: number;
    status?: string | null;
  }>;
}

const helperBin = resolveHelperBin();

describe("CLI `kanban boards list` / `kanban columns list` e2e (against a real Go server)", () => {
  let workDir: string;
  let xdgHome: string;
  let helper: HelperHandle | null = null;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "kanban-boards-list-"));
    xdgHome = mkdtempSync(join(tmpdir(), "kanban-boards-list-xdg-"));
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
    helper = await startHelper(port, helperBin);
    const apiUrl = helper.apiUrl;
    writeBotCredentials({
      apiUrl,
      tokenFilePath: credentialsPath(apiUrl, xdgHome),
    });
    return apiUrl;
  }

  it(
    "boards list --output json returns the seeded board with the default projection",
    async () => {
      const apiUrl = await startHelperWithBot();

      const result = await runCli({
        cwd: workDir,
        args: ["boards", "list", "--output", "json"],
        env: { KANBAN_API_URL: apiUrl, XDG_CONFIG_HOME: xdgHome },
      });

      expect(
        result.code,
        `CLI exited with non-zero status.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
      ).toBe(0);

      const parsed = JSON.parse(result.stdout) as BoardsListResponse;
      expect(parsed.apiUrl).toBe(apiUrl);
      expect(parsed.boards).toHaveLength(1);
      const board = parsed.boards[0];
      expect(board.id).toBe(SEED_BOARD_ID);
      expect(board.name).toBe("E2E Board");
      // The default field projection is id / name / createdAt, so
      // the response must NOT contain other backend fields like
      // description or _count.
      expect(Object.keys(board).sort()).toEqual(["createdAt", "id", "name"]);
      expect(typeof board.createdAt).toBe("string");
    },
    30_000
  );

  it(
    "boards list honours --fields id,name,columnCount and reports the seeded column count",
    async () => {
      const apiUrl = await startHelperWithBot();

      const result = await runCli({
        cwd: workDir,
        args: [
          "boards",
          "list",
          "--fields",
          "id,name,columnCount",
          "--output",
          "json",
        ],
        env: { KANBAN_API_URL: apiUrl, XDG_CONFIG_HOME: xdgHome },
      });
      expect(result.code).toBe(0);

      const parsed = JSON.parse(result.stdout) as BoardsListResponse;
      expect(parsed.boards).toHaveLength(1);
      const board = parsed.boards[0];
      expect(Object.keys(board).sort()).toEqual(["_count", "id", "name"]);
      expect(board.id).toBe(SEED_BOARD_ID);
      expect(board.name).toBe("E2E Board");
      // The seed inserts 4 columns under the seeded board.
      expect(board._count?.columns).toBe(4);
    },
    30_000
  );

  it(
    "boards list (default table output) renders the seeded board name and id",
    async () => {
      const apiUrl = await startHelperWithBot();

      const result = await runCli({
        cwd: workDir,
        args: ["boards", "list"],
        env: { KANBAN_API_URL: apiUrl, XDG_CONFIG_HOME: xdgHome },
      });
      expect(result.code).toBe(0);

      // The table renderer's header line is `Boards  <apiUrl>  ...`
      // (see formatBoardsTable in boards.ts). The seeded board's
      // id and name must appear inside the rendered table.
      expect(result.stdout).toContain("Boards");
      expect(result.stdout).toContain(apiUrl);
      expect(result.stdout).toContain(SEED_BOARD_ID);
      expect(result.stdout).toContain("E2E Board");
      // cli-table3 emits box-drawing characters for the header row;
      // the absence of `┌` would mean the table renderer was bypassed.
      expect(result.stdout).toContain("┌");
    },
    30_000
  );

  it(
    "columns list --board <id> --output json returns the 4 seeded columns",
    async () => {
      const apiUrl = await startHelperWithBot();

      const result = await runCli({
        cwd: workDir,
        args: [
          "columns",
          "list",
          "--board",
          SEED_BOARD_ID,
          "--output",
          "json",
        ],
        env: { KANBAN_API_URL: apiUrl, XDG_CONFIG_HOME: xdgHome },
      });

      expect(
        result.code,
        `CLI exited with non-zero status.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
      ).toBe(0);

      const parsed = JSON.parse(result.stdout) as ColumnsListResponse;
      expect(parsed.apiUrl).toBe(apiUrl);
      expect(parsed.boardId).toBe(SEED_BOARD_ID);
      expect(parsed.columns).toHaveLength(4);

      const ids = parsed.columns.map((c) => c.id).sort();
      expect(ids).toEqual([...SEED_COLUMN_IDS].sort());

      // The seed assigns positions 0..3 with the documented status
      // values; assert the projection preserves them so callers can
      // rely on the default fields when rendering the board.
      const byId = new Map(parsed.columns.map((c) => [c.id, c]));
      expect(byId.get("c-e2e-todo")?.position).toBe(0);
      expect(byId.get("c-e2e-todo")?.status).toBe("todo");
      expect(byId.get("c-e2e-doing")?.position).toBe(1);
      expect(byId.get("c-e2e-doing")?.status).toBe("in_progress");
      expect(byId.get("c-e2e-review")?.position).toBe(2);
      expect(byId.get("c-e2e-review")?.status).toBe("review");
      expect(byId.get("c-e2e-done")?.position).toBe(3);
      expect(byId.get("c-e2e-done")?.status).toBe("done");
      for (const c of parsed.columns) {
        expect(c.boardId).toBe(SEED_BOARD_ID);
      }
    },
    30_000
  );

  it(
    "the board id from boards list matches the boardId embedded in every columns list row",
    async () => {
      const apiUrl = await startHelperWithBot();

      const boardsRes = await runCli({
        cwd: workDir,
        args: ["boards", "list", "--output", "json"],
        env: { KANBAN_API_URL: apiUrl, XDG_CONFIG_HOME: xdgHome },
      });
      expect(boardsRes.code).toBe(0);
      const boards = JSON.parse(boardsRes.stdout) as BoardsListResponse;
      expect(boards.boards).toHaveLength(1);
      const boardId = boards.boards[0].id;
      expect(boardId).toBeTruthy();

      const columnsRes = await runCli({
        cwd: workDir,
        args: [
          "columns",
          "list",
          "--board",
          boardId!,
          "--output",
          "json",
        ],
        env: { KANBAN_API_URL: apiUrl, XDG_CONFIG_HOME: xdgHome },
      });
      expect(columnsRes.code).toBe(0);
      const columns = JSON.parse(columnsRes.stdout) as ColumnsListResponse;
      expect(columns.columns.length).toBeGreaterThan(0);
      for (const c of columns.columns) {
        expect(c.boardId).toBe(boardId);
      }
    },
    30_000
  );

  it(
    "the CLI's boards list output matches the public /api/v1/boards endpoint",
    async () => {
      const apiUrl = await startHelperWithBot();

      const cliRes = await runCli({
        cwd: workDir,
        args: ["boards", "list", "--output", "json"],
        env: { KANBAN_API_URL: apiUrl, XDG_CONFIG_HOME: xdgHome },
      });
      expect(cliRes.code).toBe(0);
      const cli = JSON.parse(cliRes.stdout) as BoardsListResponse;

      const apiRes = await fetchJson(`${apiUrl}/api/v1/boards`);
      expect(apiRes.status).toBe(200);
      const rawBoards = apiRes.body as Array<{
        id?: string;
        name?: string;
        createdAt?: string;
      }>;
      expect(rawBoards).toHaveLength(1);
      // The CLI projects to id / name / createdAt, so the relevant
      // subset of the server payload must agree with the CLI output.
      const fromServer = rawBoards[0];
      const fromCli = cli.boards[0];
      expect(fromCli.id).toBe(fromServer.id);
      expect(fromCli.name).toBe(fromServer.name);
      expect(fromCli.createdAt).toBe(fromServer.createdAt);
    },
    30_000
  );
});

// Sanity-check the test bootstrap itself so a missing CLI build or
// helper binary fails loudly instead of mid-test.
describe("boards list / columns list e2e prerequisites", () => {
  it("has a built CLI at dist/index.js", () => {
    expect(existsSync(CLI_DIST)).toBe(true);
  });

  it("has a built (or buildable) e2e-runner binary", () => {
    const bin = resolveHelperBin();
    expect(existsSync(bin)).toBe(true);
  });
});
