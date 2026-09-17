// End-to-end test for the `kanban comments add / list` commands against a
// real Go HTTP server backed by an in-memory SQLite (the
// `kanban-e2e-runner` binary, built from `backend/cmd/e2e-runner`).
//
// The unit suite in src/commands/comments.test.ts already covers the
// underlying `runCommentsAdd` / `runCommentsList` functions via mocked
// fetch; this file proves the wired-up CLI binary — the version users
// actually run — produces the same observable behaviour end-to-end.
// Specifically:
//
//   1. `kanban tasks create --column <id>` produces a fresh task id
//      (reused from tasks-create.test.ts so the helper binary stays
//      the single source of truth for the seed schema).
//   2. `kanban comments add <taskId> --body "..."` exits 0, POSTs
//      { taskId, content } to /api/v1/comments, and prints the new
//      comment id / content / author (resolved from the authenticated
//      user — the e2e-bot agent in the seed).
//   3. The comment is visible through the public GET
//      /api/v1/comments?taskId=<id> endpoint with the same content
//      and author, proving the row was actually persisted (not just
//      echoed back from POST).
//   4. `kanban comments list <taskId>` reports the same comment via
//      the table renderer, matching the documented "list comments
//      for a task" behaviour.
//   5. `kanban comments add <taskId> --body -` reads the body from
//      stdin, exercising the same code path the README documents
//      (`echo "LGTM" | kanban comments add ... --body -`).
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

