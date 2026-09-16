// Runner configuration types — mirrors the YAML schema described in §2.2
// of `devDoc/CLI_RUNNER_PLAN_2026-09-12.md`.
//
// The on-disk format is YAML; we keep a parallel JSON shape for the
// global fallback (`~/.config/kanban-cli/runner.json`) because not every
// runner host will have a YAML parser handy when bootstrapping.
//
// Two `mode` fields exist on purpose and live in different namespaces:
//
//   * `RunnerConfig.mode` — top-level mode selector; the only supported
//     value today is `"mine"`, which means "watch tasks assigned to me
//     across all boards" (see §4.3).
//   * `RunnerSettings.mode` — server-side claim primitive, either
//     `"claim"` (server-managed claim + heartbeat) or `"move"` (status
//     move only). Defaults to `"claim"` per §2.2.

export type RunnerTopMode = "mine";

export type RunnerClaimMode = "claim" | "move";

export type AgentPromptMode = "arg" | "stdin" | "file";

/**
 * Where the `--prompt <path>` (or `--prompt-file <path>`) pair is
 * spliced into the agent's argv. Three values cover the common cases:
 *
 *   * `"append"`  — default. Sits at the end of argv, after every
 *                   entry of `agent.args`. Mirrors the original
 *                   behaviour so existing configs keep working.
 *   * `"prepend"` — Sits at the start of argv, before every entry of
 *                   `agent.args`. Useful when the agent treats
 *                   later flags as overriding earlier ones.
 *   * `"replace"` — The user embeds the literal token `"{prompt}"`
 *                   somewhere in `agent.args`; the runner splices
 *                   `--prompt <path>` (or `--prompt-file <path>` for
 *                   `promptMode: file`) in place of that token. Lets
 *                   an operator position the prompt anywhere in argv,
 *                   e.g. `opencode --auto true run {prompt}` for the
 *                   agent's `run` subcommand. The token must appear
 *                   exactly once; missing or duplicate tokens are
 *                   surfaced as a config error at validation time.
 */
export type AgentPromptPosition = "append" | "prepend" | "replace";

/**
 * Subset of `TaskStatus` we accept as the column filter in
 * `.kanban-runner.yaml`. We type this as a string union so the strict
 * mode check catches typos early; the runtime also rejects anything
 * outside this set so adding a new column status here is a one-line
 * change.
 */
export type RunnerStatus = "todo" | "in_progress" | "review" | "done";

/**
 * Variables the runner recognises inside `agent.args` strings. Any
 * occurrence of `$name` (where `name` matches one of these strings) is
 * substituted with the corresponding field of the in-flight task
 * before the agent binary is spawned. Unknown `$name` tokens are
 * rejected at config-validation time so a typo never silently leaks
 * through to the spawned process.
 *
 * Naming follows the task description for s-1187: the operator
 * composes argv with literal pieces and lets the runner fill in the
 * dynamic ones (`$taskId`, `$title`, `$body`, …). Keeping the set
 * small + explicit (rather than e.g. mapping every `TaskRecord` field)
 * makes the on-disk config self-documenting and lets the validator
 * refuse accidental typos.
 */
export const SUPPORTED_ARG_VARIABLES = [
  "taskId",
  "title",
  "body",
  "priority",
  "assignee",
  "columnId",
  "boardId",
] as const;

export type ArgVariable = (typeof SUPPORTED_ARG_VARIABLES)[number];

/**
 * Resolved values for every supported `ArgVariable`. Missing fields
 * are represented as empty strings — the spawn layer treats a missing
 * value the same as a known-empty one, so the operator never has to
 * guard against `undefined` at the call site. Empty fields still
 * render (e.g. `--title=`), which matches the convention most CLI
 * agents use to signal "absent".
 */
export interface ArgVariableValues {
  taskId: string;
  title: string;
  body: string;
  priority: string;
  assignee: string;
  columnId: string;
  boardId: string;
}

export interface AgentConfig {
  /** Binary name resolved via PATH, or — when `binPath` is set — absolute path. */
  bin: string;
  /** Optional absolute path that overrides the PATH lookup. */
  binPath?: string;
  /** How the agent receives the rendered prompt. */
  promptMode?: AgentPromptMode;
  /** Flag passed alongside the prompt when `promptMode === "arg"`. */
  promptArg?: string;
  /**
   * Where the prompt is spliced into argv. Defaults to `"append"`.
   * See `AgentPromptPosition` for the three supported modes.
   */
  promptPosition?: AgentPromptPosition;
  /** Working directory when spawning the agent. */
  cwd?: string;
  /** Extra arguments appended after the prompt. Replaced wholesale on merge. */
  args?: string[];
  /** Extra env vars merged into the agent's process.env. Replaced wholesale on merge. */
  env?: Record<string, string>;
  /** Hard ceiling per task in milliseconds. */
  timeoutMs?: number;
}

export interface RunnerSettings {
  /** Optional runner identifier; defaults to `${hostname()}-${pid()}-${uuid()}`. */
  runnerId?: string;
  /** Idle poll cadence in milliseconds. */
  pollIntervalMs?: number;
  /** In-flight heartbeat cadence in milliseconds. */
  heartbeatIntervalMs?: number;
  /** Server-side expiry of an orphan lock in milliseconds. */
  lockTimeoutMs?: number;
  /** Number of concurrent tasks; today always 1. */
  maxConcurrent?: number;
  /** Server-side claim primitive. */
  mode?: RunnerClaimMode;
}

export interface RunnerConfig {
  /** Schema version. Defaults to 1 when absent. */
  version: number;
  /** Optional API base URL; falls back to the CLI's resolved config. */
  apiUrl?: string;
  /** Optional credential profile name. */
  profile?: string;
  /** Mode-1 (board-bound) selector — required when `mode !== "mine"`. */
  boardId?: string;
  /** Mode-1 (board-bound) column status to watch. */
  status?: RunnerStatus;
  /** Top-level mode. Currently the only supported value is `"mine"`. */
  mode?: RunnerTopMode;
  /** Agent binary invocation block. */
  agent: AgentConfig;
  /** Runner-loop tuning block. */
  runner: RunnerSettings;
}

/**
 * Built-in defaults applied after merge so every consumer of
 * `RunnerConfig` can rely on `runner.pollIntervalMs` etc. being a number.
 *
 * These mirror §2.2 verbatim except where noted.
 */
export const RUNNER_DEFAULTS = Object.freeze({
  version: 1 as number,
  agent: {
    promptMode: "arg" as AgentPromptMode,
    promptArg: "--prompt",
    promptPosition: "append" as AgentPromptPosition,
    cwd: ".",
    args: [] as string[],
    env: {} as Record<string, string>,
    timeoutMs: 1_800_000,
  },
  runner: {
    runnerId: "" as string,
    pollIntervalMs: 5_000,
    heartbeatIntervalMs: 30_000,
    lockTimeoutMs: 120_000,
    maxConcurrent: 1,
    mode: "claim" as RunnerClaimMode,
  },
});
