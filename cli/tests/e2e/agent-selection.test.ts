// End-to-end integration test for the device-flow-with-agent-selection path
// (plan §4.6 in devDoc/DEVICE_AUTH_AGENT_SELECTION_PLAN_2026-09-13.md).
//
// This test wires together the same three moving parts the runner suite
// exercises — a real Go HTTP server backed by an in-memory SQLite
// (`kanban-e2e-runner`, built from `backend/cmd/e2e-runner`), the
// compiled `kanban` CLI, and a helper-only auto-approve endpoint — but
// adds the device-flow agent-selection affordance on top:
//
//   1. The helper seeds an ADMIN human (u-e2e-admin, already present
//      for the runner suite), a MEMBER human (u-e2e-member, new), and
//      a MEMBER Agent (u-e2e-agent, new). The two new users get WRITE
//      board permissions so /api/v1/runs/claim succeeds for the
//      resulting JWT.
//   2. We run `kanban auth login` through the CLI wrapper. The CLI
//      drives the OAuth 2.1 device flow (DCR → device code → poll)
//      just like the runner suite does, except we no longer bypass
//      OAuth — the access token it persists is a real JWT.
//   3. In parallel with the CLI's poll loop we POST to
//      `/__test__/auto-approve` with an `agent_id` body field. The
//      helper binds the pending device code to that Agent identity,
//      which mirrors what the real `/oauth/device/approve` handler
//      does when a human approver selects "Authorise as <Agent>"
//      from the identity picker. The CLI's next poll sees `approved`
//      and returns the access token.
//   4. We decode the access-token JWT (it's `header.payload.signature`
//      base64url) and assert `payload.sub === agent.id`. This is the
//      server-side proof the device flow actually bound to the Agent
//      — a JWT minted for a human approver would carry the human's
//      id, not the Agent's, and the test would fail.
//   5. We POST `/api/v1/runs/claim` with the new bearer, asserting
//      200. This proves the JWT round-trips end-to-end through the
//      auth middleware's `getCurrentUserFromRequest` path (which is
//      what real CLI runners hit after device-flow login).
//
// Why a dedicated test instead of a new case in `runner.test.ts`?
// The runner suite bakes the agent-token bearer directly into the
// credential file to skip OAuth — that's a deliberate shortcut so the
// claim/heartbeat/finish plumbing can be tested in isolation. This
// test deliberately does NOT skip OAuth: the whole point is to assert
// the OAuth device flow + identity picker → JWT → /runs/claim chain
// stays consistent. Keeping the two suites in separate files makes
// their contracts easier to read.
//
// The helper binary is rebuilt by the suite via `go build`; CI can
// override the path with `KANBAN_E2E_RUNNER_BIN` to skip the build.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { FileSecretProvider } from "../../src/auth/token-store.js";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const CLI_DIST = join(REPO_ROOT, "cli", "dist", "index.js");
const BACKEND_DIR = join(REPO_ROOT, "backend");
const HELPER_DEFAULT_BIN = join(BACKEND_DIR, "bin", "kanban-e2e-runner");

const SEED_BOARD_ID = "b-e2e-agent";
const SEED_AGENT_ID = "u-e2e-agent";
const SEED_MEMBER_ID = "u-e2e-member";
const SEED_ADMIN_ID = "u-e2e-admin";

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
    const port = 18200 + Math.floor(Math.random() * 1000);
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
  // Build on demand so a fresh checkout works without an explicit
  // helper-build step. The build target mirrors the runner suite's
  // convention so the two suites share the same binary.
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

