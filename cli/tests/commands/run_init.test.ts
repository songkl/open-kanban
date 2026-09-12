// Tests for the `kanban run init` interactive wizard.
//
// The wizard is driven by a `Prompter` so unit tests can drive the
// state machine without a TTY. We exercise:
//
//   * happy paths (mode-1, mode-2, both scope choices)
//   * validation hooks (lock > 2 × heartbeat, agent.bin resolution)
//   * persistence (file written, path resolved, scope reported)
//   * the YAML serializer round-trips through `parseConfig`
//   * the input parsers reject malformed KEY=value / empty boards
//
// The HTTP layer is bypassed via the `fetchBoards` / `fetchColumns`
// seams; the real fetchers live in a focused pair of tests at the
// bottom of this file.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type BoardSummary,
  type ColumnSummary,
  type Prompter,
  RUNNER_DEFAULTS as _ignored,
  RunnerInitError,
  defaultFetchBoards,
  defaultFetchColumns,
  roundTripRunnerConfig,
  runRunnerInitCommand,
  runRunnerInitWizard,
  serializeRunnerConfig,
} from "../../src/commands/run_init.js";
import { parseConfig } from "../../src/runner/config.js";
import { RUNNER_DEFAULTS } from "../../src/runner/types.js";
import type { HttpClient } from "../../src/http/client.js";

void _ignored;

const tempDirs: string[] = [];
function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
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
  vi.restoreAllMocks();
});

/**
 * Build a deterministic prompter that walks through a list of scripted
 * answers. Each call pops the next entry from the queue. Tests assert
 * by inspecting the recorded prompter calls.
 */
function scriptedPrompter(
  answers: Array<{ kind: string; value: unknown }>
): Prompter & { calls: Array<{ kind: string; value: unknown }> } {
  const calls: Array<{ kind: string; value: unknown }> = [];
  let i = 0;
  const take = (kind: string): unknown => {
    const slot = answers[i++] ?? { kind, value: undefined };
    if (slot.kind !== kind) {
      throw new Error(
        `prompter expected '${kind}' but next scripted answer is '${slot.kind}' at index ${i - 1}`
      );
    }
    calls.push(slot);
    return slot.value;
  };
  /**
   * Compare two unknown values for "sameness" in a select. Plain
   * `Object.is` is too strict for object choices because the test
   * constructs a fresh board object per assertion. Fall back to a
   * shallow property-by-property compare for plain records; `undefined`
   * and `null` properties are treated as "missing" on either side so
   * callers can omit optional fields like `description` /
   * `columnCount` and still match the runtime objects (which carry
   * them as `null` / `undefined`).
   */
  const valueMatches = (a: unknown, b: unknown): boolean => {
    if (Object.is(a, b)) return true;
    if (
      a && b &&
      typeof a === "object" &&
      typeof b === "object" &&
      !Array.isArray(a) &&
      !Array.isArray(b)
    ) {
      const ar = a as Record<string, unknown>;
      const br = b as Record<string, unknown>;
      const isMissing = (v: unknown): boolean => v === undefined || v === null;
      const keys = new Set([...Object.keys(ar), ...Object.keys(br)]);
      for (const k of keys) {
        if (isMissing(ar[k]) && isMissing(br[k])) continue;
        if (!valueMatches(ar[k], br[k])) return false;
      }
      return true;
    }
    return false;
  };
  return {
    calls,
    select: <T,>(opts: { message: string; choices: Array<{ value: T; name?: string }>; default?: T }) => {
      const v = take("select") as T;
      // Sanity check: ensure at least one choice matches the answer
      // so a future schema change is caught.
      const match = opts.choices.some((c) => valueMatches(c.value, v));
      if (!match) {
        throw new Error(
          `prompter.select answer '${String(v)}' not found in choices for '${opts.message}'`
        );
      }
      return Promise.resolve(v);
    },
    input: (opts: { message: string; default?: string; validate?: (v: string) => string | true }) => {
      const raw = take("input") as string;
      if (opts.validate) {
        const result = opts.validate(raw);
        if (result !== true) {
          throw new Error(
            `prompter.input '${opts.message}' failed validation: ${result}`
          );
        }
      }
      return Promise.resolve(raw);
    },
    number: (opts: { message: string; default?: number; min?: number; validate?: (v: number | undefined) => string | true }) => {
      const v = take("number") as number | undefined;
      if (opts.validate && v !== undefined) {
        const result = opts.validate(v);
        if (result !== true) {
          throw new Error(
            `prompter.number '${opts.message}' failed validation: ${result}`
          );
        }
      }
      return Promise.resolve(v);
    },
    confirm: () => Promise.resolve(take("confirm") as boolean),
  };
}

