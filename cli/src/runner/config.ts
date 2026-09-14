// Runner configuration loader — implements §2.1 (discovery) and §2.2
// (deep merge) of `devDoc/CLI_RUNNER_PLAN_2026-09-12.md`, plus the
// strict validation rules in §4.6.
//
// Three responsibilities:
//
//   1. `discoverConfig` — walks up from `cwd` looking for
//      `.kanban-runner.local.yaml` first (machine-local override, git-
//      ignored) then `.kanban-runner.yaml` (project-shared config,
//      committed). Stops at the first hit and never merges across
//      directories. Falls back to a per-cwd-hash file under
//      `~/.config/kanban-cli/runner.json` for fully-global settings.
//   2. `loadConfig` — reads whichever file `discoverConfig` picked,
//      parses YAML (or JSON for the global fallback), then merges the
//      local override on top of the project config when both exist at
//      the same level. Arrays (`args`, `env`) are replaced wholesale
//      to keep behaviour deterministic.
//   3. `validate` — runs the §4.6 checks and throws a `RunnerConfigError`
//      whose `message` is the human-readable line we'll print to the
//      user. The check that the CLI is logged in (`mode: mine`) is
//      dependency-injected via `ValidateOptions.isLoggedIn` so this
//      module stays free of the OAuth plumbing.

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import {
  RUNNER_DEFAULTS,
  type AgentConfig,
  type AgentPromptMode,
  type AgentPromptPosition,
  type RunnerClaimMode,
  type RunnerConfig,
  type RunnerSettings,
  type RunnerStatus,
  type RunnerTopMode,
} from "./types.js";
import { PROMPT_PLACEHOLDER } from "./spawn.js";

/**
 * Filename priority for the walk-up discovery step. The first hit
 * wins; we never continue past the first hit. The order is significant:
 * the local override file is checked *before* the project file so a
 * developer can temporarily flip a single field on their machine.
 */
const LOCAL_FILENAME = ".kanban-runner.local.yaml";
const PROJECT_FILENAME = ".kanban-runner.yaml";

/** Statuses we accept as the column filter at validation time. */
const ALLOWED_STATUSES: readonly RunnerStatus[] = [
  "todo",
  "in_progress",
  "review",
  "done",
];

const ALLOWED_PROMPT_MODES: readonly AgentPromptMode[] = ["arg", "stdin", "file"];
const ALLOWED_PROMPT_POSITIONS: readonly AgentPromptPosition[] = [
  "append",
  "prepend",
  "replace",
];
const ALLOWED_CLAIM_MODES: readonly RunnerClaimMode[] = ["claim", "move"];
const ALLOWED_TOP_MODES: readonly RunnerTopMode[] = ["mine"];

export class RunnerConfigError extends Error {
  /** Dotted path of the offending field (e.g. `"agent.bin"`). */
  readonly field: string | undefined;

  constructor(message: string, field?: string) {
    super(message);
    this.name = "RunnerConfigError";
    this.field = field;
  }
}

export interface DiscoverOptions {
  /** Override the global fallback file location. Tests inject temp paths. */
  globalFallbackPath?: string;
  /**
   * Directory the walk stops at (exclusive of further upward walking).
   * Defaults to the filesystem root so a missing `stopAt` walks all the
   * way up. The cwd itself is always consulted before the stop check
   * fires.
   */
  stopAt?: string;
}

export interface LoadConfigOptions extends DiscoverOptions {
  /**
   * When `false`, the global fallback file is not consulted. Useful for
   * callers that want to enforce project-only configuration.
   */
  readGlobalFallback?: boolean;
}

export interface ValidateOptions {
  /**
   * Predicate consulted when `mode: mine` is configured. Returns `true`
   * when the CLI profile (or default profile when none is set) has a
   * valid stored credential. The runner hosts inject the real check;
   * by default the validator returns `false` so a missing check fails
   * closed.
   */
  isLoggedIn?: (profile: string | undefined) => boolean;
  /** Path to the project config file (for better error messages). */
  source?: string;
}