async function fetchJson(url: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
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
  // Splice every chunk the helper writes into the log file so a
  // failing assertion can dump the helper's logs without re-running.
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

// authLoginWithAgentApproval runs `kanban auth login` against the
// helper and triggers /__test__/auto-approve with an `agent_id` body
// field in the background so the CLI's device-flow poll resolves
// quickly. The auto-approve loop ticks every 100ms; this avoids
// racing the CLI's first /oauth/device/code call.
async function authLoginWithAgentApproval(opts: {
  cwd: string;
  apiUrl: string;
  xdgHome: string;
  helperAdminToken: string;
  agentId: string;
}): Promise<{ code: number; stdout: string; stderr: string }> {
  const approveEvery = 100;
  const stop = { v: false };
  const approver = (async () => {
    while (!stop.v) {
      try {
        await fetchJson(`${opts.apiUrl}/__test__/auto-approve`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Test-Token": opts.helperAdminToken,
          },
          body: JSON.stringify({ agent_id: opts.agentId }),
        });
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

function credentialsPath(apiUrl: string, xdgHome: string): string {
  // Mirror defaultFilePath() in src/auth/token-store.ts but accept
  // the XDG root explicitly so the path resolves correctly even when
  // the test process itself doesn't have XDG_CONFIG_HOME set.
  const safe = apiUrl.replace(/[^a-z0-9]+/gi, "_").toLowerCase();
  const base = xdgHome || process.env.XDG_CONFIG_HOME || join(process.env.HOME || "~", ".config");
  return join(base, "kanban-cli", `credentials-${safe}.json`);
}

// decodeJwtPayload parses the middle segment of a `header.payload.signature`
// JWT and returns the decoded payload object. We only verify the `sub`
// claim in this test; the signature check is the server's job (the
// access token was minted by the helper's signer and verified on
// every subsequent request). The test intentionally does NOT verify
// the signature locally because doing so would duplicate the
// production verifier — the point is to read the claim, not to
// re-validate the token.
function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) {
    throw new Error(`expected 3-part JWT, got ${parts.length} parts`);
  }
  const payload = parts[1];
  const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
  const json = Buffer.from(padded, "base64url").toString("utf8");
  return JSON.parse(json) as Record<string, unknown>;
}

const helperBin = resolveHelperBin();

describe("CLI e2e device-flow with agent-selection", () => {
  let workDir: string;
  let xdgHome: string;
  let helper: HelperHandle | null = null;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "kanban-agent-selection-e2e-"));
    xdgHome = mkdtempSync(join(tmpdir(), "kanban-agent-selection-xdg-"));
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
    "binds the issued JWT to the Agent and lets it claim a run",
    async () => {
      const port = await freePort();
      helper = await startHelper(port, helperBin, join(workDir, "helper.log"));
      const apiUrl = helper.apiUrl;

      // Drive the CLI device flow. The approver loop POSTs the
      // helper's auto-approve endpoint with `agent_id` so the
      // device code binds to the Agent identity. The CLI never
      // sees the agent_id — it just polls until the device code
      // is approved, then writes whatever access token the server
      // hands back into the credentials file.
      const result = await authLoginWithAgentApproval({
        cwd: workDir,
        apiUrl,
        xdgHome,
        helperAdminToken: helper.adminToken,
        agentId: SEED_AGENT_ID,
      });
      expect(result.code, `CLI exited non-zero.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
      expect(result.stdout).toMatch(/Logged in to/);

      // Read the credentials file the CLI wrote. The access token
      // is a JWT minted by the helper's signer with `sub =
      // <bound user id>` — when the auto-approve supplied
      // agent_id, the bound user is the Agent, not the approver.
      //
      // The CLI's FileSecretProvider encrypts the access token at
      // rest (it's just `enc`/`salt`/`iv`/`tag` on disk), so we
      // route the read back through the provider instead of
      // parsing the JSON directly — `provider.read()` handles the
      // decryption with the same key it used to write.
      const provider = new FileSecretProvider(credentialsPath(apiUrl, xdgHome));
      const creds = provider.read();
      expect(creds).not.toBeNull();
      expect(creds?.accessToken).toBeTruthy();
      const accessToken = creds!.accessToken as string;
      expect(accessToken).toMatch(/\./);

      // Decode the JWT payload. The `sub` claim must equal the
      // Agent id; if the helper bound to the admin user by
      // mistake, this assertion fails loudly. Cross-validation:
      // the JWT bearer must NOT have been bound to either of the
      // human approvers. A regression where the helper stops
      // passing the agent_id body field would surface here — the
      // device code would fall back to the admin user (the
      // auto-approve endpoint's default binding).
      const payload = decodeJwtPayload(accessToken);
      expect(payload.sub).toBe(SEED_AGENT_ID);
      expect(payload.sub).not.toBe(SEED_ADMIN_ID);
      expect(payload.sub).not.toBe(SEED_MEMBER_ID);

      // Sanity: the JWT's client_id claim should match the DCR
      // registration id the CLI wrote into the credentials file.
      expect(payload.client_id).toBe(creds!.clientId);

      // Hit /api/v1/runs/claim with the same bearer. The Agent
      // has WRITE permission on the seeded board (added by the
      // helper's seed extension for this suite), and the column
      // `c-e2e-todo` is wired with agent_types=["opencode"] so
      // agentType=opencode matches FindEligibleTask's LIKE
      // patterns. The runner is essentially the CLI version of
      // a task creator; the 200 response is the proof the JWT
      // round-trips through the auth middleware, the
      // userHasBoardStatusWrite check, and the lock acquisition.
      const claim = await fetchJson(`${apiUrl}/api/v1/runs/claim`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          boardId: SEED_BOARD_ID,
          status: "todo",
          agentType: "opencode",
          runnerId: "agent-selection-e2e-runner",
          mode: "board",
          lockTimeoutMs: 5000,
        }),
      });
      // A 200 with `task` + `run` keys means the claim succeeded
      // and the runner is now the lock holder. Anything else —
      // 401 (bad JWT), 403 (no WRITE), 404/500 — is a failure
      // mode we want the test to surface.
      expect(claim.status).toBe(200);
      const claimBody = claim.body as { task: { id: string; columnId: string }; run: { runnerId: string } };
      expect(claimBody.task).toBeTruthy();
      expect(claimBody.task.id).toMatch(/^t-e2e-/);
      expect(claimBody.run.runnerId).toBe("agent-selection-e2e-runner");
    },
    30_000
  );
});

describe("agent-selection e2e prerequisites", () => {
  it("has a built CLI at dist/index.js", () => {
    expect(existsSync(CLI_DIST)).toBe(true);
  });

  it("has a built (or buildable) e2e-runner binary", () => {
    // resolveHelperBin() builds on demand; we just want to confirm
    // the path it returns exists after the call.
    const bin = resolveHelperBin();
    expect(existsSync(bin)).toBe(true);
  });
});