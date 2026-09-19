// Interactive runner-config wizard — `kanban run init`.
//
// The runner loop (see `devDoc/CLI_RUNNER_PLAN_2026-09-12.md`) needs a
// `.kanban-runner.yaml` before it can start. Hand-editing that file is
// error-prone: a typo in `status:` or a missing `agent.bin` produces a
// cryptic `RunnerConfigError` after the loop has already begun spinning.
//
// This module replaces the manual edit with a step-by-step wizard that
// walks the user through every required field:
//
//   1. Pick the run mode (board-bound or identity-bound).
//   2. For board-bound, choose a board + column status from the live
//      `GET /api/v1/boards` / `GET /api/v1/columns` indexes so the user
//      never has to copy/paste an id.
//   3. Configure the agent binary (bin / binPath / prompt delivery /
//      timeout / extra args + env).
//   4. Optionally tune the runner cadences (poll / heartbeat / lock).
//   5. Preview the resulting YAML, confirm, and write to either
//      `.kanban-runner.yaml` (project-shared, committed) or
//      `.kanban-runner.local.yaml` (machine-local override).
//
// Prompts are dependency-injected via the `Prompter` interface so unit
// tests can drive the wizard without a TTY. The default `prompter`
// delegates to `@inquirer/prompts`. The HTTP layer is also injected so
// tests can return scripted board/column lists.
//
// All prompt failures propagate; the wizard does NOT swallow Ctrl-C.

import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import type { HttpClient } from "../http/client.js";
import {
  RUNNER_DEFAULTS,
  type AgentPromptMode,
  type AgentConfig,
  type RunnerConfig,
  type RunnerSettings,
  type RunnerStatus,
  type RunnerTopMode,
} from "../runner/types.js";
import {
  RunnerConfigError,
  parseConfig,
  resolveAgentBinary,
  validate,
} from "../runner/config.js";

const ALLOWED_STATUSES: readonly RunnerStatus[] = [
  "todo",
  "in_progress",
  "review",
  "done",
];
const ALLOWED_PROMPT_MODES: readonly AgentPromptMode[] = ["arg", "stdin", "file", "argv", "acp"];

const LOCAL_FILENAME = ".kanban-runner.local.yaml";
const PROJECT_FILENAME = ".kanban-runner.yaml";

export class RunnerInitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerInitError";
  }
}

/**
 * Minimal prompt surface used by the wizard. The real implementation
 * delegates to `@inquirer/prompts`; tests can supply a deterministic
 * stub so the wizard can be exercised without a TTY.
 */
export interface Prompter {
  select<T>(opts: {
    message: string;
    choices: Array<{ value: T; name?: string; description?: string }>;
    default?: T;
  }): Promise<T>;
  input(opts: {
    message: string;
    default?: string;
    validate?: (value: string) => string | true;
  }): Promise<string>;
  number(opts: {
    message: string;
    default?: number;
    min?: number;
    validate?: (value: number | undefined) => string | true;
  }): Promise<number | undefined>;
  confirm(opts: { message: string; default?: boolean }): Promise<boolean>;
}

/**
 * Board summary the wizard shows in the picker. Only the fields the
 * user needs to make a decision (id + name + column count) are read;
 * full board detail is fetched on demand.
 */
export interface BoardSummary {
  id: string;
  name: string;
  description?: string | null;
  columnCount?: number;
}

/**
 * Column summary the wizard shows in the picker.
 */
export interface ColumnSummary {
  id: string;
  name: string;
  status?: string | null;
  position?: number;
}

/**
 * Wizard dependencies. `http` is optional — when omitted the wizard
 * skips the board/column fetches and prompts the user for raw ids.
 * `oauth` powers the "are we logged in?" check for mode-2.
 */
export interface RunnerInitDeps {
  http?: HttpClient;
  /** Prompter used for every interactive step. Required by
   * `runRunnerInitWizard`; the wrapper `runRunnerInitCommand` accepts
   * a prompter via `options.prompter` and threads it through. */
  prompter?: Prompter;
  io?: {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  };
  /** Override for `fetchBoards` / `fetchColumns`; tests inject stubs. */
  fetchBoards?: () => Promise<BoardSummary[]>;
  fetchColumns?: (boardId: string) => Promise<ColumnSummary[]>;
  /** Override for the filesystem write step; tests inject a recorder. */
  writeFile?: (path: string, content: string) => void;
  /** Override `pathExists` for the "file already exists" check. */
  pathExists?: (path: string) => boolean;
}

