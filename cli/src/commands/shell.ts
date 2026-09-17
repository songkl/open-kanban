// `kanban shell` — interactive REPL for the Open Kanban CLI.
//
// The shell wraps the same Commander program used by the top-level CLI
// entry, but adds:
//
//   * A `kanban> ` prompt with up/down arrow history navigation
//     (history is loaded from / saved to `~/.kanban_shell_history` by
//     default — `KANBAN_SHELL_HISTORY` overrides the path).
//   * Tab completion that suggests subcommands at the current level
//     plus the built-ins `help`, `exit`, `clear`, `whoami`.
//   * Built-in commands `help`, `exit`/`quit`, `clear`, `whoami` so the
//     user can inspect state without reaching for a flag the Commander
//     tree doesn't know about.
//   * An automatic `auth status` probe on entry. If the user is not
//     logged in, a yellow hint points them at `auth login`; the shell
//     itself stays open.
//
// The shell is intentionally thin: each non-built-in line is dispatched
// to a fresh `program.parseAsync(["node", "kanban", ...tokens])` call so
// every command reuses the action handlers wired in `cli/src/program.ts`.
// `process.exit` is monkey-patched during dispatch so a command that
// requests an exit code (e.g. `auth status` when not logged in) does not
// terminate the REPL.

import { Command } from "commander";
import { createInterface, type Interface as RLInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import chalk from "chalk";
import { OAuthClient } from "../auth/client.js";
import { HttpClient } from "../http/client.js";
import {
  runStatus as runAuthStatus,
  runWhoami,
  NotLoggedInError,
} from "../auth/commands.js";
import { AuthError, NetworkError } from "../http/client.js";

const PROMPT = "kanban> ";

// BUILT_INS are handled by the shell itself; they never reach Commander.
const BUILT_INS = new Set(["help", "exit", "quit", "clear", "whoami"]);

// TOP_LEVEL_COMMANDS mirrors the commands attached to the root program in
// cli/src/program.ts. It is used by the tab completer; the dispatcher
// itself does not depend on it (Commander owns the real command tree).
const TOP_LEVEL_COMMANDS = [
  "auth",
  "status",
  "dashboard",
  "boards",
  "columns",
  "tasks",
  "drafts",
  "archived",
  "comments",
  "subtasks",
  "mine",
  "runs",
  "workspace",
  "shell",
  "completion",
  "config",
  "help",
  "version",
];

// SUBCOMMANDS is a static map of command → children for tab completion.
// Keeping this declarative means the completer stays cheap and never
// instantiates a Commander program to inspect it.
const SUBCOMMANDS: Record<string, string[]> = {
  auth: ["login", "status", "logout", "whoami"],
  boards: ["list", "get"],
  columns: ["list", "get"],
  tasks: ["list", "get", "create", "update", "delete", "complete", "move", "batch"],
  "tasks batch": ["create", "update", "delete"],
  drafts: ["list", "publish", "unpublish"],
  archived: ["list", "archive", "restore"],
  comments: ["add", "list"],
  subtasks: ["list", "create", "update", "delete"],
  runs: ["list"],
  workspace: ["upload", "batch-upload", "list", "read", "delete", "stats"],
  completion: ["bash", "zsh", "fish"],
};

// GLOBAL_FLAGS are surfaced by the completer when the user starts typing
// `--` at any level.
const GLOBAL_FLAGS = [
  "--api-url",
  "--profile",
  "--output",
  "--color",
  "--no-color",
];

const BANNER = [
  chalk.bold("kanban shell") +
    `  type ${chalk.cyan("help")} for available commands, ${chalk.cyan(
      "exit"
    )} to leave`,
  chalk.gray("auto-probing `auth status` on entry..."),
].join("\n");

const HELP_TEXT = [
  chalk.bold("kanban shell"),
  "",
  "Interactive REPL. Every line is interpreted as a `kanban` subcommand:",
  "  > boards list                       # → kanban boards list",
  "  > kanban tasks get abc              # the leading `kanban` is stripped",
  "  > --output json tasks list          # global flags pass through",
  "",
  chalk.bold("Built-ins:"),
  `  ${chalk.cyan("help")}      show this message`,
  `  ${chalk.cyan("exit")}/${chalk.cyan("quit")}   close the shell (Ctrl-D also works)`,
  `  ${chalk.cyan("clear")}     clear the screen`,
  `  ${chalk.cyan("whoami")}    call GET /api/v1/users/me`,
  "",
  chalk.bold("Key bindings:"),
  "  Up/Down arrows    previous / next history entry",
  "  Tab               complete subcommands / flags",
  "",
  `History is persisted to ${chalk.cyan(defaultHistoryPath())}.`,
].join("\n");

// ShellExitTrap is thrown by the dispatcher's process.exit shim so the
// call propagates out of `program.parseAsync` without killing the REPL.
class ShellExitTrap extends Error {
  constructor(public readonly code: number) {
    super("shell-exit-trap");
    this.name = "ShellExitTrap";
  }
}

export interface RunShellOptions {
  apiUrl: string;
  profile?: string;
}

export interface ShellDeps {
  // program is the configured Commander instance from `createProgram`.
  // The shell calls `program.parseAsync(["node", "kanban", ...argv])`
  // for every non-built-in line.
  program: Command;
  // oauth / http are passed to `runAuthStatus` and `runWhoami` for the
  // built-ins / startup probe; the program actions use the same instances.
  oauth: OAuthClient;
  http: HttpClient;
  // io streams. Default to process.std{in,out,err}. Tests inject capture
  // streams so they can assert on the rendered prompt / banner / output.
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  errorOutput?: NodeJS.WritableStream;
  // historyPath overrides ~/.kanban_shell_history.
  historyPath?: string;
  // terminal defaults to true when output is a TTY, false otherwise.
  // Readline only fires the completer / arrow-key handlers in terminal
  // mode, so the e2e (piped) test must explicitly disable it.
  terminal?: boolean;
  // loadHistory / saveHistory are test seams over the on-disk history.
  loadHistory?: (path: string) => string[];
  saveHistory?: (path: string, history: string[]) => void;
  // createReadline lets tests substitute a fake Readline interface that
  // exposes `on / prompt / close / history` without touching a real TTY.
  createReadline?: (opts: unknown) => RLInterface | FakeReadline;
}

// FakeReadline is the minimum surface runShell relies on; both
// `node:readline.Interface` and the in-memory fake in the unit tests
// conform to it.
export interface FakeReadline {
  on(event: "line", listener: (line: string) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  setPrompt(prompt: string): void;
  prompt(): void;
  close(): void;
  history: string[];
}

export function defaultHistoryPath(): string {
  return process.env.KANBAN_SHELL_HISTORY || join(homedir(), ".kanban_shell_history");
}

function loadHistoryFromDisk(path: string): string[] {
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, "utf8");
    return raw
      .split(/\r?\n/)
      .map((l) => l.replace(/[\u0000-\u001f\u007f]/g, ""))
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

function saveHistoryToDisk(path: string, history: string[]): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  } catch {
    // best effort — directory may already exist
  }
  const body = history
    .map((l) => l.replace(/[\u0000-\u001f\u007f]/g, ""))
    .filter((l) => l.length > 0)
    .join("\n");
  try {
    writeFileSync(path, body + (body.length > 0 ? "\n" : ""), { mode: 0o600 });
  } catch {
    // best effort — read-only filesystems shouldn't crash the shell
  }
}

