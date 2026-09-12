// Unit tests for the `kanban shell` REPL.
//
// The tests exercise:
//   * `completeLine` — the readline completer returns the right
//     suggestions for top-level, subcommand, and flag prefixes.
//   * `runShell`     — the REPL drives a fake readline interface,
//     auto-probes auth, dispatches non-built-in lines to a stub
//     Commander program, handles `help` / `exit` / `clear` / `whoami`
//     locally, and survives a command that requests `process.exit`.
//
// Each scenario uses an in-memory fake Readline so the assertions can
// drive lines deterministically without a real TTY.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Writable, Readable } from "node:stream";
import { Command } from "commander";
import {
  completeLine,
  runShell,
  defaultHistoryPath,
  type FakeReadline,
  type ShellDeps,
} from "./shell.js";
import {
  InMemorySecretProvider,
  OAuthClient,
} from "../auth/client.js";
import type { OAuthMetadata } from "../auth/types.js";
import { HttpClient } from "../http/client.js";

const metadata: OAuthMetadata = {
  issuer: "http://kanban.test",
  authorization_endpoint: "http://kanban.test/oauth/authorize",
  token_endpoint: "http://kanban.test/oauth/token",
  jwks_uri: "http://kanban.test/.well-known/jwks.json",
  registration_endpoint: "http://kanban.test/oauth/register",
  device_authorization_endpoint: "http://kanban.test/oauth/device/code",
  grant_types_supported: [
    "urn:ietf:params:oauth:grant-type:device_code",
    "refresh_token",
  ],
  response_types_supported: ["code"],
  token_endpoint_auth_methods_supported: ["none"],
  scopes_supported: ["kanban:read", "tasks:write"],
};

function makeIO() {
  let stdout = "";
  let stderr = "";
  const out = new Writable({
    write(chunk, _enc, cb) {
      stdout += chunk.toString();
      cb();
    },
  });
  const err = new Writable({
    write(chunk, _enc, cb) {
      stderr += chunk.toString();
      cb();
    },
  });
  return {
    io: {
      stdout: out as unknown as NodeJS.WritableStream,
      stderr: err as unknown as NodeJS.WritableStream,
    },
    read: () => ({ stdout, stderr }),
    reset() {
      stdout = "";
      stderr = "";
    },
  };
}

// FakeReadline lets a test push lines into the shell loop deterministically.
// `drive(lines)` writes each line followed by a "line" event, then closes
// the interface. The test awaits `runShell`; when it resolves, the
// captured output is ready to inspect.
class FakeRL implements FakeReadline {
  prompt = vi.fn();
  close = vi.fn(() => this.emitClose());
  setPrompt = vi.fn();
  history: string[] = [];
  private lineListeners: Array<(line: string) => void> = [];
  private closeListeners: Array<() => void> = [];
  private promptStr = "";