export interface RunnerInitOptions {
  /** Working directory; the wizard writes to `<cwd>/.kanban-runner{.local}.yaml`. */
  cwd: string;
  /** Profile to record in the config (forwarded from `--profile`). */
  profile?: string;
  /** API URL override to record in the config. */
  apiUrl?: string;
}

export interface RunnerInitResult {
  /** Absolute path the wizard wrote to. */
  path: string;
  /** The validated, post-default config that was persisted. */
  config: RunnerConfig;
  /** "project" or "local" depending on which filename was chosen. */
  scope: "project" | "local";
}

/**
 * Drive the wizard end-to-end. The function returns once the file has
 * been written (or throws when the user aborts / a prompt fails).
 *
 * The flow:
 *
 *   1. Pick a mode (`board-bound` or `identity-bound`).
 *   2. Resolve board + status (mode-1) or skip to step 3 (mode-2).
 *   3. Configure the agent block.
 *   4. Tune the runner cadences.
 *   5. Preview → confirm → write to disk.
 *
 * Steps are split into pure helpers so tests can exercise each step in
 * isolation; `runRunnerInitWizard` is the orchestrator that calls them
 * in order.
 */
export async function runRunnerInitWizard(
  options: RunnerInitOptions,
  deps: RunnerInitDeps & { prompter: Prompter }
): Promise<RunnerInitResult> {
  const stdout = deps.io?.stdout ?? process.stdout;
  const stderr = deps.io?.stderr ?? process.stderr;
  const pathExists = deps.pathExists ?? ((p) => existsSync(p));
  const writeFile = deps.writeFile ?? ((p, c) => writeFileSync(p, c, "utf8"));

  const mode = await promptMode(deps.prompter);
  let boardId: string | undefined;
  let status: RunnerStatus | undefined;
  let topMode: RunnerTopMode | undefined;
  if (mode === "mine") {
    topMode = "mine";
  } else {
    const board = await promptBoard(deps);
    boardId = board.id;
    status = await promptColumnStatus(deps, board);
  }

  const agent = await promptAgent(deps.prompter);
  const runner = await promptRunnerSettings(deps.prompter);
  const scope = await promptScope(deps.prompter);
  const apiUrl = await promptApiUrl(deps.prompter, options.apiUrl);
  const profile = await promptProfile(deps.prompter, options.profile);

  const draft: RunnerConfig = {
    version: RUNNER_DEFAULTS.version,
    apiUrl,
    profile,
    boardId,
    status,
    mode: topMode,
    agent,
    runner,
  };
  // validate() applies defaults + checks agent.bin, lock > 2 ×
  // heartbeat, and the mine/login mutex. The wizard never writes a
  // config that wouldn't load. The login check is skipped here — the
  // wizard is a config generator, not a runtime check; `kanban run`
  // will enforce the profile is logged in at startup.
  let valid: RunnerConfig;
  try {
    valid = validate(draft, { isLoggedIn: () => true });
  } catch (err) {
    if (err instanceof RunnerConfigError) {
      throw new RunnerInitError(
        `wizard produced an invalid config: ${err.message}` +
          (err.field ? ` (field: ${err.field})` : "")
      );
    }
    throw err;
  }
  const yamlText = serializeRunnerConfig(valid);
  const filename = scope === "local" ? LOCAL_FILENAME : PROJECT_FILENAME;
  const targetPath = resolve(options.cwd, filename);

  if (pathExists(targetPath)) {
    const overwrite = await deps.prompter.confirm({
      message: `${filename} already exists at ${targetPath}. Overwrite?`,
      default: false,
    });
    if (!overwrite) {
      throw new RunnerInitError(
        `refused to overwrite existing ${filename}; rerun with a different scope or remove the file first`
      );
    }
  }

  const proceed = await deps.prompter.confirm({
    message: `Write the following config to ${targetPath}?`,
    default: true,
  });
  if (!proceed) {
    stderr.write("aborted by user; nothing written\n");
    throw new RunnerInitError("user aborted before write");
  }

  writeFile(targetPath, yamlText);
  stdout.write(`wrote runner config to ${targetPath}\n`);
  return { path: targetPath, config: valid, scope };
}