// completeLine is the readline completer. It strips the optional leading
// `kanban` token, looks at the remaining tokens, and returns a tuple
// of `[matches, originalLine]` for readline to display.
//
// Behaviour:
//   * empty line              → top-level commands + built-ins
//   * "<prefix>"              → filter top-level commands + built-ins
//   * "<cmd> "                → children of `<cmd>`
//   * "<cmd> <prefix>"        → filter children of `<cmd>`
//   * "<cmd> <sub> "          → children of `<cmd> <sub>` if any
//   * any token starting with -- → global flags filtered by prefix
export function completeLine(line: string): [string[], string] {
  const stripped = line.replace(/^\s*kanban\s+/, "");
  const trimmed = stripped.replace(/^\s+/, "");
  if (trimmed === "") {
    return [
      [...TOP_LEVEL_COMMANDS, ...BUILT_INS].filter((c) => !c.includes(" ")).sort(),
      line,
    ];
  }
  const tokens = trimmed.split(/\s+/).filter((t) => t.length > 0);
  const last = tokens[tokens.length - 1] ?? "";
  // flag completion: any partial starting with `--`
  if (last.startsWith("--")) {
    return [GLOBAL_FLAGS.filter((f) => f.startsWith(last)), line];
  }
  // level 1: top-level command completion (only the first token is being typed)
  if (tokens.length === 1 && !line.endsWith(" ")) {
    const matches = [
      ...TOP_LEVEL_COMMANDS,
      ...Array.from(BUILT_INS).filter((b) => b !== "quit"),
      "quit",
    ];
    return [matches.filter((m) => m.startsWith(trimmed)).sort(), line];
  }
  // determine which subcommand list to show
  const head = tokens.slice(0, line.endsWith(" ") ? tokens.length : tokens.length - 1);
  const path = head.join(" ");
  const children = SUBCOMMANDS[path] ?? [];
  if (children.length === 0) {
    return [[], line];
  }
  // partial filter
  if (!line.endsWith(" ") && tokens.length > head.length) {
    return [children.filter((c) => c.startsWith(last)).sort(), line];
  }
  return [children.slice().sort(), line];
}

