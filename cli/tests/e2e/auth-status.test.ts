// End-to-end integration test for the `kanban auth` command family:
//
//   - `kanban auth status`
//   - `kanban auth login`
//   - `kanban auth logout`
//
// The unit suites in src/auth/commands.test.ts cover the inner
// `runStatus` / `runLogin` / `runLogout` functions with mocked fetch and
// token-store; this file proves the wired-up CLI binary — the version
// users actually run — produces the same observable behaviour
// end-to-end against a real OAuth server. Specifically:
//
//   1. `kanban auth status` against a fresh XDG_CONFIG_HOME exits with
//      the documented "not logged in" code (2), prints the "Run
//      'kanban auth login' first" hint, and writes nothing to the
//      credentials file.
//   2. `kanban auth login` drives the OAuth 2.1 device flow against
//      the helper, persists the issued access token (and refresh
//      token) into the FileSecretProvider-shaped credential file, and
//      prints the "Logged in to ..." confirmation on stdout.
//   3. `kanban auth status` after login exits 0, prints the formatted
//      status report (host, client id, scope, access-token lifetime,
//      identity) sourced from the same credentials file the login
//      step wrote. The output must mention the host URL and the
//      client id returned by DCR so the user can verify the binding.
//   4. `kanban auth logout` clears the credential file and exits 0;
//      running it a second time is idempotent (still exit 0, prints
//      "nothing to do") so a stray script invocation cannot break
//      automation.
//   5. After `kanban auth logout`, `kanban auth status` returns to
//      the not-logged-in state: same exit code, same hint. The full
//      status → login → status → logout → status round-trip closes
//      cleanly so a regression where logout fails to clear the file
//      (or where login overwrites without honouring the prior state)
//      surfaces here.
//   6. The persisted credentials file after login has the structure
//      the production `kanban auth status` reader expects: apiUrl
//      matches the helper, clientId is a non-empty string, and
//      accessToken / refreshToken are present. A regression where
//      FileSecretProvider stops serialising those fields would
//      silently break every other auth-gated CLI command, so we
//      assert directly on the decrypted JSON.
//
// The helper binary is rebuilt by the suite via `go build`; CI can
// override the path with `KANBAN_E2E_RUNNER_BIN` to skip the build.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { FileSecretProvider } from "../../src/auth/token-store.js";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const CLI_DIST = join(REPO_ROOT, "cli", "dist", "index.js");
const BACKEND_DIR = join(REPO_ROOT, "backend");
const HELPER_DEFAULT_BIN = join(REPO_ROOT, "backend", "bin", "kanban-e2e-runner");

const SEED_BOARD_ID = "b-auth-status";

async function waitForLog(
  proc: ChildProcess,
  pattern: RegExp,
  timeoutMs = 15_000
): Promise<string> {
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
  // Mirror defaultFilePath() in src/auth/token-store.ts but accept
  // the XDG root explicitly so the path resolves correctly even when
  // the test process itself doesn't have XDG_CONFIG_HOME set.
  const safe = apiUrl.replace(/[^a-z0-9]+/gi, "_").toLowerCase();
  const base = xdgHome || process.env.XDG_CONFIG_HOME || join(process.env.HOME || "~", ".config");
  return join(base, "kanban-cli", `credentials-${safe}.json`);
}