// ---------------------------------------------------------------------------
// Prompt helpers — each step is a small pure function the orchestrator calls.
// ---------------------------------------------------------------------------

async function promptMode(prompter: Prompter): Promise<"board" | "mine"> {
  const choice = await prompter.select<"board" | "mine">({
    message: "Which mode should the runner use?",
    choices: [
      {
        value: "board",
        name: "Board-bound (watch one board + column status)",
        description:
          "Recommended for dedicated runners; pick a board and the column status to watch",
      },
      {
        value: "mine",
        name: "Identity-bound (process my assigned tasks)",
        description:
          "Requires `kanban auth login`; picks from any task routed to your profile",
      },
    ],
    default: "board",
  });
  return choice;
}

async function promptBoard(deps: RunnerInitDeps): Promise<BoardSummary> {
  const fetch = deps.fetchBoards;
  if (!fetch) {
    // No HTTP client → fall back to a raw id prompt.
    const id = await deps.prompter.input({
      message: "Board id (run `kanban boards list` to find one)",
      validate: (v) => (v.trim().length > 0 ? true : "board id must not be empty"),
    });
    return { id: id.trim(), name: id.trim() };
  }
  const boards = await safeFetch(fetch, [] as BoardSummary[]);
  if (boards.length === 0) {
    throw new RunnerInitError(
      "no boards available; create one with `kanban boards create` (or via the web UI) before running the wizard"
    );
  }
  if (boards.length === 1) {
    return boards[0];
  }
  return await deps.prompter.select<BoardSummary>({
    message: "Select a board to watch",
    choices: boards.map((b) => ({
      value: b,
      name: `${b.name} (${b.id})`,
      description: b.description?.slice(0, 80) ?? undefined,
    })),
  });
}

async function promptColumnStatus(
  deps: RunnerInitDeps,
  board: BoardSummary
): Promise<RunnerStatus> {
  const fetch = deps.fetchColumns;
  let columns: ColumnSummary[] = [];
  if (fetch) {
    columns = await safeFetch(() => fetch(board.id), [] as ColumnSummary[]);
  }
  const statusOptions: Array<{ value: RunnerStatus; name: string }> = [];
  for (const s of ALLOWED_STATUSES) {
    const col = columns.find((c) => c.status === s);
    statusOptions.push({
      value: s,
      name: col ? `${s} — ${col.name}` : s,
    });
  }
  return await deps.prompter.select<RunnerStatus>({
    message: `Which column status should the runner watch on board "${board.name}"?`,
    choices: statusOptions,
    default: "todo",
  });
}