  on(event: "line", listener: (line: string) => void): this;
  on(event: "close", listener: () => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this {
    if (event === "line") this.lineListeners.push(listener as (line: string) => void);
    else if (event === "close") this.closeListeners.push(listener as () => void);
    return this;
  }

  // drive fires one "line" event per input, then closes the interface.
  // Lines are pushed sequentially so async handlers complete in order.
  async drive(lines: string[]): Promise<void> {
    for (const line of lines) {
      for (const l of this.lineListeners) await l(line);
      if (this.prompt.mock.calls.length === 0 && this.lineListeners.length > 0) {
        // runShell calls prompt() inside its initial setup; tests that
        // never see this just check prompt was invoked at all.
      }
    }
    this.emitClose();
  }

  private emitClose() {
    for (const l of this.closeListeners) l();
  }

  setPromptStr(p: string) {
    this.promptStr = p;
  }
  getPromptStr() {
    return this.promptStr;
  }
}

function makeProgram(opts: {
  onParse?: (argv: string[]) => void;
  exitOnNext?: boolean;
}): { program: Command; calls: string[][] } {
  const calls: string[][] = [];
  const program = new Command();
  program
    .name("kanban")
    // The dispatcher re-injects the shell-level --api-url / --profile on
    // every parse so command actions can read them through program.opts().
    // A test program must declare them too, otherwise Commander rejects
    // them as unknown options.
    .option("--api-url <url>", "Kanban API base URL")
    .option("--profile <name>", "credential profile");
  program
    .command("boards")
    .command("list")
    .action(() => {
      calls.push(program.args.slice());
      opts.onParse?.(program.args.slice());
      if (opts.exitOnNext) {
        process.exit(7);
      }
    });
  return { program, calls };
}

describe("completeLine", () => {
  it("suggests top-level commands + built-ins on an empty line", () => {
    const [matches, original] = completeLine("");
    expect(original).toBe("");
    expect(matches).toContain("boards");
    expect(matches).toContain("help");
    expect(matches).toContain("exit");
    expect(matches).toContain("clear");
    expect(matches).toContain("whoami");
  });

  it("filters top-level suggestions by prefix", () => {
    const [matches] = completeLine("bo");
    expect(matches).toEqual(["boards"]);
  });

  it("suggests subcommands after a top-level command", () => {
    const [matches] = completeLine("boards ");
    expect(matches).toEqual(["get", "list"]);
  });

  it("filters subcommands by prefix", () => {
    const [matches] = completeLine("boards li");
    expect(matches).toEqual(["list"]);
  });

  it("suggests global flags when the partial token starts with --", () => {
    const [matches] = completeLine("--out");
    expect(matches).toContain("--output");
  });

  it("strips a leading `kanban` token before completing", () => {
    const [matches] = completeLine("kanban bo");
    expect(matches).toEqual(["boards"]);
  });
});

describe("runShell", () => {
  beforeEach(() => {
    delete process.env.KANBAN_SHELL_HISTORY;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints the banner, runs the auth probe, and exits on `exit`", async () => {
    const cap = makeIO();
    const rl = new FakeRL();
    const provider = new InMemorySecretProvider();
    const oauth = new OAuthClient("http://kanban.test", metadata, provider);
    const http = new HttpClient({ apiUrl: "http://kanban.test" });
    const { program, calls } = makeProgram({});
    const saved: string[] = [];
    const shellPromise = runShell(
      { apiUrl: "http://kanban.test" },
      {
        program,
        oauth,
        http,
        input: new Readable({ read() {} }) as unknown as NodeJS.ReadableStream,
        output: cap.io.stdout,
        errorOutput: cap.io.stderr,
        historyPath: "/tmp/kanban-test-history",
        terminal: false,
        loadHistory: () => [],
        saveHistory: (path, h) => saved.push(path, JSON.stringify(h)),
        createReadline: () => rl,
      }
    );

    // Drive "exit" line; runShell should close cleanly.
    await rl.drive(["exit"]);
    await shellPromise;

    const { stdout, stderr } = cap.read();
    expect(stdout).toContain("kanban shell");
    expect(stderr).toContain("Not logged in");
    // The auth probe runs runAuthStatus which itself writes "Not logged in"
    // before throwing — the probe swallows that path entirely because we
    // short-circuit on missing creds, so the inner message should NOT
    // appear.
    expect(stderr.split("Not logged in").length - 1).toBe(1);
    // No command dispatched (only "exit" was typed).
    expect(calls).toEqual([]);
    // History persisted to the configured path with an empty array
    // (because "exit" is filtered by readline itself as a repeat).
    expect(saved[0]).toBe("/tmp/kanban-test-history");
  });

  it("dispatches a non-built-in line to the Commander program with shell opts prepended", async () => {
    const cap = makeIO();
    const rl = new FakeRL();
    const provider = new InMemorySecretProvider();
    const oauth = new OAuthClient("http://kanban.test", metadata, provider);
    const http = new HttpClient({ apiUrl: "http://kanban.test" });
    const { program, calls } = makeProgram({});
    const shellPromise = runShell(
      { apiUrl: "http://kanban.test", profile: "work" },
      {
        program,
        oauth,
        http,
        input: new Readable({ read() {} }) as unknown as NodeJS.ReadableStream,
        output: cap.io.stdout,
        errorOutput: cap.io.stderr,
        historyPath: "/tmp/kanban-test-history-2",
        terminal: false,
        loadHistory: () => ["previous-line"],
        saveHistory: () => {},
        createReadline: () => rl,
      }
    );

    await rl.drive(["boards list", "exit"]);
    await shellPromise;

    // boards list was dispatched once. program.args contains the full
    // positional argv as Commander sees it; the dispatcher strips the
    // "node"/"kanban" sentinel so the command tree receives just the
    // user-supplied tokens.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["boards", "list"]);
    // The banner still printed.
    const { stdout } = cap.read();
    expect(stdout).toContain("kanban shell");
  });

  it("does not exit the REPL when a dispatched command calls process.exit", async () => {
    const cap = makeIO();
    const rl = new FakeRL();
    const provider = new InMemorySecretProvider();
    const oauth = new OAuthClient("http://kanban.test", metadata, provider);
    const http = new HttpClient({ apiUrl: "http://kanban.test" });
    // Build a program whose action deliberately calls process.exit to
    // mimic commands like `auth status` exiting with code 2 when not
    // logged in. The shell must swallow it. The action writes directly
    // to the captured io streams so the test can assert on the order
    // of side effects without spawning a real subprocess.
    let okCalled = false;
    const program = new Command();
    program
      .name("kanban")
      .option("--api-url <url>", "url")
      .option("--profile <name>", "profile");
    program
      .command("fail")
      .action(() => {
        cap.io.stderr.write("attempting exit\n");
        process.exit(99);
      });
    program.command("ok").action(() => {
      okCalled = true;
      cap.io.stdout.write("OK\n");
    });

    const shellPromise = runShell(
      { apiUrl: "http://kanban.test" },
      {
        program,
        oauth,
        http,
        input: new Readable({ read() {} }) as unknown as NodeJS.ReadableStream,
        output: cap.io.stdout,
        errorOutput: cap.io.stderr,
        historyPath: "/tmp/kanban-test-history-3",
        terminal: false,
        loadHistory: () => [],
        saveHistory: () => {},
        createReadline: () => rl,
      }
    );

    await rl.drive(["fail", "ok", "exit"]);
    await shellPromise;

    const { stdout, stderr } = cap.read();
    expect(okCalled).toBe(true);
    expect(stdout).toContain("OK");
    expect(stderr).toContain("attempting exit");
    // process.exit was invoked, but the shell survived — only "exit"
    // closed the interface.
  });

  it("renders the `help` built-in and recognises the `kanban` prefix", async () => {
    const cap = makeIO();
    const rl = new FakeRL();
    const provider = new InMemorySecretProvider();
    const oauth = new OAuthClient("http://kanban.test", metadata, provider);
    const http = new HttpClient({ apiUrl: "http://kanban.test" });
    const program = new Command();
    program
      .name("kanban")
      .option("--api-url <url>", "url")
      .option("--profile <name>", "profile");
    const shellPromise = runShell(
      { apiUrl: "http://kanban.test" },
      {
        program,
        oauth,
        http,
        input: new Readable({ read() {} }) as unknown as NodeJS.ReadableStream,
        output: cap.io.stdout,
        errorOutput: cap.io.stderr,
        historyPath: "/tmp/kanban-test-history-4",
        terminal: false,
        loadHistory: () => [],
        saveHistory: () => {},
        createReadline: () => rl,
      }
    );

    await rl.drive(["help", "kanban help", "exit"]);
    await shellPromise;

    const { stdout } = cap.read();
    // Two help calls → two "kanban shell" help headers.
    expect(stdout.split("kanban shell").length - 1).toBeGreaterThanOrEqual(3); // banner + 2× help header
    expect(stdout).toContain("Built-ins:");
  });

  it("does not surface `whoami` errors as `shell: internal error`", async () => {
    const cap = makeIO();
    const rl = new FakeRL();
    const provider = new InMemorySecretProvider();
    const oauth = new OAuthClient("http://kanban.test", metadata, provider);
    const http = new HttpClient({ apiUrl: "http://kanban.test" });
    const program = new Command();
    program
      .name("kanban")
      .option("--api-url <url>", "url")
      .option("--profile <name>", "profile");
    const shellPromise = runShell(
      { apiUrl: "http://kanban.test" },
      {
        program,
        oauth,
        http,
        input: new Readable({ read() {} }) as unknown as NodeJS.ReadableStream,
        output: cap.io.stdout,
        errorOutput: cap.io.stderr,
        historyPath: "/tmp/kanban-test-history-5",
        terminal: false,
        loadHistory: () => [],
        saveHistory: () => {},
        createReadline: () => rl,
      }
    );

    await rl.drive(["whoami", "exit"]);
    await shellPromise;

    const { stderr } = cap.read();
    expect(stderr).toContain("Not logged in");
    expect(stderr).not.toContain("shell: internal error");
  });
});

describe("defaultHistoryPath", () => {
  it("honours the KANBAN_SHELL_HISTORY env override", () => {
    process.env.KANBAN_SHELL_HISTORY = "/tmp/custom-history";
    expect(defaultHistoryPath()).toBe("/tmp/custom-history");
  });
  it("falls back to ~/.kanban_shell_history when unset", () => {
    delete process.env.KANBAN_SHELL_HISTORY;
    const home = process.env.HOME || "";
    expect(defaultHistoryPath()).toContain(".kanban_shell_history");
    // The fallback should live under the user's home directory.
    expect(defaultHistoryPath().startsWith(home)).toBe(true);
  });
});