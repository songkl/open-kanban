// Child-process wrapper — owns the spawn / signal / timeout / stderr-
// truncation semantics described in §4.2 / §4.5 of
// `devDoc/CLI_RUNNER_PLAN_2026-09-12.md`.
//
// Two interfaces drive this module:
//
//   * `AgentSpawner` — the public façade the loop calls. Returns an
//     `AgentProcess` that exposes the same surface Node's
//     `ChildProcess` does (kill, wait, stdout/stderr), but with two
//     additional guarantees: stderr is **always truncated to 64 KiB**,
//     and a `timeoutMs` ceiling always kills the child (SIGTERM, then
//     SIGKILL after a grace period).
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
import type {
  AgentConfig,
  AgentPromptMode,
  AgentPromptPosition,
} from "./types.js";

/** Hard cap on the stderr payload the loop forwards to `/finish`. */
export const STDERR_TRUNCATE_BYTES = 64 * 1024;

/**
 * Literal token operators embed in `agent.args` when
 * `promptPosition: "replace"`. The runner substitutes the prompt
 * flag + path for this single occurrence; missing or duplicate
 * occurrences fail at config-validation time so the operator never
 * sees a half-formed spawn.
 */
export const PROMPT_PLACEHOLDER = "{prompt}";

/**
 * Result the loop needs from a finished agent. We deliberately do
 * **not** expose Node's `ChildProcess`; the loop only cares about the
 * exit code, captured stderr (truncated), and an exit reason that
 * distinguishes "killed by runner" from "exited non-zero on its own".
 */
export interface AgentResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Captured stderr, truncated to `STDERR_TRUNCATE_BYTES`. */
  stderr: string;
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
    // Drain stdout so the child's pipe buffer never fills up. The
    // mock agents used in the e2e suite write nothing to stdout,
    // but real-world agents (opencode, claude, cursor) do — and a
    // full pipe would block the child until SIGTERM, hiding the
    // actual exit reason from the loop. We discard the bytes
    // because the plan's prompt rendering is via temp file / arg,
    // never via stdout capture.
    if (child.stdout) {
      child.stdout.on("data", () => undefined);
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
  const baseArgs = (cfg.args ?? []).slice();
  const createdFiles: string[] = [];
  let pipeStdin = false;
  let stdinPayload: string | undefined;
  let promptArg = cfg.promptArg ?? "--prompt";
  if (mode === "stdin") {
    pipeStdin = true;
    stdinPayload = opts.prompt;
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

function sanitiseTaskId(taskId: string): string {
  return taskId.replace(/[^A-Za-z0-9._-]/g, "_");
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