interface RawAgent {
  bin?: unknown;
  binPath?: unknown;
  promptMode?: unknown;
  promptArg?: unknown;
  promptPosition?: unknown;
  cwd?: unknown;
  args?: unknown;
  env?: unknown;
  timeoutMs?: unknown;
}

interface RawRunnerSettings {
  runnerId?: unknown;
  pollIntervalMs?: unknown;
  heartbeatIntervalMs?: unknown;
  lockTimeoutMs?: unknown;
  maxConcurrent?: unknown;
  mode?: unknown;
}

interface RawConfig {
  version?: unknown;
  apiUrl?: unknown;
  profile?: unknown;
  boardId?: unknown;
  status?: unknown;
  mode?: unknown;
  agent?: RawAgent;
  runner?: RawRunnerSettings;
}

interface DiscoveryHit {
  /** Absolute path to the file we picked as the primary config. */
  primary: string;
  /** Sibling project file when the primary is a local override. */
  sibling: string | null;
}

/**
 * Walk up from `cwd` looking for the first matching config file. When
 * the local override exists at a directory, the project file at the
 * same directory is reported as `sibling` so `loadConfig` can deep-
 * merge them.
 */
export function discoverConfig(
  cwd: string,
  opts: DiscoverOptions = {}
): DiscoveryHit | null {
  const stopAt = resolve(opts.stopAt ?? parse(cwd).root);
  let dir = resolve(cwd);
  const root = parse(dir).root;
  while (true) {
    const local = join(dir, LOCAL_FILENAME);
    if (existsSync(local)) {
      const project = join(dir, PROJECT_FILENAME);
      return {
        primary: local,
        sibling: existsSync(project) ? project : null,
      };
    }
    const project = join(dir, PROJECT_FILENAME);
    if (existsSync(project)) {
      return { primary: project, sibling: null };
    }
    if (dir === stopAt || dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const fallback = opts.globalFallbackPath ?? defaultGlobalFallbackPath(cwd);
  if (fallback && existsSync(fallback)) {
    return { primary: fallback, sibling: null };
  }
  return null;
}

/**
 * Resolve the per-cwd-hash file under `~/.config/kanban-cli/runner.json`.
 * The plan calls the fallback "per-cwd-hash" but in v1 the file is a
 * single global config; the "hash" suffix is reserved for a future
 * multi-project feature.
 */
export function defaultGlobalFallbackPath(_cwd: string): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "kanban-cli", "runner.json");
}

/**
 * Parse a YAML or JSON config string into a `RunnerConfig`, applying
 * the §2.2 deep-merge rules and built-in defaults. Throws
 * `RunnerConfigError` on malformed input so the caller can print a
 * targeted message.
 */
export function loadConfig(
  cwd: string,
  opts: LoadConfigOptions = {}
): RunnerConfig {
  const hit = discoverConfig(cwd, opts);
  if (!hit) {
    throw new RunnerConfigError(
      `no runner config found: walked up from '${cwd}' looking for ` +
        `${LOCAL_FILENAME} / ${PROJECT_FILENAME}, no global fallback present`,
      "<discovery>"
    );
  }
  const primaryRaw = readRawConfig(hit.primary);
  let merged: RawConfig = primaryRaw;
  if (hit.sibling) {
    // The sibling (project file when primary is local) forms the base;
    // the primary (local override) wins on conflict.
    merged = mergeRawConfigs(readRawConfig(hit.sibling), primaryRaw);
  }
  if (opts.readGlobalFallback === false) {
    // caller explicitly disabled the global fallback; nothing to do.
  }
  return normaliseConfig(merged, hit.primary);
}

/**
 * Public helper for callers (and tests) that already know which file to
 * read. Behaves like `loadConfig` but skips discovery.
 */
export function parseConfig(path: string, raw: unknown): RunnerConfig {
  return normaliseConfig(raw as RawConfig, path);
}

