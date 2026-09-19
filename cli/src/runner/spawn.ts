// Child-process wrapper — owns the spawn / signal / timeout / stderr-
// truncation semantics described in §4.2 / §4.5 of
// `devDoc/CLI_RUNNER_PLAN_2026-09-12.md`.
//
// Two interfaces drive this module:
//
//   * `AgentSpawner` — the public façade the loop calls. Returns an
//     `AgentProcess` that exposes the same surface Node's
//     `ChildProcess` does (kill, wait, stdout/stderr), but with three
//     additional guarantees: stdout and stderr are each **always
//     truncated to 64 KiB**, and a `timeoutMs` ceiling always kills
//     the child (SIGTERM, then SIGKILL after a grace period).
//
//   * `ProcessSpawner` — the low-level primitive (default:
//     `child_process.spawn`). Tests inject a fake that returns a
//     `FakeAgentProcess`, so the loop tests can run with fake timers
//     and never need a real subprocess.
//
// Prompt delivery is handled here too:
//
//   * `promptMode === "arg"`: write the prompt to a temp file under
//     `os.tmpdir()` and append `<promptArg> <path>` to argv. We
//     deliberately route through a temp file (rather than argv) because
//     Windows has a 32k-char argv limit (§8 risk register).
//   * `promptMode === "stdin"`: pipe the prompt to the child's stdin
//     and close it after writing.
//   * `promptMode === "file"`: write the prompt to
//     `<cwd>/.kanban-runner-<taskId>.md` and append
//     `<promptArg> <path>` to argv (same flag shape as `arg`, but the
//     path is project-relative and survives the run).
//   * `promptMode === "argv"` (s-1191): append the prompt **content**
//     directly as a single positional argv entry. No flag, no temp
//     file. This is the only mode that works for agents that take the
//     message as a positional argument (e.g. `opencode run [message..]`)
//     — the previous default of `arg` rendered the invocation as
//     `opencode run --prompt /tmp/...` which `opencode run` rejects
//     with its help banner because `--prompt` is not a `run` flag.
//     Subject to the OS argv size limit (32 KiB on Windows,
//     effectively unlimited on macOS / Linux).
//   * `promptMode === "acp"` (s-1235): talk to the agent over the
//     [Agent Client Protocol]. The runner appends `agent.acpFlag`
//     (default `--acp`) to argv, opens the child's stdio as
//     pipe/pipe/pipe, and drives the full handshake
//     (`initialize` → `session/new` → `session/prompt`) via the
//     helper in `acp.ts`. Streamed text chunks are aggregated into
//     `result.stdout` so the existing finish-pipe code path can
//     forward the reply verbatim. The prompt is **not** written to
//     disk and never appears in argv, so the OS argv cap is irrelevant.
//
// [Agent Client Protocol]: https://agentclientprotocol.com/

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  SUPPORTED_ARG_VARIABLES,
  type AgentConfig,
  type AgentPromptMode,
  type AgentPromptPosition,
  type ArgVariable,
  type ArgVariableValues,
} from "./types.js";
import { AcpClient, LineJsonTransport } from "./acp.js";

/** Hard cap on the stderr payload the loop forwards to `/finish`. */
export const STDERR_TRUNCATE_BYTES = 64 * 1024;

/**
 * Hard cap on the stdout payload the loop forwards to `/finish`.
 * Mirrors `STDERR_TRUNCATE_BYTES` so a runaway agent cannot OOM the
 * CLI on either stream. The cap also matches the
 * `task_runs.output` column cap documented in
 * devDoc/CLI_RUNNER_OPENAPI_2026-09-12.yaml (s-1185: previously the
 * runner silently discarded stdout entirely, which made opencode's
 * banner-on-stderr look like a failure on the task detail page).
 */
export const STDOUT_TRUNCATE_BYTES = 64 * 1024;

/**
 * Literal token operators embed in `agent.args` when
 * `promptPosition: "replace"`. The runner substitutes the prompt
 * flag + path for this single occurrence; missing or duplicate
 * occurrences fail at config-validation time so the operator never
 * sees a half-formed spawn.
 */
export const PROMPT_PLACEHOLDER = "{prompt}";