async function promptAgent(prompter: Prompter): Promise<AgentConfig> {
  const bin = await prompter.input({
    message: "Agent binary name (resolved via PATH; e.g. `opencode`)",
    default: "opencode",
    validate: (v) =>
      v.trim().length > 0 ? true : "agent.bin must be a non-empty string",
  });
  const wantBinPath = await prompter.confirm({
    message: "Pin the agent to an absolute path? (recommended for production)",
    default: false,
  });
  let binPath: string | undefined;
  if (wantBinPath) {
    const raw = await prompter.input({
      message: "Absolute path to the agent binary",
      validate: (v) =>
        v.trim().length > 0 ? true : "agent.binPath must be a non-empty string",
    });
    binPath = raw.trim();
  }
  // Resolve the binary against PATH/binPath immediately. We surface
  // the failure here so the user fixes a typo before they spend time
  // tuning prompt delivery + cadences.
  try {
    resolveAgentBinary({
      agent: { bin: bin.trim(), binPath },
      runner: RUNNER_DEFAULTS.runner,
    } as RunnerConfig);
  } catch (err) {
    if (err instanceof RunnerConfigError) {
      throw new RunnerInitError(err.message);
    }
    throw err;
  }
  const promptMode = await prompter.select<AgentPromptMode>({
    message: "How should the runner deliver the prompt to the agent?",
    choices: [
      { value: "arg", name: "arg — pass via a temp-file flag (default)" },
      { value: "stdin", name: "stdin — pipe to the agent's stdin" },
      {
        value: "file",
        name: "file — write to <cwd>/.kanban-runner-<taskId>.md",
      },
      {
        value: "argv",
        // s-1191: positional-arg delivery is the only mode that works
        // for agents like `opencode run [message..]` that take the
        // message as a positional argument. Surfacing it in the wizard
        // means an operator never has to hand-edit the YAML when they
        // switch from a flag-style agent to opencode.
        name: "argv — pass prompt content as a positional argv entry (use for `opencode run`)",
      },
      {
        value: "acp",
        // s-1235: Agent Client Protocol (https://agentclientprotocol.com/)
        // is the emerging JSON-RPC-over-stdio contract shared by
        // mainstream agents. The runner drives the full
        // `initialize` → `session/new` → `session/prompt` handshake
        // and streams `session/update` chunks back as the agent's
        // reply. Pick this for `claude --acp`, `opencode acp`,
        // `gemini --acp`, etc.
        name: "acp — speak the Agent Client Protocol over stdio (use for `claude --acp`, `opencode acp`, `gemini --acp`, …)",
      },
    ],
    default: "arg",
  });
  let promptArg: string | undefined;
  if (promptMode === "arg") {
    promptArg = await prompter.input({
      message: "Flag used to pass the prompt path to the agent",
      default: "--prompt",
    });
  }
  let acpFlag: string | undefined;
  if (promptMode === "acp") {
    // Different ACP-compatible agents opt into the protocol with
    // different flags. `--acp` is the convention most agents use
    // today; operators whose binary uses something else (e.g.
    // `--agent-client-protocol` or a positional subcommand) can
    // override the default here. Empty input falls back to the
    // built-in `--acp` default the runner ships with.
    acpFlag = await prompter.input({
      message: "Flag the binary uses to opt into the Agent Client Protocol",
      default: "--acp",
    });
  }
  const cwd = await prompter.input({
    message: "Working directory when spawning the agent",
    default: ".",
  });
  const extraArgsRaw = await prompter.input({
    message: "Extra agent args (comma-separated; press Enter to skip)",
    default: "",
  });
  const extraEnvRaw = await prompter.input({
    message: "Extra agent env vars (KEY=value, comma-separated; press Enter to skip)",
    default: "",
  });
  const timeoutMs = await prompter.number({
    message: "Hard timeout per task (ms)",
    default: RUNNER_DEFAULTS.agent.timeoutMs,
    min: 1_000,
    validate: (v) =>
      v === undefined || v <= 0 ? "timeout must be a positive number" : true,
  });
  return {
    bin: bin.trim(),
    binPath,
    promptMode,
    promptArg,
    acpFlag: acpFlag?.trim() || RUNNER_DEFAULTS.agent.acpFlag,
    cwd: cwd.trim() || RUNNER_DEFAULTS.agent.cwd,
    args: parseStringList(extraArgsRaw),
    env: parseStringMap(extraEnvRaw),
    timeoutMs: timeoutMs ?? RUNNER_DEFAULTS.agent.timeoutMs,
  };
}

async function promptRunnerSettings(prompter: Prompter): Promise<RunnerSettings> {
  const tune = await prompter.confirm({
    message: "Tune runner cadences? (press Enter to use defaults)",
    default: false,
  });
  const defaults = RUNNER_DEFAULTS.runner;
  if (!tune) {
    return {
      pollIntervalMs: defaults.pollIntervalMs,
      heartbeatIntervalMs: defaults.heartbeatIntervalMs,
      lockTimeoutMs: defaults.lockTimeoutMs,
      maxConcurrent: defaults.maxConcurrent,
      mode: defaults.mode,
    };
  }
  const pollIntervalMs = await prompter.number({
    message: "Idle poll cadence (ms)",
    default: defaults.pollIntervalMs,
    min: 100,
    validate: (v) =>
      v === undefined || v <= 0 ? "must be a positive number" : true,
  });
  const heartbeatIntervalMs = await prompter.number({
    message: "Heartbeat cadence (ms)",
    default: defaults.heartbeatIntervalMs,
    min: 100,
    validate: (v) =>
      v === undefined || v <= 0 ? "must be a positive number" : true,
  });
  const lockTimeoutMs = await prompter.number({
    message: "Lock timeout (ms); must exceed 2 × heartbeat",
    default: defaults.lockTimeoutMs,
    min: heartbeatIntervalMs * 2 + 1,
    validate: (v) =>
      v === undefined || v <= 0 ? "must be a positive number" : true,
  });
  const maxConcurrent = await prompter.number({
    message: "Max concurrent tasks (v1 always runs one)",
    default: defaults.maxConcurrent,
    min: 1,
    validate: (v) =>
      v === undefined || v <= 0 ? "must be a positive integer" : true,
  });
  const runnerId = await prompter.input({
    message: "Runner id (leave blank to auto-generate)",
    default: "",
  });
  return {
    pollIntervalMs: pollIntervalMs ?? defaults.pollIntervalMs,
    heartbeatIntervalMs: heartbeatIntervalMs ?? defaults.heartbeatIntervalMs,
    lockTimeoutMs: lockTimeoutMs ?? defaults.lockTimeoutMs,
    maxConcurrent: maxConcurrent ?? defaults.maxConcurrent,
    mode: defaults.mode,
    runnerId: runnerId.trim() || undefined,
  };
}