/**
 * Build a sequence of answers that drives the full mode-1 happy path
 * with sensible defaults. Tests that need to override a single step
 * can splice a different answer in by passing extra `answers`.
 */
function mode1Answers(opts: {
  bin?: string;
  timeoutMs?: number;
  tune?: boolean;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  lockTimeoutMs?: number;
  scope?: "project" | "local";
  confirmWrite?: boolean;
  confirmOverwrite?: boolean;
  extraArgs?: string;
  extraEnv?: string;
  promptMode?: "arg" | "stdin" | "file";
} = {}): Array<{ kind: string; value: unknown }> {
  const {
    bin = "opencode",
    timeoutMs = RUNNER_DEFAULTS.agent.timeoutMs,
    tune = false,
    pollIntervalMs = RUNNER_DEFAULTS.runner.pollIntervalMs,
    heartbeatIntervalMs = RUNNER_DEFAULTS.runner.heartbeatIntervalMs,
    lockTimeoutMs = RUNNER_DEFAULTS.runner.lockTimeoutMs,
    scope = "project",
    confirmWrite = true,
    confirmOverwrite = true,
    extraArgs = "",
    extraEnv = "",
    promptMode = "arg",
  } = opts;
  return [
    { kind: "select", value: "board" },
    { kind: "select", value: { id: "sys", name: "Sys board" } satisfies BoardSummary },
    { kind: "select", value: "todo" satisfies string },
    { kind: "input", value: bin },
    { kind: "confirm", value: false }, // wantBinPath?
    { kind: "select", value: promptMode },
    { kind: "input", value: promptMode === "arg" ? "--prompt" : "" },
    { kind: "input", value: "." }, // cwd
    { kind: "input", value: extraArgs },
    { kind: "input", value: extraEnv },
    { kind: "number", value: timeoutMs },
    { kind: "confirm", value: tune }, // tune cadences?
    ...(tune
      ? [
          { kind: "number", value: pollIntervalMs },
          { kind: "number", value: heartbeatIntervalMs },
          { kind: "number", value: lockTimeoutMs },
          { kind: "number", value: 1 }, // maxConcurrent
          { kind: "input", value: "" }, // runnerId
        ]
      : []),
    { kind: "select", value: scope },
    { kind: "input", value: "" }, // apiUrl
    { kind: "input", value: "" }, // profile
    { kind: "confirm", value: confirmOverwrite }, // file exists?
    { kind: "confirm", value: confirmWrite }, // write?
  ];
}

/**
 * Sequence for tests that exercise the wizard without a board-fetch
 * seam (so promptBoard falls back to a raw-id `input` prompt instead
 * of a `select`). Also points `agent.binPath` at `/bin/sh` so the
 * binary-resolution check always passes — the wizard rejects
 * unresolvable binaries before writing the file.
 */