/**
 * Pattern that captures the `$name` token inside an arg string. The
 * shape is intentionally narrow: `$` followed by an ASCII identifier
 * (`[A-Za-z_][A-Za-z0-9_]*`) so we never accidentally splice in the
 * middle of a shell-style reference like `${HOME}` and never match
 * `$1`, `$?`, `$$`, or other POSIX specials. Unknown names are
 * rejected at config-validation time, so this regex only fires for
 * the seven strings in `SUPPORTED_ARG_VARIABLES` at runtime.
 *
 * We use a non-anchored, non-global match here because `expandArgs`
 * applies the pattern via `String.prototype.replace` with the `g`
 * flag — keeping the constant here documents the shape for tests.
 */
export const ARG_VARIABLE_PATTERN = /\$([A-Za-z][A-Za-z0-9]*)/g;

/**
 * Map of `ArgVariable` → literal placeholder name, used by the
 * validator to enumerate the supported tokens without sprinkling
 * string literals around the codebase. Kept here (not in
 * `types.ts`) because it's only meaningful to the spawn layer; the
 * type module just exports the union.
 */
export const ARG_VARIABLE_NAMES: ReadonlySet<string> = new Set(
  SUPPORTED_ARG_VARIABLES
);

/**
 * Substitute every supported `$name` token in `args` with the value
 * supplied in `variables`. Missing values (or `""` entries) become
 * literal empty strings so the operator's argv keeps its shape — e.g.
 * `--title=$title` with an unset title renders as `--title=` rather
 * than `--title` (which a parser would happily eat) or `--title
 * $title` (which would shift the array by one and mis-parse every
 * subsequent flag).
 *
 * Returns a fresh array; the input is never mutated so callers can
 * share a base config across runs. Unknown `$name` tokens are passed
 * through verbatim so a stale argv shape is easier to debug — the
 * validator in `config.ts` already rejects them at load time.
 */
export function expandArgs(
  args: readonly string[],
  variables: Partial<ArgVariableValues>
): string[] {
  if (args.length === 0) return [];
  return args.map((arg) => substituteVariables(arg, variables));
}

function substituteVariables(
  arg: string,
  variables: Partial<ArgVariableValues>
): string {
  if (arg.indexOf("$") < 0) return arg;
  return arg.replace(ARG_VARIABLE_PATTERN, (match, name: string) => {
    if (!ARG_VARIABLE_NAMES.has(name)) {
      // Leave unknown tokens alone; the strict check in
      // config.ts#validate() catches typos at load time. Letting
      // them through here makes a stale config fail loudly at
      // spawn (with the literal `$name` still in argv) instead of
      // silently dropping the flag.
      return match;
    }
    const key = name as ArgVariable;
    const value = variables[key];
    if (value === undefined || value === null) return "";
    return value;
  });
}

/**
 * Result the loop needs from a finished agent. We deliberately do
 * **not** expose Node's `ChildProcess`; the loop only cares about the
 * exit code, captured stdout + stderr (both truncated to 64 KiB),
 * and an exit reason that distinguishes "killed by runner" from
 * "exited non-zero on its own".
 *
 * `stdout` carries the agent's actual reply and lands in the
 * `task_runs.output` column (s-1185). `stderr` is reserved for true
 * failure context and lands in `task_runs.error`. Conflating the
 * two was the original bug — opencode paints its startup banner to
 * stderr, so a successful run used to look like a failure on the
 * task detail page's "错误信息" / "Error" field.
 */
export interface AgentResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Captured stderr, truncated to `STDERR_TRUNCATE_BYTES`. */
  stderr: string;
  /**
   * Captured stdout, truncated to `STDOUT_TRUNCATE_BYTES`. Empty
   * string when the agent wrote nothing to stdout (e.g. mock agents
   * used in the e2e suite).
   */
  stdout: string;
  /**
   * Why the process ended:
   *   * `exit`        — process called `process.exit` / returned naturally
   *   * `signal`      — killed by SIGTERM / SIGKILL / SIGINT (runner-driven)
   *   * `timeout`     — runner hard-killed because `timeoutMs` elapsed
   *   * `spawn_error` — `spawn()` itself threw
   */
  reason: "exit" | "signal" | "timeout" | "spawn_error";
}