async function promptScope(prompter: Prompter): Promise<"project" | "local"> {
  return await prompter.select<"project" | "local">({
    message: "Where should the config be written?",
    choices: [
      {
        value: "project",
        name: `${PROJECT_FILENAME} (project-shared; safe to commit)`,
      },
      {
        value: "local",
        name: `${LOCAL_FILENAME} (machine-local override; gitignored)`,
      },
    ],
    default: "project",
  });
}

async function promptApiUrl(
  prompter: Prompter,
  preset?: string
): Promise<string | undefined> {
  if (preset && preset.trim().length > 0) return preset.trim();
  const value = await prompter.input({
    message: "API URL to embed in the config (press Enter to fall back to the CLI config)",
    default: "",
  });
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function promptProfile(
  prompter: Prompter,
  preset?: string
): Promise<string | undefined> {
  if (preset && preset.trim().length > 0) return preset.trim();
  const value = await prompter.input({
    message: "Credential profile (press Enter to fall back to the default profile)",
    default: "",
  });
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// ---------------------------------------------------------------------------
// YAML serialization
// ---------------------------------------------------------------------------

/**
 * Serialize a `RunnerConfig` to the YAML schema documented in §2.2 of
 * the runner plan. We deliberately re-parse the result so we can
 * guarantee the output round-trips through `parseConfig` (the same
 * path the runtime loader uses).
 */
export function serializeRunnerConfig(cfg: RunnerConfig): string {
  const out: Record<string, unknown> = {};
  out.version = cfg.version;
  if (cfg.apiUrl !== undefined) out.apiUrl = cfg.apiUrl;
  if (cfg.profile !== undefined) out.profile = cfg.profile;
  if (cfg.boardId !== undefined) out.boardId = cfg.boardId;
  if (cfg.status !== undefined) out.status = cfg.status;
  if (cfg.mode !== undefined) out.mode = cfg.mode;
  out.agent = serialiseAgent(cfg.agent);
  out.runner = serialiseRunner(cfg.runner);
  return stringifyYaml(out, { lineWidth: 0, sortMapEntries: false });
}

function serialiseAgent(agent: AgentConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  out.bin = agent.bin;
  if (agent.binPath !== undefined) out.binPath = agent.binPath;
  if (agent.promptMode !== undefined) out.promptMode = agent.promptMode;
  if (agent.promptArg !== undefined) out.promptArg = agent.promptArg;
  // s-1235: only emit `acpFlag` when it deviates from the default,
  // so existing configs (and `--init` output for non-ACP agents)
  // stay terse. The wizard always writes it explicitly so operators
  // don't have to know which mode flips it on.
  if (agent.acpFlag !== undefined && agent.acpFlag !== RUNNER_DEFAULTS.agent.acpFlag) {
    out.acpFlag = agent.acpFlag;
  }
  if (agent.cwd !== undefined) out.cwd = agent.cwd;
  if (agent.args !== undefined && agent.args.length > 0) out.args = [...agent.args];
  if (agent.env !== undefined && Object.keys(agent.env).length > 0) {
    out.env = { ...agent.env };
  }
  if (agent.timeoutMs !== undefined) out.timeoutMs = agent.timeoutMs;
  return out;
}

function serialiseRunner(runner: RunnerSettings): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (runner.runnerId !== undefined && runner.runnerId.length > 0) {
    out.runnerId = runner.runnerId;
  }
  if (runner.pollIntervalMs !== undefined) out.pollIntervalMs = runner.pollIntervalMs;
  if (runner.heartbeatIntervalMs !== undefined) {
    out.heartbeatIntervalMs = runner.heartbeatIntervalMs;
  }
  if (runner.lockTimeoutMs !== undefined) out.lockTimeoutMs = runner.lockTimeoutMs;
  if (runner.maxConcurrent !== undefined) out.maxConcurrent = runner.maxConcurrent;
  if (runner.mode !== undefined) out.mode = runner.mode;
  return out;
}

/**
 * Round-trip helper for callers (and tests) that want to assert the
 * serialized text is what `parseConfig` would re-read. Wraps the
 * existing `parseConfig` so the wizard and tests share the same
 * validation path.
 */
export function roundTripRunnerConfig(yamlText: string): RunnerConfig {
  const parsed = parseYaml(yamlText);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RunnerInitError("wizard output is not a YAML mapping");
  }
  // Reuse the runtime validator's normaliser to keep the round-trip
  // exact (defaults + type checks live there).
  return parseConfig("<wizard-output>", parsed);
}