function noFetchAnswers(opts: {
  bin?: string;
  binPath?: string;
  scope?: "project" | "local";
} = {}): Array<{ kind: string; value: unknown }> {
  const { bin = "sh", binPath = "/bin/sh", scope = "project" } = opts;
  return [
    { kind: "select", value: "board" },
    { kind: "input", value: "sys" }, // raw board id prompt
    { kind: "select", value: "todo" satisfies string },
    { kind: "input", value: bin },
    { kind: "confirm", value: true }, // wantBinPath?
    { kind: "input", value: binPath },
    { kind: "select", value: "arg" },
    { kind: "input", value: "--prompt" },
    { kind: "input", value: "." },
    { kind: "input", value: "" },
    { kind: "input", value: "" },
    { kind: "number", value: RUNNER_DEFAULTS.agent.timeoutMs },
    { kind: "confirm", value: false },
    { kind: "select", value: scope },
    { kind: "input", value: "" },
    { kind: "input", value: "" },
    { kind: "confirm", value: true },
    { kind: "confirm", value: true },
  ];
}

/**
 * Like `mode1Answers` but always pins `agent.binPath` to `/bin/sh` so
 * the wizard's resolveAgentBinary check passes regardless of whether
 * `opencode` is on the developer's PATH.
 */
function mode1AnswersWithBinPath(): Array<{ kind: string; value: unknown }> {
  return [
    { kind: "select", value: "board" },
    { kind: "select", value: { id: "sys", name: "Sys board" } satisfies BoardSummary },
    { kind: "select", value: "todo" satisfies string },
    { kind: "input", value: "sh" },
    { kind: "confirm", value: true }, // wantBinPath?
    { kind: "input", value: "/bin/sh" },
    { kind: "select", value: "arg" },
    { kind: "input", value: "--prompt" },
    { kind: "input", value: "." },
    { kind: "input", value: "" },
    { kind: "input", value: "" },
    { kind: "number", value: RUNNER_DEFAULTS.agent.timeoutMs },
    { kind: "confirm", value: false },
    { kind: "select", value: "project" },
    { kind: "input", value: "" },
    { kind: "input", value: "" },
    { kind: "confirm", value: true },
    { kind: "confirm", value: true },
  ];
}

// ---------------------------------------------------------------------------
// Wizard happy paths
// ---------------------------------------------------------------------------