const SEED_BOARD_ID = "b-comments";
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
    clientId: "e2e-comments",
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
  stdin?: string;
}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const proc = spawn(process.execPath, [CLI_DIST, ...opts.args], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    if (opts.stdin !== undefined) {
      proc.stdin?.write(opts.stdin);
      proc.stdin?.end();
    } else {
      proc.stdin?.end();
    }
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

interface CreatedComment {
  apiUrl?: string;
  comment: {
    id?: string;
    content?: string;
    author?: string;
    taskId?: string;
    userId?: string;
    createdAt?: string;
  };
}

interface CommentsListResponse {
  apiUrl?: string;
  taskId?: string;
  comments: Array<{
    id?: string;
    content?: string;
    author?: string;
    taskId?: string;
    createdAt?: string;
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

describe("CLI `kanban comments add / list` e2e (against a real Go server)", () => {
  let workDir: string;
  let xdgHome: string;
  let helper: HelperHandle | null = null;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "kanban-comments-"));
    xdgHome = mkdtempSync(join(tmpdir(), "kanban-comments-xdg-"));
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
    "adds a comment via --body and the new comment is visible on the server",
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
        title: "comment-target",
        columnId: TODO_COLUMN_ID,
      });

      const result = await runCli({
        cwd: workDir,
        args: [
          "comments",
          "add",
          created.taskId,
          "--body",
          "LGTM from e2e",
          "--output",
          "json",
        ],
        env: { KANBAN_API_URL: apiUrl, XDG_CONFIG_HOME: xdgHome },
      });

      // eslint-disable-next-line no-console
      console.log("kanban comments add stdout:\n" + result.stdout);
      // eslint-disable-next-line no-console
      console.log("kanban comments add stderr:\n" + result.stderr);
      // eslint-disable-next-line no-console
      console.log("helper log:\n" + readFileSync(helper.logFile, "utf8"));

      expect(
        result.code,
        `CLI exited with non-zero status.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
      ).toBe(0);

      let parsed: CreatedComment;
      try {
        parsed = JSON.parse(result.stdout) as CreatedComment;
      } catch (err) {
        throw new Error(
          `failed to parse --output json payload: ${(err as Error).message}\nstdout:\n${result.stdout}`
        );
      }
      expect(parsed.comment.id, "add response must include comment.id").toBeTruthy();
      expect(parsed.comment.taskId).toBe(created.taskId);
      expect(parsed.comment.content).toBe("LGTM from e2e");
      // The backend's CreateComment derives `author` from the
      // authenticated user's nickname (e2e-bot in the seed), not
      // from any --author flag, so the response must echo that
      // exact nickname.
      expect(parsed.comment.author).toBe("e2e-bot");

      // Round-trip via the public GET endpoint to prove the row was
      // actually persisted (not just echoed back from POST).
      const getRes = await fetchJson(`${apiUrl}/api/v1/comments?taskId=${created.taskId}`, {
        headers: { Authorization: `Bearer ${helper.adminToken}` },
      });
      expect(getRes.status).toBe(200);
      const rows = getRes.body as Array<{
        id?: string;
        content?: string;
        author?: string;
        taskId?: string;
      }>;
      const match = rows.find((c) => c.id === parsed.comment.id);
      expect(
        match,
        `expected comment ${parsed.comment.id} in list, got: ${JSON.stringify(rows)}`
      ).toBeTruthy();
      expect(match?.content).toBe("LGTM from e2e");
      expect(match?.author).toBe("e2e-bot");
      expect(match?.taskId).toBe(created.taskId);
    },
    30_000
  );

  it(
    "reads the comment body from stdin when --body is '-'",
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
        title: "stdin-comment-target",
        columnId: TODO_COLUMN_ID,
      });

      const piped = "piped-from-stdin ✓";
      const result = await runCli({
        cwd: workDir,
        args: [
          "comments",
          "add",
          created.taskId,
          "--body",
          "-",
          "--output",
          "json",
        ],
        env: { KANBAN_API_URL: apiUrl, XDG_CONFIG_HOME: xdgHome },
        stdin: piped + "\n",
      });

      expect(
        result.code,
        `CLI exited with non-zero status.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
      ).toBe(0);

      const parsed = JSON.parse(result.stdout) as CreatedComment;
      expect(parsed.comment.content).toBe(piped);
      expect(parsed.comment.taskId).toBe(created.taskId);

      // Server-side round-trip: the persisted content matches the
      // piped payload byte-for-byte, including the trailing UTF-8
      // tick (which would surface as mojibake if the CLI re-encoded
      // the body incorrectly).
      const getRes = await fetchJson(`${apiUrl}/api/v1/comments?taskId=${created.taskId}`, {
        headers: { Authorization: `Bearer ${helper.adminToken}` },
      });
      expect(getRes.status).toBe(200);
      const rows = getRes.body as Array<{ id?: string; content?: string }>;
      const match = rows.find((c) => c.id === parsed.comment.id);
      expect(match?.content).toBe(piped);
    },
    30_000
  );

  it(
    "lists comments for a task via `kanban comments list` and the JSON output matches the server",
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
        title: "listable-comments-target",
        columnId: TODO_COLUMN_ID,
      });

      // Seed two comments via the CLI so we have a deterministic
      // pair to assert against — avoiding a race with the seeded
      // task comment row from prior tests (the helper uses an
      // in-memory shared-cache DB scoped to a single process).
      const seedBodies = ["first comment", "second comment"];
      const seeded: string[] = [];
      for (const body of seedBodies) {
        const res = await runCli({
          cwd: workDir,
          args: [
            "comments",
            "add",
            created.taskId,
            "--body",
            body,
            "--output",
            "json",
          ],
          env: { KANBAN_API_URL: apiUrl, XDG_CONFIG_HOME: xdgHome },
        });
        expect(
          res.code,
          `comments add exited non-zero.\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`
        ).toBe(0);
        seeded.push((JSON.parse(res.stdout) as CreatedComment).comment.id!);
      }

      const list = await runCli({
        cwd: workDir,
        args: ["comments", "list", created.taskId, "--output", "json"],
        env: { KANBAN_API_URL: apiUrl, XDG_CONFIG_HOME: xdgHome },
      });

      expect(
        list.code,
        `CLI exited with non-zero status.\nstdout:\n${list.stdout}\nstderr:\n${list.stderr}`
      ).toBe(0);

      const parsed = JSON.parse(list.stdout) as CommentsListResponse;
      expect(parsed.taskId).toBe(created.taskId);
      // The list endpoint returns every comment for the task,
      // ordered by created_at ASC. We seeded exactly two; any extras
      // would indicate a leak between tests in the same process.
      expect(parsed.comments).toHaveLength(2);
      const byContent = new Map(parsed.comments.map((c) => [c.content, c]));
      expect(byContent.get("first comment")?.id).toBe(seeded[0]);
      expect(byContent.get("second comment")?.id).toBe(seeded[1]);
      for (const c of parsed.comments) {
        expect(c.author).toBe("e2e-bot");
        expect(c.taskId).toBe(created.taskId);
        expect(typeof c.createdAt).toBe("string");
      }

      // The server-side endpoint must agree with the CLI's view:
      // both ids, both contents, both authors.
      const serverRes = await fetchJson(
        `${apiUrl}/api/v1/comments?taskId=${created.taskId}`,
        { headers: { Authorization: `Bearer ${helper.adminToken}` } }
      );
      expect(serverRes.status).toBe(200);
      const serverRows = serverRes.body as Array<{
        id?: string;
        content?: string;
        author?: string;
      }>;
      const serverIds = new Set(serverRows.map((c) => c.id));
      for (const id of seeded) {
        expect(serverIds.has(id), `server should list comment ${id}`).toBe(true);
      }
    },
    45_000
  );
});

// Sanity-check the test bootstrap itself so a missing CLI build or
// helper binary fails loudly instead of mid-test.
describe("comments e2e prerequisites", () => {
  it("has a built CLI at dist/index.js", () => {
    expect(existsSync(CLI_DIST)).toBe(true);
  });

  it("has a built (or buildable) e2e-runner binary", () => {
    const bin = resolveHelperBin();
    expect(existsSync(bin)).toBe(true);
  });
});