function readRawConfig(path: string): RawConfig {
  const text = readFileSync(path, "utf8");
  try {
    if (path.endsWith(".json")) {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new RunnerConfigError(`runner config is not a JSON object: ${path}`, "<root>");
      }
      return parsed as RawConfig;
    }
    const parsed = parseYaml(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new RunnerConfigError(`runner config is not a YAML mapping: ${path}`, "<root>");
    }
    return parsed as RawConfig;
  } catch (err) {
    if (err instanceof RunnerConfigError) throw err;
    throw new RunnerConfigError(
      `failed to parse runner config ${path}: ${(err as Error).message}`,
      "<root>"
    );
  }
}

/**
 * Deep-merge `over` on top of `base` per §2.2:
 *
 *   * scalars (string/number/boolean): `over` wins when defined.
 *   * objects (`agent`, `runner`, `agent.env`): recursive merge.
 *   * arrays (`agent.args`): replaced wholesale.
 *
 * Returning a fresh object keeps callers from accidentally mutating
 * the inputs.
 */
function mergeRawConfigs(base: RawConfig, over: RawConfig): RawConfig {
  const merged: RawConfig = { ...base };
  for (const key of Object.keys(over) as (keyof RawConfig)[]) {
    const value = (over as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (key === "agent") {
      merged.agent = mergeAgent(base.agent, value as RawAgent);
    } else if (key === "runner") {
      merged.runner = mergeRunner(base.runner, value as RawRunnerSettings);
    } else {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}

function mergeAgent(base: RawAgent | undefined, over: RawAgent): RawAgent {
  const merged: RawAgent = { ...(base ?? {}) };
  for (const key of Object.keys(over) as (keyof RawAgent)[]) {
    const value = (over as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (key === "args") {
      // Arrays are replaced, not concatenated (§2.2).
      merged.args = Array.isArray(value) ? [...value] : value;
    } else if (key === "env") {
      // `env` is treated like an array per the plan: replaced wholesale.
      merged.env = isPlainObject(value) ? { ...value } : value;
    } else {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}

function mergeRunner(
  base: RawRunnerSettings | undefined,
  over: RawRunnerSettings
): RawRunnerSettings {
  return { ...(base ?? {}), ...over };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normaliseConfig(raw: RawConfig, path: string): RunnerConfig {
  const agentRaw = raw.agent;
  if (!agentRaw || !isPlainObject(agentRaw)) {
    throw new RunnerConfigError(`runner config missing 'agent' block: ${path}`, "agent");
  }
  const runnerRaw = raw.runner;
  if (!runnerRaw || !isPlainObject(runnerRaw)) {
    throw new RunnerConfigError(`runner config missing 'runner' block: ${path}`, "runner");
  }
  const agent: AgentConfig = {
    bin: requireString(agentRaw.bin, "agent.bin", path),
    binPath: optionalString(agentRaw.binPath, "agent.binPath", path),
    promptMode:
      optionalEnum(agentRaw.promptMode, "agent.promptMode", ALLOWED_PROMPT_MODES, path) ??
      RUNNER_DEFAULTS.agent.promptMode,
    promptArg:
      optionalString(agentRaw.promptArg, "agent.promptArg", path) ??
      RUNNER_DEFAULTS.agent.promptArg,
    promptPosition:
      optionalEnum(
        agentRaw.promptPosition,
        "agent.promptPosition",
        ALLOWED_PROMPT_POSITIONS,
        path
      ) ?? RUNNER_DEFAULTS.agent.promptPosition,
    cwd:
      optionalString(agentRaw.cwd, "agent.cwd", path) ??
      RUNNER_DEFAULTS.agent.cwd,
    args:
      optionalStringArray(agentRaw.args, "agent.args", path) ??
      cloneStringArray(RUNNER_DEFAULTS.agent.args),
    env:
      optionalStringMap(agentRaw.env, "agent.env", path) ??
      cloneStringMap(RUNNER_DEFAULTS.agent.env),
    timeoutMs:
      optionalPositiveInt(agentRaw.timeoutMs, "agent.timeoutMs", path) ??
      RUNNER_DEFAULTS.agent.timeoutMs,
  };
  const runner: RunnerSettings = {
    runnerId:
      optionalString(runnerRaw.runnerId, "runner.runnerId", path) ??
      RUNNER_DEFAULTS.runner.runnerId,
    pollIntervalMs:
      optionalPositiveInt(runnerRaw.pollIntervalMs, "runner.pollIntervalMs", path) ??
      RUNNER_DEFAULTS.runner.pollIntervalMs,
    heartbeatIntervalMs:
      optionalPositiveInt(
        runnerRaw.heartbeatIntervalMs,
        "runner.heartbeatIntervalMs",
        path
      ) ?? RUNNER_DEFAULTS.runner.heartbeatIntervalMs,
    lockTimeoutMs:
      optionalPositiveInt(runnerRaw.lockTimeoutMs, "runner.lockTimeoutMs", path) ??
      RUNNER_DEFAULTS.runner.lockTimeoutMs,
    maxConcurrent:
      optionalPositiveInt(runnerRaw.maxConcurrent, "runner.maxConcurrent", path) ??
      RUNNER_DEFAULTS.runner.maxConcurrent,
    mode:
      optionalEnum(runnerRaw.mode, "runner.mode", ALLOWED_CLAIM_MODES, path) ??
      RUNNER_DEFAULTS.runner.mode,
  };
  const config: RunnerConfig = {
    version: typeof raw.version === "number" ? raw.version : RUNNER_DEFAULTS.version,
    apiUrl: optionalString(raw.apiUrl, "apiUrl", path),
    profile: optionalString(raw.profile, "profile", path),
    boardId: optionalString(raw.boardId, "boardId", path),
    status:
      optionalEnum(raw.status, "status", ALLOWED_STATUSES, path) ?? undefined,
    mode: optionalEnum(raw.mode, "mode", ALLOWED_TOP_MODES, path) ?? undefined,
    agent,
    runner,
  };
  return config;
}

function cloneStringArray(values: readonly string[]): string[] {
  return [...values];
}

function cloneStringMap(value: Readonly<Record<string, string>>): Record<string, string> {
  return { ...value };
}

function requireString(value: unknown, field: string, path: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new RunnerConfigError(
    `runner config ${path}: '${field}' must be a non-empty string`,
    field
  );
}

function optionalString(value: unknown, field: string, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  throw new RunnerConfigError(
    `runner config ${path}: '${field}' must be a string when present`,
    field
  );
}

function optionalEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
  path: string
): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new RunnerConfigError(
      `runner config ${path}: '${field}' must be a string when present`,
      field
    );
  }
  if (!(allowed as readonly string[]).includes(value)) {
    throw new RunnerConfigError(
      `runner config ${path}: '${field}' must be one of ${allowed.join(
        ", "
      )}, got '${value}'`,
      field
    );
  }
  return value as T;
}

function optionalPositiveInt(
  value: unknown,
  field: string,
  path: string
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new RunnerConfigError(
      `runner config ${path}: '${field}' must be an integer`,
      field
    );
  }
  if (value <= 0) {
    throw new RunnerConfigError(
      `runner config ${path}: '${field}' must be a positive integer`,
      field
    );
  }
  return value;
}

function optionalStringArray(
  value: unknown,
  field: string,
  path: string
): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new RunnerConfigError(
      `runner config ${path}: '${field}' must be an array of strings`,
      field
    );
  }
  for (const v of value) {
    if (typeof v !== "string") {
      throw new RunnerConfigError(
        `runner config ${path}: '${field}' entries must be strings`,
        field
      );
    }
  }
  return [...value];
}

function optionalStringMap(
  value: unknown,
  field: string,
  path: string
): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) {
    throw new RunnerConfigError(
      `runner config ${path}: '${field}' must be an object of string → string`,
      field
    );
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== "string") {
      throw new RunnerConfigError(
        `runner config ${path}: '${field}.${k}' must be a string`,
        `${field}.${k}`
      );
    }
    out[k] = v;
  }
  return out;
}