async function fetchJson(
  url: string,
  init: RequestInit = {}
): Promise<{ status: number; body: unknown }> {
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

// authLoginCli runs `kanban auth login` against the helper and triggers
// `/__test__/auto-approve` in the background so the CLI's device-flow
// poll resolves quickly. The auto-approve loop ticks every 100ms; this
// avoids racing the CLI's first /oauth/device/code call.
async function authLoginCli(opts: {
  cwd: string;
  apiUrl: string;
  xdgHome: string;
  helperAdminToken: string;
}): Promise<{ code: number; stdout: string; stderr: string }> {
  const approveEvery = 100;
  const stop = { v: false };
  const approver = (async () => {
    while (!stop.v) {
      try {
        await fetchJson(`${opts.apiUrl}/__test__/auto-approve`, {
          method: "POST",
          headers: { "X-Test-Token": opts.helperAdminToken },
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

const helperBin = resolveHelperBin();

// Exit code 2 is the documented "not logged in" code. The CLI maps
// NotLoggedInError → exit 2 in auth/commands.ts; the boards/columns
// public endpoints don't touch this code path. Pin it here so a
// regression that remaps the exit code surfaces immediately.
const EXIT_NOT_LOGGED_IN = 2;

describe("CLI `kanban auth status` / `auth login` / `auth logout` e2e", () => {
  let workDir: string;
  let xdgHome: string;
  let helper: HelperHandle | null = null;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "kanban-auth-status-"));
    xdgHome = mkdtempSync(join(tmpdir(), "kanban-auth-status-xdg-"));
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
    "auth status reports not-logged-in (exit 2) when no credentials exist",
    async () => {
      const port = await freePort();
      helper = await startHelper(port, helperBin);
      const apiUrl = helper.apiUrl;

      const result = await runCli({
        cwd: workDir,
        args: ["auth", "status", "--api-url", apiUrl],
        env: { KANBAN_API_URL: apiUrl, XDG_CONFIG_HOME: xdgHome },
      });

      // Exit code 2 is the documented "not logged in" code (see
      // authExitCodeForError in cli/src/auth/commands.ts). Anything
      // else is a regression in the wrapper.
      expect(result.code).toBe(EXIT_NOT_LOGGED_IN);
      // The wrapper prints a red "Not logged in. Run 'kanban auth
      // login' first." hint on stderr so a human operator knows
      // what to do next. The exact wording is part of the CLI's
      // contract — keep the test anchored to it.
      expect(result.stderr).toMatch(/Not logged in/);
      expect(result.stderr).toMatch(/kanban auth login/);

      // No credentials file should have been created by a failed
      // status call. The CLI should not silently fabricate an
      // empty store to mask the failure.
      const credPath = credentialsPath(apiUrl, xdgHome);
      expect(existsSync(credPath)).toBe(false);
    },
    30_000
  );

  it(
    "auth status → login → status round-trip: login persists credentials that status then reads back",
    async () => {
      const port = await freePort();
      helper = await startHelper(port, helperBin);
      const apiUrl = helper.apiUrl;

      // Step 1: status before login — exits 2 and prints the hint.
      const beforeLogin = await runCli({
        cwd: workDir,
        args: ["auth", "status", "--api-url", apiUrl],
        env: { KANBAN_API_URL: apiUrl, XDG_CONFIG_HOME: xdgHome },
      });
      expect(beforeLogin.code).toBe(EXIT_NOT_LOGGED_IN);
      expect(beforeLogin.stderr).toMatch(/Not logged in/);

      // Step 2: drive the device flow via the CLI wrapper. The
      // auto-approve loop ticks every 100ms; the CLI's first
      // /oauth/device/code call lands first (the auto-approve
      // loop is non-blocking) and the next poll picks up the
      // approved token.
      const login = await authLoginCli({
        cwd: workDir,
        apiUrl,
        xdgHome,
        helperAdminToken: helper.adminToken,
      });
      expect(
        login.code,
        `CLI exited non-zero.\nstdout:\n${login.stdout}\nstderr:\n${login.stderr}`
      ).toBe(0);
      expect(login.stdout).toMatch(/Logged in to/);
      // The device-flow prompt must surface the verification URL
      // and user code on stderr so the human can approve in the
      // browser. The helper's auto-approve loop bypasses the
      // browser, but the prompt itself is part of the contract.
      expect(login.stderr).toMatch(/Visit:/);
      expect(login.stderr).toMatch(/oauth\/device/);

      // Sanity check the credentials file the CLI wrote. The
      // FileSecretProvider encrypts the access token at rest, so
      // we route the read back through the provider instead of
      // parsing the JSON directly — provider.read() handles the
      // decryption with the same key it used to write.
      const credPath = credentialsPath(apiUrl, xdgHome);
      expect(existsSync(credPath)).toBe(true);
      const provider = new FileSecretProvider(credPath);
      const stored = provider.read();
      expect(stored).not.toBeNull();
      expect(stored?.apiUrl).toBe(apiUrl);
      expect(stored?.clientId).toBeTruthy();
      expect(stored?.accessToken).toBeTruthy();
      expect(stored?.refreshToken).toBeTruthy();

      // Step 3: status after login — exits 0 and prints the
      // formatted report sourced from the credentials file.
      const afterLogin = await runCli({
        cwd: workDir,
        args: ["auth", "status", "--api-url", apiUrl],
        env: { KANBAN_API_URL: apiUrl, XDG_CONFIG_HOME: xdgHome },
      });
      expect(
        afterLogin.code,
        `CLI exited non-zero after login.\nstdout:\n${afterLogin.stdout}\nstderr:\n${afterLogin.stderr}`
      ).toBe(0);
      // The status report includes the host, client id, scope, and
      // identity line. Anchoring on the host + client id is enough
      // to prove the wrapper actually read the credentials file
      // (a regression that printed a hardcoded placeholder would
      // fail this).
      expect(afterLogin.stdout).toContain("Host:");
      expect(afterLogin.stdout).toContain(apiUrl);
      expect(afterLogin.stdout).toContain(stored!.clientId!);
      expect(afterLogin.stdout).toContain("Identity:");
      // The CLI's default clientName is "open-kanban-cli", which
      // matches the helper's DCR registration. status should
      // report it on the "Client:" line.
      expect(afterLogin.stdout).toContain("open-kanban-cli");
    },
    30_000
  );

  it(
    "auth logout clears the credentials file and a second logout is idempotent",
    async () => {
      const port = await freePort();
      helper = await startHelper(port, helperBin);
      const apiUrl = helper.apiUrl;

      // Set up credentials by running login first; without this
      // logout would hit the idempotent "nothing to do" branch and
      // we couldn't tell whether the clear path actually ran.
      const login = await authLoginCli({
        cwd: workDir,
        apiUrl,
        xdgHome,
        helperAdminToken: helper.adminToken,
      });
      expect(login.code).toBe(0);

      const credPath = credentialsPath(apiUrl, xdgHome);
      expect(existsSync(credPath)).toBe(true);

      // Step 1: first logout — exits 0 and prints the confirmation.
      const firstLogout = await runCli({
        cwd: workDir,
        args: ["auth", "logout", "--api-url", apiUrl],
        env: { KANBAN_API_URL: apiUrl, XDG_CONFIG_HOME: xdgHome },
      });
      expect(
        firstLogout.code,
        `first logout exited non-zero.\nstdout:\n${firstLogout.stdout}\nstderr:\n${firstLogout.stderr}`
      ).toBe(0);
      expect(firstLogout.stdout).toMatch(/Logged out/);

      // The credentials file should be gone (FileSecretProvider.clear
      // removes the JSON file outright; a regression that just
      // emptied the contents would leave a stale file and break
      // FileSecretProvider.read()'s decryption).
      expect(existsSync(credPath)).toBe(false);

      // Step 2: status returns to the not-logged-in state.
      const statusAfterLogout = await runCli({
        cwd: workDir,
        args: ["auth", "status", "--api-url", apiUrl],
        env: { KANBAN_API_URL: apiUrl, XDG_CONFIG_HOME: xdgHome },
      });
      expect(statusAfterLogout.code).toBe(EXIT_NOT_LOGGED_IN);
      expect(statusAfterLogout.stderr).toMatch(/Not logged in/);

      // Step 3: a second logout is idempotent — exits 0 and prints
      // the "nothing to do" branch so a stray script invocation
      // cannot break automation.
      const secondLogout = await runCli({
        cwd: workDir,
        args: ["auth", "logout", "--api-url", apiUrl],
        env: { KANBAN_API_URL: apiUrl, XDG_CONFIG_HOME: xdgHome },
      });
      expect(
        secondLogout.code,
        `second logout exited non-zero.\nstdout:\n${secondLogout.stdout}\nstderr:\n${secondLogout.stderr}`
      ).toBe(0);
      expect(secondLogout.stdout).toMatch(/nothing to do/);
    },
    30_000
  );

  it(
    "the persisted credentials file round-trips through FileSecretProvider unchanged",
    async () => {
      // The CLI relies on the encrypted file surviving a
      // read-write-read cycle: login writes it, every subsequent
      // command (status, whoami, boards list, tasks list, ...)
      // reads it via FileSecretProvider. A regression where the
      // write format drifts away from the reader would break
      // every other auth-gated command silently. Pin the
      // encrypted file's shape here: it must contain the enc /
      // salt / iv / tag quartet the FileSecretProvider uses, and
      // provider.read() must decrypt back to the original
      // access token + refresh token.
      const port = await freePort();
      helper = await startHelper(port, helperBin);
      const apiUrl = helper.apiUrl;

      const login = await authLoginCli({
        cwd: workDir,
        apiUrl,
        xdgHome,
        helperAdminToken: helper.adminToken,
      });
      expect(login.code).toBe(0);

      const credPath = credentialsPath(apiUrl, xdgHome);
      const onDisk = JSON.parse(readFileSync(credPath, "utf8")) as Record<string, unknown>;
      // FileSecretProvider's envelope format is documented in
      // src/auth/token-store.ts. Asserting on the field names
      // catches any drift; the values themselves are
      // crypto-bound and don't need exact-match.
      expect(typeof onDisk.enc).toBe("string");
      expect(typeof onDisk.salt).toBe("string");
      expect(typeof onDisk.iv).toBe("string");
      expect(typeof onDisk.tag).toBe("string");

      const provider = new FileSecretProvider(credPath);
      const decrypted = provider.read();
      expect(decrypted).not.toBeNull();
      expect(decrypted?.apiUrl).toBe(apiUrl);
      expect(typeof decrypted?.accessToken).toBe("string");
      expect((decrypted?.accessToken as string).length).toBeGreaterThan(0);
      expect(typeof decrypted?.refreshToken).toBe("string");
      expect((decrypted?.refreshToken as string).length).toBeGreaterThan(0);
      expect(typeof decrypted?.clientId).toBe("string");
    },
    30_000
  );
});

// Sanity-check the test bootstrap itself so a missing CLI build or
// helper binary fails loudly instead of mid-test.
describe("auth status / login / logout e2e prerequisites", () => {
  it("has a built CLI at dist/index.js", () => {
    expect(existsSync(CLI_DIST)).toBe(true);
  });

  it("has a built (or buildable) e2e-runner binary", () => {
    const bin = resolveHelperBin();
    expect(existsSync(bin)).toBe(true);
  });
});