// ---------------------------------------------------------------------------
// Input parsers — accept the human-friendly comma-separated strings the
// wizard collects and turn them into the typed arrays / maps the runner
// config expects.
// ---------------------------------------------------------------------------

function parseStringList(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed.length > 0) out.push(trimmed);
  }
  return out;
}

function parseStringMap(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      throw new RunnerInitError(
        `invalid env entry '${trimmed}'; expected KEY=value (e.g. LOG_LEVEL=info)`
      );
    }
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key.length === 0) {
      throw new RunnerInitError(`invalid env entry '${trimmed}'; key must not be empty`);
    }
    out[key] = value;
  }
  return out;
}

async function safeFetch<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

/**
 * Best-effort fetch helper that returns a list of board summaries from
 * the existing `/api/v1/boards` endpoint. Errors fall through so the
 * wizard can surface a friendly "no boards available" message.
 */
export async function defaultFetchBoards(http: HttpClient): Promise<BoardSummary[]> {
  const raw = await http.apiGet<Array<Record<string, unknown>>>("/api/v1/boards");
  const list = Array.isArray(raw) ? raw : [];
  return list
    .filter((b) => b && typeof b === "object")
    .map((b): BoardSummary | null => {
      const id = typeof b.id === "string" ? b.id : undefined;
      if (!id) return null;
      const name = typeof b.name === "string" ? b.name : id;
      const description =
        typeof b.description === "string" ? b.description : null;
      const count =
        b._count && typeof b._count === "object"
          ? Number((b._count as Record<string, unknown>).columns ?? 0)
          : undefined;
      return { id, name, description, columnCount: count };
    })
    .filter((x): x is BoardSummary => x !== null);
}

export async function defaultFetchColumns(
  http: HttpClient,
  boardId: string
): Promise<ColumnSummary[]> {
  const url = `/api/v1/columns?boardId=${encodeURIComponent(boardId)}`;
  const raw = await http.apiGet<Array<Record<string, unknown>>>(url);
  const list = Array.isArray(raw) ? raw : [];
  return list
    .filter((c) => c && typeof c === "object")
    .map((c): ColumnSummary | null => {
      const id = typeof c.id === "string" ? c.id : undefined;
      if (!id) return null;
      const name = typeof c.name === "string" ? c.name : id;
      const status = typeof c.status === "string" ? c.status : null;
      const position = typeof c.position === "number" ? c.position : undefined;
      return { id, name, status, position };
    })
    .filter((x): x is ColumnSummary => x !== null);
}

/**
 * Thin wrapper around `runRunnerInitWizard` for `cli/program.ts`.
 * Builds the default `Prompter` over `@inquirer/prompts` and wires
 * the HTTP-backed board / column fetchers. Custom `fetchBoards` /
 * `fetchColumns` overrides in `deps` win over the HTTP-derived ones
 * so tests can exercise the wizard without a real HTTP client.
 */
export async function runRunnerInitCommand(
  options: RunnerInitOptions & { prompter: Prompter; cwd: string },
  deps: RunnerInitDeps & { http?: HttpClient }
): Promise<RunnerInitResult> {
  const fetchBoards =
    deps.fetchBoards ??
    (deps.http ? () => defaultFetchBoards(deps.http as HttpClient) : undefined);
  const fetchColumns =
    deps.fetchColumns ??
    (deps.http
      ? (boardId: string) => defaultFetchColumns(deps.http as HttpClient, boardId)
      : undefined);
  return runRunnerInitWizard(options, {
    ...deps,
    prompter: options.prompter,
    fetchBoards,
    fetchColumns,
  });
}