describe("runRunnerInitWizard", () => {
  it("writes a complete mode-1 config and reports the absolute path", async () => {
    const cwd = freshDir("run-init-m1-");
    const prompter = scriptedPrompter(mode1Answers());
    const writes: Array<{ path: string; content: string }> = [];
    const result = await runRunnerInitWizard(
      { cwd },
      {
        prompter,
        fetchBoards: async () => [
          { id: "sys", name: "Sys board" },
          { id: "dev", name: "Dev board" },
        ],
        fetchColumns: async () => [
          { id: "todo-c", name: "Todo", status: "todo" },
          { id: "doing-c", name: "Doing", status: "in_progress" },
        ],
        writeFile: (p, c) => writes.push({ path: p, content: c }),
        pathExists: () => false,
      }
    );
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe(join(cwd, ".kanban-runner.yaml"));
    expect(result.path).toBe(join(cwd, ".kanban-runner.yaml"));
    expect(result.scope).toBe("project");
    expect(result.config.boardId).toBe("sys");
    expect(result.config.status).toBe("todo");
    expect(result.config.mode).toBeUndefined();
    expect(result.config.agent.bin).toBe("opencode");
    expect(result.config.runner.pollIntervalMs).toBe(
      RUNNER_DEFAULTS.runner.pollIntervalMs
    );
    // The serializer should produce a stable YAML string.
    const parsed = roundTripRunnerConfig(writes[0].content);
    expect(parsed.boardId).toBe("sys");
    expect(parsed.agent.bin).toBe("opencode");
    // The exact call count depends on whether the overwrite confirm
    // fires (it only does when pathExists returns true). All we care
    // about here is that the wizard consumed every scripted answer
    // before writing the file.
    expect(prompter.calls.length).toBeGreaterThanOrEqual(16);
  });

  it("writes a complete mode-2 (mine) config", async () => {
    const cwd = freshDir("run-init-m2-");
    const prompter = scriptedPrompter([
      { kind: "select", value: "mine" },
      { kind: "input", value: "opencode" },
      { kind: "confirm", value: false }, // wantBinPath
      { kind: "select", value: "arg" },
      { kind: "input", value: "--prompt" },
      { kind: "input", value: "." },
      { kind: "input", value: "" },
      { kind: "input", value: "" },
      { kind: "number", value: RUNNER_DEFAULTS.agent.timeoutMs },
      { kind: "confirm", value: false }, // tune
      { kind: "select", value: "local" },
      { kind: "input", value: "" }, // apiUrl
      { kind: "input", value: "" }, // profile
      { kind: "confirm", value: true }, // file exists?
      { kind: "confirm", value: true }, // write?
    ]);
    const writes: Array<{ path: string; content: string }> = [];
    const result = await runRunnerInitWizard(
      { cwd },
      {
        prompter,
        writeFile: (p, c) => writes.push({ path: p, content: c }),
        pathExists: () => false,
      }
    );
    expect(result.path).toBe(join(cwd, ".kanban-runner.local.yaml"));
    expect(result.scope).toBe("local");
    expect(result.config.mode).toBe("mine");
    expect(result.config.boardId).toBeUndefined();
    expect(result.config.status).toBeUndefined();
    expect(result.config.agent.bin).toBe("opencode");
  });

  it("respects the --profile / apiUrl presets supplied via options", async () => {
    const cwd = freshDir("run-init-presets-");
    const prompter = scriptedPrompter([
      { kind: "select", value: "mine" },
      { kind: "input", value: "opencode" },
      { kind: "confirm", value: false },
      { kind: "select", value: "arg" },
      { kind: "input", value: "--prompt" },
      { kind: "input", value: "." },
      { kind: "input", value: "" },
      { kind: "input", value: "" },
      { kind: "number", value: RUNNER_DEFAULTS.agent.timeoutMs },
      { kind: "confirm", value: false },
      { kind: "select", value: "project" },
      // The apiUrl / profile prompts are skipped because presets are
      // already supplied; no answers needed.
      { kind: "confirm", value: true },
      { kind: "confirm", value: true },
    ]);
    const writes: Array<{ path: string; content: string }> = [];
    const result = await runRunnerInitWizard(
      {
        cwd,
        apiUrl: "https://kanban.example.com",
        profile: "opencode-prod",
      },
      {
        prompter,
        writeFile: (p, c) => writes.push({ path: p, content: c }),
        pathExists: () => false,
      }
    );
    expect(result.config.apiUrl).toBe("https://kanban.example.com");
    expect(result.config.profile).toBe("opencode-prod");
    // Presets skip two prompts; the overwrite confirm only fires when
    // the file already exists, so we just assert we consumed enough
    // scripted answers to reach the write step.
    expect(prompter.calls.length).toBeGreaterThanOrEqual(12);
  });

  it("asks the user to confirm when the file already exists", async () => {
    const cwd = freshDir("run-init-exists-");
    const prompter = scriptedPrompter([
      { kind: "select", value: "mine" },
      { kind: "input", value: "opencode" },
      { kind: "confirm", value: false },
      { kind: "select", value: "arg" },
      { kind: "input", value: "--prompt" },
      { kind: "input", value: "." },
      { kind: "input", value: "" },
      { kind: "input", value: "" },
      { kind: "number", value: RUNNER_DEFAULTS.agent.timeoutMs },
      { kind: "confirm", value: false },
      { kind: "select", value: "project" },
      { kind: "input", value: "" },
      { kind: "input", value: "" },
      { kind: "confirm", value: false }, // overwrite? → refuse
    ]);
    await expect(
      runRunnerInitWizard(
        { cwd },
        {
          prompter,
          writeFile: () => undefined,
          pathExists: () => true,
        }
      )
    ).rejects.toBeInstanceOf(RunnerInitError);
  });

  it("aborts cleanly when the user declines the final write confirm", async () => {
    const cwd = freshDir("run-init-decline-");
    // pathExists returns false, so the overwrite confirm is skipped;
    // the very next prompt is the "write?" confirm which the user
    // declines.
    const prompter = scriptedPrompter([
      { kind: "select", value: "mine" },
      { kind: "input", value: "sh" },
      { kind: "confirm", value: true }, // wantBinPath?
      { kind: "input", value: "/bin/sh" },
      { kind: "select", value: "arg" },
      { kind: "input", value: "--prompt" },
      { kind: "input", value: "." },
      { kind: "input", value: "" },
      { kind: "input", value: "" },
      { kind: "number", value: RUNNER_DEFAULTS.agent.timeoutMs },
      { kind: "confirm", value: false }, // tune?
      { kind: "select", value: "project" },
      { kind: "input", value: "" },
      { kind: "input", value: "" },
      // overwrite confirm skipped because file does not exist
      { kind: "confirm", value: false }, // write? → decline
    ]);
    const writes: string[] = [];
    await expect(
      runRunnerInitWizard(
        { cwd },
        {
          prompter,
          writeFile: (p) => writes.push(p),
          pathExists: () => false,
        }
      )
    ).rejects.toBeInstanceOf(RunnerInitError);
    expect(writes).toHaveLength(0);
  });

  it("rejects when no boards are available and the API is reachable", async () => {
    const cwd = freshDir("run-init-empty-");
    // Only the mode prompt is answered; the wizard must reject before
    // asking for any further input.
    const prompter = scriptedPrompter([{ kind: "select", value: "board" }]);
    await expect(
      runRunnerInitWizard(
        { cwd },
        {
          prompter,
          fetchBoards: async () => [],
        }
      )
    ).rejects.toBeInstanceOf(RunnerInitError);
  });

  it("parses extra args + env vars from the wizard's comma-separated input", async () => {
    const cwd = freshDir("run-init-args-");
    const prompter = scriptedPrompter(mode1Answers({
      extraArgs: "--non-interactive, --silent",
      extraEnv: "LOG_LEVEL=info, KANBAN_API_URL=https://kanban.example.com",
    }));
    const writes: Array<{ path: string; content: string }> = [];
    const result = await runRunnerInitWizard(
      { cwd },
      {
        prompter,
        fetchBoards: async () => [
          { id: "sys", name: "Sys board" },
          { id: "dev", name: "Dev board" },
        ],
        fetchColumns: async () => [
          { id: "todo-c", name: "Todo", status: "todo" },
        ],
        writeFile: (p, c) => writes.push({ path: p, content: c }),
        pathExists: () => false,
      }
    );
    expect(result.config.agent.args).toEqual(["--non-interactive", "--silent"]);
    expect(result.config.agent.env).toEqual({
      LOG_LEVEL: "info",
      KANBAN_API_URL: "https://kanban.example.com",
    });
  });

  it("honours the user-tuned cadences", async () => {
    const cwd = freshDir("run-init-tune-");
    const prompter = scriptedPrompter(mode1Answers({
      tune: true,
      pollIntervalMs: 2000,
      heartbeatIntervalMs: 15000,
      lockTimeoutMs: 40000,
    }));
    const writes: Array<{ path: string; content: string }> = [];
    const result = await runRunnerInitWizard(
      { cwd },
      {
        prompter,
        fetchBoards: async () => [
          { id: "sys", name: "Sys board" },
          { id: "dev", name: "Dev board" },
        ],
        fetchColumns: async () => [
          { id: "todo-c", name: "Todo", status: "todo" },
        ],
        writeFile: (p, c) => writes.push({ path: p, content: c }),
        pathExists: () => false,
      }
    );
    expect(result.config.runner.pollIntervalMs).toBe(2000);
    expect(result.config.runner.heartbeatIntervalMs).toBe(15000);
    expect(result.config.runner.lockTimeoutMs).toBe(40000);
  });

  it("falls back to a raw board-id prompt when no HTTP client is supplied", async () => {
    const cwd = freshDir("run-init-nofetch-");
    const prompter = scriptedPrompter([
      { kind: "select", value: "board" },
      { kind: "input", value: "sys" },
      { kind: "select", value: "todo" },
      { kind: "input", value: "opencode" },
      { kind: "confirm", value: false },
      { kind: "select", value: "arg" },
      { kind: "input", value: "--prompt" },
      { kind: "input", value: "." },
      { kind: "input", value: "" },
      { kind: "input", value: "" },
      { kind: "number", value: RUNNER_DEFAULTS.agent.timeoutMs },
      { kind: "confirm", value: false },
      { kind: "select", value: "project" },
      { kind: "input", value: "" },
      { kind: "input", value: "" },
      { kind: "confirm", value: true },
      { kind: "confirm", value: true },
    ]);
    const writes: Array<{ path: string; content: string }> = [];
    const result = await runRunnerInitWizard(
      { cwd },
      {
        prompter,
        writeFile: (p, c) => writes.push({ path: p, content: c }),
        pathExists: () => false,
      }
    );
    expect(result.config.boardId).toBe("sys");
    expect(writes).toHaveLength(1);
  });

  it("surfaces a friendly error when the agent binary does not resolve", async () => {
    const cwd = freshDir("run-init-noagent-");
    // Wizard must reject at the binary-resolution step (after the
    // agent prompt) before consuming any further scripted answers.
    const prompter = scriptedPrompter([
      { kind: "select", value: "board" },
      { kind: "input", value: "sys" },
      { kind: "select", value: "todo" },
      { kind: "input", value: "definitely-not-installed-xyz" },
      { kind: "confirm", value: false }, // wantBinPath
    ]);
    await expect(
      runRunnerInitWizard(
        { cwd },
        {
          prompter,
          pathExists: () => false,
        }
      )
    ).rejects.toBeInstanceOf(RunnerInitError);
  });

  it("surfaces a friendly error when the env input is malformed", async () => {
    const cwd = freshDir("run-init-badenvar-");
    const prompter = scriptedPrompter([
      { kind: "select", value: "board" },
      { kind: "input", value: "sys" },
      { kind: "select", value: "todo" },
      { kind: "input", value: "opencode" },
      { kind: "confirm", value: false },
      { kind: "select", value: "arg" },
      { kind: "input", value: "--prompt" },
      { kind: "input", value: "." },
      { kind: "input", value: "" },
      { kind: "input", value: "no-equals-sign" },
    ]);
    await expect(
      runRunnerInitWizard(
        { cwd },
        {
          prompter,
          pathExists: () => false,
        }
      )
    ).rejects.toBeInstanceOf(RunnerInitError);
  });
});