// runShell is the entry point invoked by the `kanban shell` command. It
// blocks until the REPL closes (via `exit`, Ctrl-D, or the injected
// readline calling `close()`).
export async function runShell(
  opts: RunShellOptions,
  deps: ShellDeps
): Promise<void> {
  const input = deps.input ?? process.stdin;
  const output = deps.output ?? process.stdout;
  const errorOutput = deps.errorOutput ?? process.stderr;
  const historyPath = deps.historyPath ?? defaultHistoryPath();
  const terminal =
    deps.terminal ?? Boolean((output as { isTTY?: boolean }).isTTY);

  const initialHistory = deps.loadHistory
    ? deps.loadHistory(historyPath)
    : loadHistoryFromDisk(historyPath);

  const factory = deps.createReadline ?? ((o: unknown) => createInterface(o as Parameters<typeof createInterface>[0]));
  const rl = factory({
    input,
    output,
    terminal,
    completer: completeLine,
    history: initialHistory,
  });

  output.write(BANNER + "\n");

  // Register the line / close listeners *before* awaiting anything so
  // callers can drive lines immediately after the function returns the
  // shell promise. The auth probe (and any other setup) runs in
  // parallel and writes to its own io streams without holding up the
  // prompt loop.
  let exitRequested = false;
  let resolveClose!: () => void;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClose = resolve;
  });

  rl.on("line", async (rawLine: string) => {
    if (exitRequested) return;
    const trimmed = rawLine.replace(/\r?\n$/, "");
    // Readline only auto-appends to `rl.history` in `terminal: true`
    // mode (interactive use). When the shell is driven by a piped
    // stdin (e.g. the spawn tests) we have to push the line ourselves
    // so it survives across sessions and so `saveHistory` has something
    // to write. Skip duplicates of the most recent entry to avoid
    // double-recording when terminal mode already added the line.
    if (trimmed.length > 0) {
      const history = (rl as { history?: string[] }).history;
      const last = history && history.length > 0 ? history[history.length - 1] : undefined;
      if (last !== trimmed) history?.push(trimmed);
    }
    try {
      const result = await handleLine(trimmed, opts, deps, output, errorOutput);
      if (result === "exit") {
        exitRequested = true;
        rl.close();
        return;
      }
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      errorOutput.write(`shell: internal error: ${message}\n`);
    }
    if (!exitRequested) rl.prompt();
  });

  rl.on("close", () => {
    // The close listener may fire before or after the line listener
    // marks the session as "exit requested" — resolveClose() is idempotent
    // so calling it once is enough.
    const finalHistory = (rl as { history?: string[] }).history ?? initialHistory;
    if (deps.saveHistory) deps.saveHistory(historyPath, finalHistory);
    else saveHistoryToDisk(historyPath, finalHistory);
    resolveClose();
  });

  // Probe auth state on entry. Failures are non-fatal — the shell still
  // opens so the user can run `auth login`. Awaited *after* listener
  // registration so the REPL is ready to accept lines immediately.
  await probeAuth(opts, deps, output, errorOutput);

  rl.setPrompt(PROMPT);
  rl.prompt();

  await closedPromise;
}

async function probeAuth(
  opts: RunShellOptions,
  deps: ShellDeps,
  output: NodeJS.WritableStream,
  errorOutput: NodeJS.WritableStream
): Promise<void> {
  // Short-circuit when there is no credential file at all — saves a
  // round-trip to the OAuth server and avoids the noisy "Not logged in"
  // line that `runAuthStatus` would emit on its own.
  const stored = deps.oauth.loadCredentials();
  if (!stored || !stored.accessToken) {
    errorOutput.write(
      chalk.yellow("Not logged in. Run `auth login` first.\n")
    );
    return;
  }
  try {
    await runAuthStatus(
      { apiUrl: opts.apiUrl, profile: opts.profile },
      { oauth: deps.oauth, io: { stdout: output, stderr: errorOutput } }
    );
  } catch (err) {
    if (err instanceof NotLoggedInError) {
      errorOutput.write(
        chalk.yellow("Not logged in. Run `auth login` first.\n")
      );
    } else if (err instanceof NetworkError) {
      errorOutput.write(
        chalk.yellow(`auth probe: network unreachable (${err.message})\n`)
      );
    } else if (err instanceof AuthError) {
      errorOutput.write(
        chalk.yellow(`auth probe: ${err.message}\n`)
      );
    } else {
      errorOutput.write(
        chalk.yellow(`auth probe failed: ${(err as Error).message}\n`)
      );
    }
  }
}