/**
 * Public surface for an in-flight agent. Mirrors the subset of
 * `ChildProcess` the loop touches, plus a `wait()` that resolves with
 * the final `AgentResult`.
 */
export interface AgentProcess {
  /** Send a signal to the child. Defaults to SIGTERM when omitted. */
  kill(signal?: NodeJS.Signals): boolean;
  /** Resolve when the child exits. */
  wait(): Promise<AgentResult>;
  /** Process id when known. */
  readonly pid: number | undefined;
}

/**
 * Primitive a real implementation delegates to. Default is Node's
 * `child_process.spawn`. Tests inject a fake.
 */
export interface ProcessSpawner {
  spawn(opts: SpawnOptions): { process: AgentProcess; cleanup: () => void };
}

/** Options forwarded to the underlying `spawn`. */
export interface SpawnOptions {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** When `true`, wire the child's stdin to the supplied prompt string. */
  pipeStdin?: boolean;
  stdinPayload?: string;
}

/**
 * Default `ProcessSpawner` backed by `child_process.spawn`. Applies
 * the stderr-truncation + signal/timeout semantics the loop depends
 * on.
 */
export class ChildProcessSpawner implements ProcessSpawner {
  private readonly timeoutMs: number;
  private readonly graceMs: number;

  constructor(opts: { timeoutMs: number; graceMs?: number } = { timeoutMs: 1_800_000 }) {
    this.timeoutMs = opts.timeoutMs;
    this.graceMs = opts.graceMs ?? 15_000;
  }