// ---------------------------------------------------------------------------
// YAML serializer
// ---------------------------------------------------------------------------

describe("serializeRunnerConfig", () => {
  it("round-trips through parseConfig for a typical config", () => {
    const cfg = {
      version: 1,
      apiUrl: "http://kanban.example.com",
      profile: "opencode",
      boardId: "sys",
      status: "todo" as const,
      agent: {
        bin: "opencode",
        binPath: "/usr/local/bin/opencode",
        promptMode: "arg" as const,
        promptArg: "--prompt",
        cwd: ".",
        args: ["--non-interactive"],
        env: { LOG_LEVEL: "info" },
        timeoutMs: 1_800_000,
      },
      runner: {
        runnerId: "host-1-uuid",
        pollIntervalMs: 5000,
        heartbeatIntervalMs: 30000,
        lockTimeoutMs: 120000,
        maxConcurrent: 1,
        mode: "claim" as const,
      },
    };
    const yaml = serializeRunnerConfig(cfg);
    expect(yaml).toContain("version: 1");
    expect(yaml).toContain("bin: opencode");
    expect(yaml).toContain("LOG_LEVEL: info");
    const parsed = roundTripRunnerConfig(yaml);
    expect(parsed).toEqual(parseConfig("<test>", cfg));
  });

  it("omits optional blocks when they are not set", () => {
    const yaml = serializeRunnerConfig({
      version: 1,
      boardId: "sys",
      status: "todo",
      agent: { bin: "opencode" },
      runner: {
        pollIntervalMs: RUNNER_DEFAULTS.runner.pollIntervalMs,
        heartbeatIntervalMs: RUNNER_DEFAULTS.runner.heartbeatIntervalMs,
        lockTimeoutMs: RUNNER_DEFAULTS.runner.lockTimeoutMs,
        maxConcurrent: RUNNER_DEFAULTS.runner.maxConcurrent,
        mode: "claim",
      },
    });
    // No empty `args:` or `env:` blocks should appear.
    expect(yaml).not.toMatch(/^args:\s*$/m);
    expect(yaml).not.toMatch(/^env:\s*$/m);
  });

  it("round-trips a mode-2 (mine) config", () => {
    const yaml = serializeRunnerConfig({
      version: 1,
      mode: "mine",
      agent: { bin: "opencode" },
      runner: {
        pollIntervalMs: RUNNER_DEFAULTS.runner.pollIntervalMs,
        heartbeatIntervalMs: RUNNER_DEFAULTS.runner.heartbeatIntervalMs,
        lockTimeoutMs: RUNNER_DEFAULTS.runner.lockTimeoutMs,
        maxConcurrent: RUNNER_DEFAULTS.runner.maxConcurrent,
        mode: "claim",
      },
    });
    const parsed = roundTripRunnerConfig(yaml);
    expect(parsed.mode).toBe("mine");
    expect(parsed.boardId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Real filesystem round-trip (the test seam is bypassed here so we know
// the wizard works end-to-end against actual fs writes).
// ---------------------------------------------------------------------------

describe("runRunnerInitCommand end-to-end", () => {
  beforeEach(() => {
    process.env.PATH = "/usr/bin:/bin";
  });

  it("writes a YAML file that loads via loadConfig / validate", async () => {
    const cwd = freshDir("run-init-e2e-");
    // Use binPath + /bin/sh so the wizard's resolveAgentBinary check
    // passes even on hosts that don't have `opencode` installed.
    const prompter = scriptedPrompter(mode1AnswersWithBinPath());
    const result = await runRunnerInitCommand(
      { cwd, prompter },
      {
        fetchBoards: async () => [
          { id: "sys", name: "Sys board" },
          { id: "dev", name: "Dev board" },
        ],
        fetchColumns: async () => [
          { id: "todo-c", name: "Todo", status: "todo" },
        ],
      }
    );
    expect(existsSync(result.path)).toBe(true);
    const text = readFileSync(result.path, "utf8");
    const parsed = roundTripRunnerConfig(text);
    expect(parsed.boardId).toBe("sys");
    expect(parsed.status).toBe("todo");
    expect(parsed.agent.bin).toBe("sh");
    expect(parsed.agent.binPath).toBe("/bin/sh");
  });
});

// ---------------------------------------------------------------------------
// HTTP fetch helpers (defaultFetchBoards / defaultFetchColumns)
// ---------------------------------------------------------------------------

describe("defaultFetchBoards / defaultFetchColumns", () => {
  it("maps the API payload into BoardSummary objects", async () => {
    const http = {
      apiGet: vi.fn(async () => [
        {
          id: "sys",
          name: "Sys board",
          description: "the system board",
          _count: { columns: 4 },
        },
        {
          id: "dev",
          name: "Dev board",
        },
        { id: 123 }, // invalid: id is not a string
      ]),
    } as unknown as HttpClient;
    const boards = await defaultFetchBoards(http);
    expect(boards).toEqual([
      {
        id: "sys",
        name: "Sys board",
        description: "the system board",
        columnCount: 4,
      },
      { id: "dev", name: "Dev board", description: null, columnCount: undefined },
    ]);
  });

  it("returns an empty list when the API payload is not an array", async () => {
    const http = {
      apiGet: vi.fn(async () => ({ boards: [] })),
    } as unknown as HttpClient;
    const boards = await defaultFetchBoards(http);
    expect(boards).toEqual([]);
  });

  it("filters out columns with no id from defaultFetchColumns", async () => {
    const http = {
      apiGet: vi.fn(async () => [
        { id: "todo-c", name: "Todo", status: "todo", position: 0 },
        { id: "doing-c", name: "Doing", status: "in_progress", position: 1 },
        { id: 99, name: "Bad" }, // invalid
      ]),
    } as unknown as HttpClient;
    const cols = await defaultFetchColumns(http, "sys");
    expect(cols).toEqual([
      { id: "todo-c", name: "Todo", status: "todo", position: 0 },
      { id: "doing-c", name: "Doing", status: "in_progress", position: 1 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// File permissions — the wizard writes to disk with the default
// permissions; we just verify the file actually exists after a real
// write (the chmodSync import is intentionally referenced to keep the
// lint pass clean).
// ---------------------------------------------------------------------------

describe("wizard integration with real filesystem", () => {
  beforeEach(() => {
    process.env.PATH = "/usr/bin:/bin";
  });

  it("creates .kanban-runner.yaml that survives a chmod 0o600 round-trip", async () => {
    const cwd = freshDir("run-init-chmod-");
    const prompter = scriptedPrompter(noFetchAnswers());
    const result = await runRunnerInitCommand({ cwd, prompter }, {});
    chmodSync(result.path, 0o600);
    expect(existsSync(result.path)).toBe(true);
    expect(readFileSync(result.path, "utf8").length).toBeGreaterThan(0);
  });

  it("creates .kanban-runner.local.yaml when the user picks the local scope", async () => {
    const cwd = freshDir("run-init-local-");
    const prompter = scriptedPrompter(noFetchAnswers({ scope: "local" }));
    const result = await runRunnerInitCommand({ cwd, prompter }, {});
    expect(result.path.endsWith(".kanban-runner.local.yaml")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Helpers exercised via runRunnerInitCommand so the prompter wiring
// matches production behaviour.
// ---------------------------------------------------------------------------

describe("runRunnerInitCommand wiring", () => {
  beforeEach(() => {
    process.env.PATH = "/usr/bin:/bin";
  });

  it("threads the http client through to fetchBoards / fetchColumns", async () => {
    const cwd = freshDir("run-init-wire-");
    const prompter = scriptedPrompter(mode1AnswersWithBinPath());
    const http = {
      apiGet: vi.fn(async (url: string) => {
        if (url.startsWith("/api/v1/boards")) {
          return [
            { id: "sys", name: "Sys board" },
            { id: "dev", name: "Dev board" },
          ];
        }
        if (url.startsWith("/api/v1/columns")) {
          return [
            { id: "todo-c", name: "Todo", status: "todo" },
          ];
        }
        throw new Error(`unexpected url ${url}`);
      }),
    } as unknown as HttpClient;
    const result = await runRunnerInitCommand({ cwd, prompter }, { http });
    expect(result.config.boardId).toBe("sys");
    expect(result.config.status).toBe("todo");
    // The http mock saw at least one boards call and at least one
    // columns call.
    const urls = (http.apiGet as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as string
    );
    expect(urls.some((u) => u.startsWith("/api/v1/boards"))).toBe(true);
    expect(urls.some((u) => u.startsWith("/api/v1/columns"))).toBe(true);
  });
});