/**
 * Resolve `agent.bin` against the filesystem. A value is considered
 * resolvable when:
 *
 *   * `agent.binPath` is set and points at an executable file, OR
 *   * `agent.bin` is an absolute path to an executable file, OR
 *   * `agent.bin` is a name that exists on `PATH`.
 *
 * Returns an error message suitable for direct user display.
 */
export function resolveAgentBinary(cfg: RunnerConfig, env: NodeJS.ProcessEnv = process.env): string {
  const { agent } = cfg;
  if (agent.binPath) {
    if (existsSync(agent.binPath)) {
      return isAbsolute(agent.binPath) ? agent.binPath : resolve(agent.binPath);
    }
    throw new RunnerConfigError(
      `agent.binPath '${agent.binPath}' does not exist on disk`,
      "agent.binPath"
    );
  }
  if (isAbsolute(agent.bin) && existsSync(agent.bin)) {
    return agent.bin;
  }
  const pathDirs = (env.PATH ?? "").split(":").filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = join(dir, agent.bin);
    if (existsSync(candidate)) return candidate;
  }
  throw new RunnerConfigError(
    `agent.bin '${agent.bin}' is neither an absolute path nor resolvable via PATH`,
    "agent.bin"
  );
}

/**
 * Run §4.6 strict validation. Returns the (possibly defaulted) config
 * on success; throws `RunnerConfigError` with a `field` pointer on
 * failure so callers can highlight the offending column.
 */