  spawn(opts: SpawnOptions): { process: AgentProcess; cleanup: () => void } {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(opts.bin, opts.args, {
          cwd: opts.cwd,
          env: opts.env,
          stdio: opts.pipeStdin ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
      const reason: AgentResult = {
        exitCode: null,
        signal: null,
        stderr: `spawn failed: ${(err as Error).message}`,
        stdout: "",
        reason: "spawn_error",
      };
      return {
        process: createResolvedProcess(reason),
        cleanup: () => undefined,
      };
    }
    if (!child.pid) {
      const reason: AgentResult = {
        exitCode: null,
        signal: null,
        stderr: "spawn returned a process without a pid",
        stdout: "",
        reason: "spawn_error",
      };
      return {
        process: createResolvedProcess(reason),
        cleanup: () => child.kill("SIGKILL"),
      };
    }
    let stderrBytes = 0;
    let stderrChunks: Buffer[] = [];
    let stderrTruncated = false;
    let stdoutBytes = 0;
    let stdoutChunks: Buffer[] = [];
    let stdoutTruncated = false;
    let deadline: NodeJS.Timeout | null = null;
    let graceTimer: NodeJS.Timeout | null = null;
    let resolveWait: ((r: AgentResult) => void) | null = null;
    let settled = false;
    const cleanupFile: Array<{ path: string }> = [];

    if (child.stderr) {
      child.stderr.on("data", (chunk: Buffer | string) => {
        if (stderrTruncated) return;
        const buf =
          typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
        const remaining = STDERR_TRUNCATE_BYTES - stderrBytes;
        if (buf.length <= remaining) {
          stderrChunks.push(buf);
          stderrBytes += buf.length;
          return;
        }
        if (remaining > 0) {
          stderrChunks.push(buf.subarray(0, remaining));
          stderrBytes = STDERR_TRUNCATE_BYTES;
        } else {
          stderrBytes = STDERR_TRUNCATE_BYTES;
        }
        stderrTruncated = true;
      });
    }
    // Drain stdout so the child's pipe buffer never fills up, AND
    // capture the bytes so the loop can surface the agent's actual
    // reply through /api/v1/runs/:taskId/finish. Pre-s-1185 the
    // bytes were discarded (`on("data", () => undefined)`) which
    // meant opencode's stdout — and every other agent's — was
    // invisible to the task detail page. Real-world agents write
    // substantial text to stdout; a full pipe would block the
    // child until SIGTERM and hide the actual exit reason, so the
    // capture is bounded at `STDOUT_TRUNCATE_BYTES` (64 KiB, the
    // same shape as stderr).
    if (child.stdout) {
      child.stdout.on("data", (chunk: Buffer | string) => {
        if (stdoutTruncated) return;
        const buf =
          typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
        const remaining = STDOUT_TRUNCATE_BYTES - stdoutBytes;
        if (buf.length <= remaining) {
          stdoutChunks.push(buf);
          stdoutBytes += buf.length;
          return;
        }
        if (remaining > 0) {
          stdoutChunks.push(buf.subarray(0, remaining));
          stdoutBytes = STDOUT_TRUNCATE_BYTES;
        } else {
          stdoutBytes = STDOUT_TRUNCATE_BYTES;
        }
        stdoutTruncated = true;
      });
      child.stdout.resume();
    }
    if (opts.pipeStdin && child.stdin) {
      try {
        if (opts.stdinPayload !== undefined) {
          child.stdin.write(opts.stdinPayload);
        }
        child.stdin.end();
      } catch {
        // spawn errors are surfaced via `error` event below
      }
    }
    const settle = (result: AgentResult): void => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      if (graceTimer) clearTimeout(graceTimer);
      resolveWait?.(result);
      for (const f of cleanupFile) {
        try {
          unlinkSync(f.path);
        } catch {
          // best effort
        }
      }
    };
    child.on("error", (err) => {
      settle({
        exitCode: null,
        signal: null,
        stderr: stderrChunks.length
          ? Buffer.concat(stderrChunks).toString("utf8") +
            (stderrTruncated ? "\n[truncated]" : "")
          : `spawn error: ${err.message}`,
        stdout: drainStream(stdoutChunks, stdoutTruncated),
        reason: "spawn_error",
      });
    });
    child.on("close", (code, signal) => {
      const stderrText = stderrChunks.length
        ? Buffer.concat(stderrChunks).toString("utf8") +
          (stderrTruncated ? "\n[truncated]" : "")
        : stderrTruncated
          ? "[truncated]"
          : "";
      const reason: AgentResult["reason"] = signal
        ? signal === "SIGKILL" && graceTimer
          ? "timeout"
          : "signal"
        : "exit";
      settle({
        exitCode: code,
        signal: signal as NodeJS.Signals | null,
        stderr: stderrText,
        stdout: drainStream(stdoutChunks, stdoutTruncated),
        reason,
      });
    });
    deadline = setTimeout(() => {
      if (settled) return;
      try {
        child.kill("SIGTERM");
      } catch {
        // already dead
      }
      graceTimer = setTimeout(() => {
        if (settled) return;
        try {
          child.kill("SIGKILL");
        } catch {
          // already dead
        }
      }, this.graceMs);
    }, this.timeoutMs);
    const waitPromise = new Promise<AgentResult>((resolve) => {
      resolveWait = resolve;
    });
    const agent: AgentProcess = {
      kill: (signal: NodeJS.Signals = "SIGTERM") => {
        try {
          return child.kill(signal);
        } catch {
          return false;
        }
      },
      wait: () => waitPromise,
      pid: child.pid,
    };
    return {
      process: agent,
      cleanup: () => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      },
    };
  }
}

/**
 * Compose the argv + environment + prompt file for an agent
 * invocation. Returns the inputs `ProcessSpawner.spawn` needs along
 * with a `cleanup` callback that removes any temp / project files we
 * created.
 */
export interface PreparedSpawn {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  pipeStdin: boolean;
  stdinPayload?: string;
  cleanup: () => void;
  promptFile?: string;
}

export interface PrepareSpawnOptions {
  cfg: AgentConfig;
  prompt: string;
  taskId: string;
  /** Working directory for the child. Defaults to `cfg.cwd` (or `process.cwd()`). */
  cwd?: string;
  /** Environment to inherit / extend. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Override the temp dir used for `promptMode=arg`. Tests inject this. */
  tmpDir?: string;
  /**
   * Resolved values for every `$name` token the operator may have
   * embedded in `agent.args`. Missing entries become empty strings;
   * unknown `$name` tokens pass through unchanged. The loop passes
   * this in once it has hydrated the task / board / column context.
   */
  variables?: Partial<ArgVariableValues>;
}

/**
 * Pure-ish helper that resolves all the per-run paths and writes
 * any prompt files. Exposed so tests can assert the on-disk shape
 * without spawning anything.
 */