type LineResult = "ok" | "exit";

async function handleLine(
  line: string,
  opts: RunShellOptions,
  deps: ShellDeps,
  output: NodeJS.WritableStream,
  errorOutput: NodeJS.WritableStream
): Promise<LineResult> {
  // Drop a leading `kanban` token so users can paste full commands.
  const stripped = line.replace(/^\s*kanban\s+/, "").trim();
  if (stripped === "") return "ok";
  // Split on whitespace. Quote handling is intentionally simple — the
  // shell is meant for quick exploration, not for scripting.
  const tokens = stripped.split(/\s+/).filter((t) => t.length > 0);
  const head = tokens[0];
  if (BUILT_INS.has(head)) {
    if (head === "exit" || head === "quit") return "exit";
    if (head === "clear") {
      // ANSI clear-screen + cursor home. Falls through silently when the
      // output stream is not a TTY (piped) — there's nothing to clear.
      output.write("\u001b[2J\u001b[H");
      return "ok";
    }
    if (head === "help") {
      output.write(HELP_TEXT + "\n");
      return "ok";
    }
    if (head === "whoami") {
      // Short-circuit on missing creds — avoids the noisy double-message
      // from `runWhoami` printing "Not logged in" before throwing.
      const stored = deps.oauth.loadCredentials();
      if (!stored?.accessToken && !stored?.refreshToken) {
        errorOutput.write(
          chalk.yellow("Not logged in. Run `auth login` first.\n")
        );
        return "ok";
      }
      try {
        await runWhoami(
          { apiUrl: opts.apiUrl, profile: opts.profile },
          {
            oauth: deps.oauth,
            http: deps.http,
            io: { stdout: output, stderr: errorOutput },
          }
        );
      } catch (err) {
        if (err instanceof NotLoggedInError) {
          errorOutput.write(
            chalk.yellow("Not logged in. Run `auth login` first.\n")
          );
        } else if (err instanceof NetworkError) {
          errorOutput.write(
            chalk.yellow(`whoami: network unreachable (${err.message})\n`)
          );
        } else if (err instanceof AuthError) {
          errorOutput.write(
            chalk.yellow(`whoami: ${err.message}\n`)
          );
        } else {
          errorOutput.write(
            chalk.yellow(`whoami failed: ${(err as Error).message}\n`)
          );
        }
      }
      return "ok";
    }
  }
  await dispatchCommand(deps.program, tokens, opts, errorOutput);
  return "ok";
}

// dispatchCommand routes a token list to `program.parseAsync`. The
// `process.exit` shim prevents command actions from terminating the REPL
// when they throw errors and call `process.exit(N)`. The shell-level
// `--api-url` / `--profile` are re-injected on every parse because
// Commander resets option values to the constructor defaults each
// time `parseAsync` is called.
async function dispatchCommand(
  program: Command,
  tokens: string[],
  opts: RunShellOptions,
  errorOutput: NodeJS.WritableStream
): Promise<void> {
  const originalExit = process.exit;
  let exitCode: number | null = null;
  const shim = ((code?: number): never => {
    exitCode = code ?? 0;
    throw new ShellExitTrap(exitCode);
  }) as typeof process.exit;
  process.exit = shim;
  const injected: string[] = [];
  if (opts.apiUrl) injected.push("--api-url", opts.apiUrl);
  if (opts.profile) injected.push("--profile", opts.profile);
  try {
    await program.parseAsync(["node", "kanban", ...injected, ...tokens]);
  } catch (err) {
    if (err instanceof ShellExitTrap) {
      // The command wanted to exit the *top-level* process — record the
      // code so it could be re-used, but do not propagate.
      exitCode = (err as ShellExitTrap).code;
      return;
    }
    const message = (err as Error)?.message ?? String(err);
    errorOutput.write(`error: ${message}\n`);
  } finally {
    process.exit = originalExit;
  }
  // Use the unused `exitCode` so TS doesn't flag it as dead — it surfaces
  // as a side-channel (logs / future exitCode tracking).
  void exitCode;
}