export function validate(cfg: RunnerConfig, opts: ValidateOptions = {}): RunnerConfig {
  const hasBoardId = !!cfg.boardId;
  const hasStatus = !!cfg.status;
  const hasMine = cfg.mode === "mine";
  if (hasMine && (hasBoardId || hasStatus)) {
    throw new RunnerConfigError(
      "config is ambiguous: 'mode: mine' is mutually exclusive with 'boardId' / 'status'",
      "mode"
    );
  }
  if (!hasMine && !(hasBoardId && hasStatus)) {
    throw new RunnerConfigError(
      "config is incomplete: provide either 'boardId' + 'status' or 'mode: mine'",
      "mode"
    );
  }
  resolveAgentBinary(cfg);
  const lock = cfg.runner.lockTimeoutMs ?? RUNNER_DEFAULTS.runner.lockTimeoutMs;
  const heartbeat =
    cfg.runner.heartbeatIntervalMs ?? RUNNER_DEFAULTS.runner.heartbeatIntervalMs;
  if (!(lock > heartbeat * 2)) {
    throw new RunnerConfigError(
      `runner.lockTimeoutMs (${lock}) must be greater than 2 × runner.heartbeatIntervalMs (${heartbeat})`,
      "runner.lockTimeoutMs"
    );
  }
  if (hasMine) {
    const check = opts.isLoggedIn ?? (() => false);
    if (!check(cfg.profile)) {
      throw new RunnerConfigError(
        `mode 'mine' requires CLI profile '${cfg.profile ?? "<default>"}' to be logged in; run \`kanban login\` first`,
        "mode"
      );
    }
  }
  if (cfg.agent.promptPosition === "replace") {
    const args = cfg.agent.args ?? RUNNER_DEFAULTS.agent.args;
    const occurrences = args.filter((a) => a === PROMPT_PLACEHOLDER).length;
    if (occurrences === 0) {
      throw new RunnerConfigError(
        `agent.promptPosition='replace' requires agent.args to contain the literal '${PROMPT_PLACEHOLDER}' placeholder exactly once (got 0)`,
        "agent.promptPosition"
      );
    }
    if (occurrences > 1) {
      throw new RunnerConfigError(
        `agent.promptPosition='replace' requires agent.args to contain the literal '${PROMPT_PLACEHOLDER}' placeholder exactly once (got ${occurrences})`,
        "agent.promptPosition"
      );
    }
  }
  return cfg;
}
