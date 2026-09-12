// End-to-end test for the `kanban shell` REPL.
//
// The test builds the CLI on demand, then spawns `node dist/index.js shell`
// as a child process with HOME pointed at an empty temporary directory
// (so there is no stored OAuth token) and KANBAN_API_URL pointed at a
// loopback address that won't accept connections. It pipes commands to
// stdin and asserts that:
//
//   * the banner appears on stdout;
//   * the auth probe produces the not-logged-in hint on stderr;
//   * `help` prints the help block;
//   * `exit` closes the REPL cleanly (exit code 0).
//
// Each scenario builds its own temp directory and removes it in an
// `afterEach` block so the test leaves no traces behind.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

const CLI_DIR = resolve(__dirname, "..");
const DIST_ENTRY = join(CLI_DIR, "dist", "index.js");

function ensureBuilt(): void {
  if (existsSync(DIST_ENTRY) && statSync(DIST_ENTRY).mtimeMs > Date.now() - 60_000) {
    return;
  }
  execSync("npm run build", { cwd: CLI_DIR, stdio: "ignore" });
}

function spawnShell(env: Record<string, string>, input: string, timeoutMs = 10000): Promise<{
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child: ChildProcessWithoutNullStreams = spawn(
      process.execPath,
      [DIST_ENTRY, "shell"],
      {
        cwd: CLI_DIR,
        env: { ...process.env, ...env, FORCE_COLOR: "0" },
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        rejectPromise(new Error(`shell did not exit within ${timeoutMs}ms`));
      }
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, code, signal });
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(err);
    });

    // Closing stdin (with `end()`) signals EOF to readline, which the
    // shell treats the same as Ctrl-D. The shell exits cleanly when its
    // input runs out, so we close after writing our scripted commands.
    child.stdin.write(input);
    child.stdin.end();
  });
}

describe("kanban shell (spawn)", () => {
  beforeAll(() => {
    ensureBuilt();
  });

  const tempDirs: string[] = [];
  function freshHome(): string {
    const dir = mkdtempSync(join(tmpdir(), "kanban-shell-e2e-"));
    tempDirs.push(dir);
    return dir;
  }
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // best effort
        }
      }
    }
  });

  it("renders the banner, hints at `auth login`, and exits on `exit`", async () => {
    const home = freshHome();
    const result = await spawnShell(
      {
        HOME: home,
        XDG_CONFIG_HOME: home,
        // Pretend we don't have a server reachable: `127.0.0.1:1` is a
        // reserved port that refuses connections, so the public
        // `/api/v1/boards` probe fails fast (we don't hit it during
        // this scenario — the auth probe short-circuits on no creds).
        KANBAN_API_URL: "http://127.0.0.1:1",
        // The shell respects this env var and will use it instead of
        // the default `~/.kanban_shell_history`.
        KANBAN_SHELL_HISTORY: join(home, "shell-history"),
      },
      "help\nexit\n"
    );

    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    // Banner + `help` body on stdout
    expect(result.stdout).toContain("kanban shell");
    expect(result.stdout).toContain("Built-ins:");
    // Auth probe on stderr
    expect(result.stderr).toContain("Not logged in");
    expect(result.stderr).toContain("auth login");
    // History file written on close.
    expect(existsSync(join(home, "shell-history"))).toBe(true);
    const historyContent = readFileSync(join(home, "shell-history"), "utf8");
    expect(historyContent).toContain("help");
    expect(historyContent).toContain("exit");
  });

  it("survives an unknown command without terminating the REPL", async () => {
    const home = freshHome();
    const result = await spawnShell(
      {
        HOME: home,
        XDG_CONFIG_HOME: home,
        KANBAN_API_URL: "http://127.0.0.1:1",
        KANBAN_SHELL_HISTORY: join(home, "shell-history"),
      },
      "this-command-does-not-exist\nexit\n"
    );

    expect(result.code).toBe(0);
    // The dispatcher writes a friendly error to stderr and the shell
    // stays open — the next `exit` closes it cleanly.
    expect(result.stderr).toContain("error:");
  });

  it("strips a leading `kanban` token before dispatching", async () => {
    const home = freshHome();
    const result = await spawnShell(
      {
        HOME: home,
        XDG_CONFIG_HOME: home,
        KANBAN_API_URL: "http://127.0.0.1:1",
        KANBAN_SHELL_HISTORY: join(home, "shell-history"),
      },
      "kanban help\nexit\n"
    );

    expect(result.code).toBe(0);
    // `kanban help` resolves to the built-in `help` and prints the help
    // block to stdout.
    expect(result.stdout).toContain("Built-ins:");
  });
});