export function prepareSpawn(opts: PrepareSpawnOptions): PreparedSpawn {
  const cfg = opts.cfg;
  const mode: AgentPromptMode = cfg.promptMode ?? "arg";
  const position: AgentPromptPosition = cfg.promptPosition ?? "append";
  const baseCwd = opts.cwd ?? cfg.cwd ?? process.cwd();
  const cwd = isAbsolute(baseCwd) ? baseCwd : resolve(process.cwd(), baseCwd);
  const env: NodeJS.ProcessEnv = {
    ...(opts.env ?? process.env),
    ...(cfg.env ?? {}),
  };
  // Step 1: substitute `$name` tokens in the operator's args. Done
  // before the prompt splice so the prompt flag (which never carries
  // a `$name`) is never affected and so an operator who sets
  // `promptPosition: replace` with a `$name` token alongside
  // `{prompt}` still sees the prompt pair land in the right slot.
  const baseArgs = expandArgs(cfg.args ?? [], opts.variables ?? {});
  const createdFiles: string[] = [];
  let pipeStdin = false;
  let stdinPayload: string | undefined;
  let promptArg = cfg.promptArg ?? "--prompt";
  if (mode === "acp") {
    // s-1235: the ACP path needs the child's stdio fully piped so
    // the JSON-RPC client can drive the handshake. The prompt
    // content travels inside the `session/prompt` JSON-RPC payload,
    // not via argv, so we have nothing to write to disk and nothing
    // to splice into the agent's command line besides the opt-in
    // flag. We still expand `$name` tokens above so an operator who
    // embeds per-task data in their pre-flag args keeps the same
    // semantics they get from every other mode.
    const acpFlag = cfg.acpFlag ?? "--acp";
    baseArgs.push(acpFlag);
    pipeStdin = true;
    stdinPayload = undefined;
    return {
      bin: cfg.binPath ?? cfg.bin,
      args: baseArgs,
      cwd,
      env,
      pipeStdin,
      stdinPayload,
      cleanup: () => undefined,
    };
  }
  if (mode === "stdin") {
    pipeStdin = true;
    stdinPayload = opts.prompt;
  } else if (mode === "argv") {
    // s-1191: pass the prompt content directly as a single positional
    // argv entry. Required for agents like `opencode run [message..]`
    // that take the message as a positional argument rather than via a
    // `--prompt <file>` flag. The prompt is **not** written to disk;
    // nothing to clean up. Operator is responsible for staying within
    // the OS argv limit (Windows: 32 KiB; macOS / Linux: no real cap).
    //
    // The shared `insertPrompt` helper expects a `[flag, value]`
    // pair, which doesn't fit a single-entry positional arg, so the
    // three `promptPosition` modes are inlined. For `"replace"` the
    // `{prompt}` token in `agent.args` is replaced with the prompt
    // content directly, so the operator can write e.g.
    // `["opencode", "run", "{prompt}"]` and get
    // `["opencode", "run", "the actual prompt"]` at spawn time.
    if (position === "replace") {
      const idx = baseArgs.indexOf(PROMPT_PLACEHOLDER);
      if (idx >= 0) {
        baseArgs.splice(idx, 1, opts.prompt);
      } else {
        // validate() rejects the missing-placeholder case; this is
        // a defensive fallback so a malformed runtime call never
        // silently drops the prompt.
        baseArgs.push(opts.prompt);
      }
    } else if (position === "prepend") {
      baseArgs.unshift(opts.prompt);
    } else {
      baseArgs.push(opts.prompt);
    }
  } else if (mode === "file") {
    const file = join(cwd, `.kanban-runner-${sanitiseTaskId(opts.taskId)}.md`);
    writeFileSync(file, opts.prompt, "utf8");
    createdFiles.push(file);
    promptArg = `${promptArg}-file`;
    insertPrompt(baseArgs, [promptArg, file], position);
  } else {
    const dir = mkdtempSync(join(opts.tmpDir ?? tmpdir(), "kanban-runner-"));
    const file = join(dir, `prompt-${randomUUID()}.md`);
    writeFileSync(file, opts.prompt, "utf8");
    createdFiles.push(file);
    createdFiles.push(dir);
    insertPrompt(baseArgs, [promptArg, file], position);
  }
  const cleanup = (): void => {
    for (const f of createdFiles) {
      try {
        rmSync(f, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  };
  return {
    bin: cfg.binPath ?? cfg.bin,
    args: baseArgs,
    cwd,
    env,
    pipeStdin,
    stdinPayload,
    cleanup,
    promptFile: createdFiles[0],
  };
}

/**
 * Splice `[promptArg, promptPath]` into `baseArgs` according to
 * `position`. Three outcomes:
 *
 *   * `"append"`  — push the pair to the end (default, backward
 *                   compatible with the original argv layout).
 *   * `"prepend"` — unshift the pair to the start.
 *   * `"replace"` — find the unique `{prompt}` token in `baseArgs`
 *                   and replace it in place with the pair. We do the
 *                   splice here even though `config.validate` already
 *                   enforces uniqueness; doing the work in a single
 *                   place keeps the runtime path free of throw
 *                   branches.
 *
 * The `argv` mode (s-1191) reuses this helper with a synthetic pair
 * where the "flag" slot is the empty string and the "path" slot is the
 * prompt content — so a `{prompt}` placeholder in `agent.args` lands
 * in the right slot when the operator wants the prompt as a single
 * positional argv entry (e.g. `opencode run {prompt}`). When the
 * placeholder is absent we fall back to pushing the prompt content
 * directly so the operator never silently loses the message.
 */
function insertPrompt(
  baseArgs: string[],
  promptPair: [string, string],
  position: AgentPromptPosition
): void {
  if (position === "prepend") {
    baseArgs.unshift(promptPair[1]);
    baseArgs.unshift(promptPair[0]);
    return;
  }
  if (position === "replace") {
    const idx = baseArgs.indexOf(PROMPT_PLACEHOLDER);
    if (idx < 0) {
      // validate() rejects the missing-placeholder case; this is a
      // defensive fallback so a malformed runtime call never silently
      // drops the prompt.
      baseArgs.push(promptPair[0], promptPair[1]);
      return;
    }
    baseArgs.splice(idx, 1, promptPair[0], promptPair[1]);
    return;
  }
  baseArgs.push(promptPair[0], promptPair[1]);
}

/**
 * Read a prompt file back from disk — handy in tests that want to
 * assert the agent binary received the exact bytes we wrote.
 */
export function readPromptFile(path: string): string {
  return readFileSync(path, "utf8");
}

/** High-level façade: prepare + spawn a single agent run. */
export class AgentSpawner {
  private readonly spawner: ProcessSpawner;
  private readonly cfg: AgentConfig;

  constructor(cfg: AgentConfig, spawner: ProcessSpawner) {
    this.cfg = cfg;
    this.spawner = spawner;
  }

  spawn(opts: PrepareSpawnOptions): { process: AgentProcess; cleanup: () => void } {
    // s-1235: ACP needs bidirectional control of the child's stdio
    // so the existing `ProcessSpawner` shape (fire-and-forget) does
    // not fit. The ACP path bypasses `prepareSpawn` for the spawn
    // step but still reuses its argv + env + cwd resolution by
    // delegating to `spawnAcpAgent` with the same resolved values.
    if ((this.cfg.promptMode ?? "arg") === "acp") {
      const prepared = prepareSpawn({ ...opts, cfg: this.cfg });
      return spawnAcpAgent({
        bin: prepared.bin,
        args: prepared.args,
        cwd: prepared.cwd,
        env: prepared.env,
        timeoutMs: this.cfg.timeoutMs ?? 1_800_000,
        prompt: opts.prompt,
      });
    }
    const prepared = prepareSpawn({ ...opts, cfg: this.cfg });
    const out = this.spawner.spawn({
      bin: prepared.bin,
      args: prepared.args,
      cwd: prepared.cwd,
      env: prepared.env,
      pipeStdin: prepared.pipeStdin,
      stdinPayload: prepared.stdinPayload,
    });
    const userCleanup = prepared.cleanup;
    return {
      process: out.process,
      cleanup: () => {
        userCleanup();
        out.cleanup();
      },
    };
  }
}

/**
 * Spawn a child process that speaks the Agent Client Protocol and
 * drive the full handshake → prompt round-trip via `AcpClient`. The
 * returned `AgentProcess` resolves with an `AgentResult` shaped
 * exactly like the non-ACP paths so the loop's `wait()` / `kill()`
 * contract is identical regardless of how the prompt was delivered.
 *
 * `spawnAcpAgent` is intentionally **not** wrapped behind the
 * `ProcessSpawner` interface: we need synchronous access to the
 * child's stdin / stdout streams so the JSON-RPC client can write
 * requests and parse responses, which the fire-and-forget spawner
 * does not expose. Tests substitute a `LineJsonTransport` against
 * a fake `child_process.spawn` to drive the same code path.
 */
export interface SpawnAcpOptions {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Per-task hard ceiling in milliseconds. */
  timeoutMs: number;
  /** Rendered prompt content sent via the ACP `session/prompt` request. */
  prompt: string;
  /**
   * Cancel signal — fired when the runner wants to abort the agent.
   * Wired to the loop's `AbortController` so SIGINT/SIGTERM tear
   * down the handshake cleanly instead of leaving the child alive.
   */
  cancelSignal?: AbortSignal;
}

/**
 * Spawn the agent and drive the full ACP round-trip. Mirrors the
 * `ChildProcessSpawner` timeout / signal semantics so a hung agent
 * is reaped the same way the non-ACP path would reap it.
 */
export function spawnAcpAgent(opts: SpawnAcpOptions): {
  process: AgentProcess;
  cleanup: () => void;
} {
  const { bin, args, cwd, env, timeoutMs, prompt } = opts;
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(bin, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    const reason: AgentResult = {
      exitCode: null,
      signal: null,
      stderr: `spawn failed: ${(err as Error).message}`,
      stdout: "",
      reason: "spawn_error",
    };
    return {
      process: createResolvedProcess(reason),
      cleanup: () => undefined,
    };
  }
  if (!child.pid) {
    const reason: AgentResult = {
      exitCode: null,
      signal: null,
      stderr: "spawn returned a process without a pid",
      stdout: "",
      reason: "spawn_error",
    };
    return {
      process: createResolvedProcess(reason),
      cleanup: () => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already dead
        }
      },
    };
  }
  // Stderr capture — kept in lock-step with `ChildProcessSpawner`
  // so the JSON-RPC fail path populates `result.stderr` the same
  // way a non-ACP agent would.
  let stderrBytes = 0;
  let stderrChunks: Buffer[] = [];
  let stderrTruncated = false;
  if (child.stderr) {
    child.stderr.on("data", (chunk: Buffer | string) => {
      if (stderrTruncated) return;
      const buf =
        typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      const remaining = STDERR_TRUNCATE_BYTES - stderrBytes;
      if (buf.length <= remaining) {
        stderrChunks.push(buf);
        stderrBytes += buf.length;
        return;
      }
      if (remaining > 0) {
        stderrChunks.push(buf.subarray(0, remaining));
        stderrBytes = STDERR_TRUNCATE_BYTES;
      }
      stderrTruncated = true;
    });
  }

  // Wire the ACP client over the child's stdio. We close stdin at
  // the end of the handshake so the agent sees a clean EOF; agents
  // use that as the cue to release any background work and exit.
  const transport = new LineJsonTransport(child.stdin!, child.stdout!);
  const client = new AcpClient({
    transport,
    cwd,
    cancelSignal: opts.cancelSignal,
  });
  let waitPromise: Promise<AgentResult> | null = null;
  let settled = false;
  let resolveWait: ((r: AgentResult) => void) | null = null;
  const settle = (result: AgentResult): void => {
    if (settled) return;
    settled = true;
    if (deadline) clearTimeout(deadline);
    if (graceTimer) clearTimeout(graceTimer);
    resolveWait?.(result);
  };
  let deadline: NodeJS.Timeout | null = null;
  let graceTimer: NodeJS.Timeout | null = null;
  child.on("error", (err) => {
    const stderrText = stderrChunks.length
      ? Buffer.concat(stderrChunks).toString("utf8") +
        (stderrTruncated ? "\n[truncated]" : "")
      : `spawn error: ${err.message}`;
    settle({
      exitCode: null,
      signal: null,
      stderr: stderrText,
      stdout: "",
      reason: "spawn_error",
    });
  });
  child.on("close", (code, signal) => {
    const stderrText = stderrChunks.length
      ? Buffer.concat(stderrChunks).toString("utf8") +
        (stderrTruncated ? "\n[truncated]" : "")
      : stderrTruncated
        ? "[truncated]"
        : "";
    const reason: AgentResult["reason"] = signal
      ? signal === "SIGKILL" && graceTimer
        ? "timeout"
        : "signal"
      : "exit";
    // Only override an in-flight ACP result with the close signal
    // when the handshake hasn't already produced a usable result.
    settle({
      exitCode: code,
      signal: signal as NodeJS.Signals | null,
      stderr: stderrText,
      stdout: "",
      reason,
    });
  });
  deadline = setTimeout(() => {
    if (settled) return;
    try {
      child.kill("SIGTERM");
    } catch {
      // already dead
    }
    graceTimer = setTimeout(() => {
      if (settled) return;
      try {
        child.kill("SIGKILL");
      } catch {
        // already dead
      }
    }, 15_000);
  }, timeoutMs);
  waitPromise = new Promise<AgentResult>((resolve) => {
    resolveWait = resolve;
  });
  // Kick off the handshake. We deliberately don't await it here so
  // the loop can register `kill()` / `wait()` immediately; the
  // promise chain resolves the wait promise when the handshake
  // completes (or with a spawn_error if the agent rejected the
  // handshake).
  void (async () => {
    let result: AgentResult;
    try {
      const acpResult = await client.run(prompt);
      // Merge the agent's stderr capture with anything the ACP
      // handshake layer surfaced (initialise failures, malformed
      // JSON frames, etc.) so the finish pipe sees the same shape
      // it would for a non-ACP agent.
      const stderrText = stderrChunks.length
        ? Buffer.concat(stderrChunks).toString("utf8") +
          (stderrTruncated ? "\n[truncated]" : "")
        : stderrTruncated
          ? "[truncated]"
          : "";
      result = {
        exitCode: acpResult.exitCode,
        signal: acpResult.signal,
        stderr: acpResult.stderr
          ? stderrText
            ? `${acpResult.stderr}\n${stderrText}`
            : acpResult.stderr
          : stderrText,
        stdout: acpResult.stdout,
        reason: acpResult.reason,
      };
    } catch (err) {
      const stderrText = stderrChunks.length
        ? Buffer.concat(stderrChunks).toString("utf8") +
          (stderrTruncated ? "\n[truncated]" : "")
        : stderrTruncated
          ? "[truncated]"
          : "";
      result = {
        exitCode: null,
        signal: null,
        stderr: stderrText || `ACP handshake failed: ${(err as Error).message}`,
        stdout: "",
        reason: "spawn_error",
      };
    }
    // Close stdin so the agent can shut down cleanly; the close
    // event will eventually arrive but we don't want to wait on it
    // before resolving the wait promise — the handshake result is
    // already authoritative.
    try {
      child.stdin?.end();
    } catch {
      // already closed
    }
    settle(result);
  })();
  const agent: AgentProcess = {
    kill: (signal: NodeJS.Signals = "SIGTERM") => {
      try {
        return child.kill(signal);
      } catch {
        return false;
      }
    },
    wait: () => waitPromise!,
    pid: child.pid,
  };
  return {
    process: agent,
    cleanup: () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    },
  };
}

function sanitiseTaskId(taskId: string): string {
  return taskId.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * Concatenate the captured stdout chunks into a single string and
 * append a truncation marker when the 64 KiB cap kicked in. The
 * shape mirrors the stderr helper above so the UI can render the
 * two streams with the same truncation signal.
 */
function drainStream(chunks: Buffer[], truncated: boolean): string {
  if (chunks.length === 0) {
    return truncated ? "[truncated]" : "";
  }
  return Buffer.concat(chunks).toString("utf8") + (truncated ? "\n[truncated]" : "");
}

function createResolvedProcess(result: AgentResult): AgentProcess {
  let resolved = false;
  return {
    kill: () => false,
    pid: undefined,
    wait: () => {
      if (!resolved) {
        resolved = true;
      }
      return Promise.resolve(result);
    },
  };
}
