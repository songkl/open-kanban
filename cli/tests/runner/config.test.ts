// Tests for `cli/src/runner/config.ts` — discovery, deep-merge, and
// §4.6 validation. Mirrors the structure of `cli/src/commands/config.test.ts`
// (table-driven where it helps, focused cases for each branch) and
// covers every requirement in s-1089:
//
//   * walk-up discovery order (local → project → global fallback)
//   * field-level deep-merge precedence
//   * array replacement (no concatenation)
//   * four distinct validation failure modes
//
// Validation tests for `agent.bin` resolution inject `PATH` / temp
// files because the resolver depends on the filesystem.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RunnerConfigError,
  defaultGlobalFallbackPath,
  discoverConfig,
  loadConfig,
  parseConfig,
  resolveAgentBinary,
  validate,
  type RunnerConfig,
} from "../../src/runner/config.js";
import { RUNNER_DEFAULTS } from "../../src/runner/types.js";

const LOCAL_FILENAME = ".kanban-runner.local.yaml";
const PROJECT_FILENAME = ".kanban-runner.yaml";

interface FsFixture {
  root: string;
  cleanup: () => void;
}

function makeFs(): FsFixture {
  const root = mkdtempSync(join(tmpdir(), "kanban-runner-"));
  return {
    root,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // best effort
      }
    },
  };
}

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

describe("defaultGlobalFallbackPath", () => {
  const ORIGINAL_ENV = process.env.XDG_CONFIG_HOME;
  const ORIGINAL_HOME = process.env.HOME;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = ORIGINAL_ENV;
    if (ORIGINAL_HOME === undefined) delete process.env.HOME;
    else process.env.HOME = ORIGINAL_HOME;
  });

  it("honours XDG_CONFIG_HOME", () => {
    process.env.XDG_CONFIG_HOME = "/tmp/cfg-override";
    expect(defaultGlobalFallbackPath("/anywhere")).toBe(
      "/tmp/cfg-override/kanban-cli/runner.json"
    );
  });

  it("falls back to $HOME/.config", () => {
    delete process.env.XDG_CONFIG_HOME;
    process.env.HOME = "/home/test";
    expect(defaultGlobalFallbackPath("/anywhere")).toBe(
      "/home/test/.config/kanban-cli/runner.json"
    );
  });
});

describe("discoverConfig — walk-up", () => {
  let fx: FsFixture;
  beforeEach(() => {
    fx = makeFs();
  });
  afterEach(() => fx.cleanup());

  it("finds the project file in the current directory", () => {
    writeFileSync(join(fx.root, PROJECT_FILENAME), "version: 1\nagent:\n  bin: x\nrunner: {}\n");
    const hit = discoverConfig(fx.root);
    expect(hit).not.toBeNull();
    expect(hit!.primary).toBe(join(fx.root, PROJECT_FILENAME));
    expect(hit!.sibling).toBeNull();
  });

  it("prefers the local override over the project file at the same level", () => {
    writeFileSync(join(fx.root, PROJECT_FILENAME), "version: 1\n");
    writeFileSync(join(fx.root, LOCAL_FILENAME), "version: 1\n");
    const hit = discoverConfig(fx.root);
    expect(hit!.primary).toBe(join(fx.root, LOCAL_FILENAME));
    // The sibling project file is reported so loadConfig can deep-merge.
    expect(hit!.sibling).toBe(join(fx.root, PROJECT_FILENAME));
  });

  it("walks up to find a project file in a parent directory", () => {
    writeFileSync(join(fx.root, PROJECT_FILENAME), "version: 1\n");
    const child = join(fx.root, "a", "b", "c");
    mkdirSync(child, { recursive: true });
    const hit = discoverConfig(child);
    expect(hit!.primary).toBe(join(fx.root, PROJECT_FILENAME));
    expect(hit!.sibling).toBeNull();
  });

  it("walks up to find a local override file in a parent directory", () => {
    writeFileSync(join(fx.root, LOCAL_FILENAME), "version: 1\n");
    const child = join(fx.root, "sub");
    mkdirSync(child, { recursive: true });
    const hit = discoverConfig(child);
    expect(hit!.primary).toBe(join(fx.root, LOCAL_FILENAME));
  });

  it("stops at the first hit and does not keep walking", () => {
    writeFileSync(join(fx.root, PROJECT_FILENAME), "version: 1\n");
    mkdirSync(join(fx.root, "inner"), { recursive: true });
    writeFileSync(join(fx.root, "inner", PROJECT_FILENAME), "version: 1\n");
    const hit = discoverConfig(join(fx.root, "inner"));
    expect(hit!.primary).toBe(join(fx.root, "inner", PROJECT_FILENAME));
  });

  it("falls back to the global file when no project/local file exists", () => {
    const globalDir = freshDir("kanban-runner-global-");
    const globalPath = join(globalDir, "runner.json");
    writeFileSync(globalPath, "{\"version\":1,\"agent\":{\"bin\":\"x\"},\"runner\":{}}");
    const hit = discoverConfig(fx.root, { globalFallbackPath: globalPath });
    expect(hit!.primary).toBe(globalPath);
    expect(hit!.sibling).toBeNull();
  });

  it("returns null when nothing is found", () => {
    expect(
      discoverConfig(fx.root, {
        globalFallbackPath: join(fx.root, "nope.json"),
      })
    ).toBeNull();
  });

  it("respects stopAt so callers can pin the walk to a sub-tree", () => {
    writeFileSync(join(fx.root, PROJECT_FILENAME), "version: 1\n");
    const child = join(fx.root, "x");
    mkdirSync(child, { recursive: true });
    expect(discoverConfig(child, { stopAt: child })).toBeNull();
  });
});

describe("loadConfig — parsing + defaults", () => {
  let fx: FsFixture;
  beforeEach(() => {
    fx = makeFs();
  });
  afterEach(() => fx.cleanup());

  it("applies built-in defaults for omitted agent and runner fields", () => {
    writeFileSync(
      join(fx.root, PROJECT_FILENAME),
      [
        "version: 1",
        "boardId: sys",
        "status: todo",
        "agent:",
        "  bin: opencode",
        "runner: {}",
        "",
      ].join("\n")
    );
    const cfg = loadConfig(fx.root);
    expect(cfg.agent.promptMode).toBe(RUNNER_DEFAULTS.agent.promptMode);
    expect(cfg.agent.promptArg).toBe(RUNNER_DEFAULTS.agent.promptArg);
    expect(cfg.agent.cwd).toBe(RUNNER_DEFAULTS.agent.cwd);
    expect(cfg.agent.args).toEqual([]);
    expect(cfg.agent.env).toEqual({});
    expect(cfg.agent.timeoutMs).toBe(RUNNER_DEFAULTS.agent.timeoutMs);
    expect(cfg.runner.pollIntervalMs).toBe(RUNNER_DEFAULTS.runner.pollIntervalMs);
    expect(cfg.runner.heartbeatIntervalMs).toBe(
      RUNNER_DEFAULTS.runner.heartbeatIntervalMs
    );
    expect(cfg.runner.lockTimeoutMs).toBe(RUNNER_DEFAULTS.runner.lockTimeoutMs);
    expect(cfg.runner.maxConcurrent).toBe(RUNNER_DEFAULTS.runner.maxConcurrent);
    expect(cfg.runner.mode).toBe(RUNNER_DEFAULTS.runner.mode);
  });

  it("reads the global JSON fallback when no project file exists", () => {
    const globalDir = freshDir("kanban-runner-global-");
    const globalPath = join(globalDir, "runner.json");
    writeFileSync(
      globalPath,
      JSON.stringify({
        version: 1,
        mode: "mine",
        agent: { bin: "opencode" },
        runner: {},
      })
    );
    const cfg = loadConfig(fx.root, { globalFallbackPath: globalPath });
    expect(cfg.mode).toBe("mine");
    expect(cfg.agent.bin).toBe("opencode");
  });

  it("throws RunnerConfigError when no file is discoverable", () => {
    expect(() =>
      loadConfig(fx.root, {
        globalFallbackPath: join(fx.root, "missing.json"),
      })
    ).toThrow(RunnerConfigError);
  });

  it("deep-merges a local override on top of the project file", () => {
    writeFileSync(
      join(fx.root, PROJECT_FILENAME),
      [
        "version: 1",
        "boardId: sys",
        "status: todo",
        "agent:",
        "  bin: opencode",
        "  args: [\"--shared\"]",
        "runner:",
        "  pollIntervalMs: 5000",
        "",
      ].join("\n")
    );
    writeFileSync(
      join(fx.root, LOCAL_FILENAME),
      [
        "agent:",
        "  args: [\"--local-only\"]",
        "runner:",
        "  lockTimeoutMs: 200000",
        "",
      ].join("\n")
    );
    const cfg = loadConfig(fx.root);
    // Local override replaces args (no concatenation).
    expect(cfg.agent.args).toEqual(["--local-only"]);
    // Local override adds lockTimeoutMs while project pollIntervalMs survives.
    expect(cfg.runner.pollIntervalMs).toBe(5000);
    expect(cfg.runner.lockTimeoutMs).toBe(200000);
  });
});

describe("parseConfig — deep-merge", () => {
  it("merges scalar fields from the override", () => {
    const merged = parseConfig(
      "<test>",
      {
        version: 1,
        boardId: "sys",
        status: "todo",
        agent: { bin: "opencode" },
        runner: { pollIntervalMs: 1000 },
      }
    );
    expect(merged.boardId).toBe("sys");
    expect(merged.agent.bin).toBe("opencode");
    expect(merged.runner.pollIntervalMs).toBe(1000);
  });

  it("replaces arrays wholesale (§2.2)", () => {
    const merged = parseConfig(
      "<test>",
      {
        version: 1,
        boardId: "sys",
        status: "todo",
        agent: {
          bin: "opencode",
          args: ["--only-this"],
          env: { ONLY: "this" },
        },
        runner: {},
      }
    );
    expect(merged.agent.args).toEqual(["--only-this"]);
    expect(merged.agent.env).toEqual({ ONLY: "this" });
  });

  it("deep-merges the runner block", () => {
    const merged = parseConfig(
      "<test>",
      {
        version: 1,
        boardId: "sys",
        status: "todo",
        agent: { bin: "opencode" },
        runner: {
          pollIntervalMs: 2000,
          heartbeatIntervalMs: 60000,
          lockTimeoutMs: 200000,
        },
      }
    );
    expect(merged.runner.pollIntervalMs).toBe(2000);
    expect(merged.runner.heartbeatIntervalMs).toBe(60000);
    expect(merged.runner.lockTimeoutMs).toBe(200000);
    // Defaults survive when the override does not set them.
    expect(merged.runner.maxConcurrent).toBe(RUNNER_DEFAULTS.runner.maxConcurrent);
    expect(merged.runner.mode).toBe(RUNNER_DEFAULTS.runner.mode);
  });

  it("rejects agent.bin that is missing or empty", () => {
    expect(() =>
      parseConfig("<test>", {
        version: 1,
        boardId: "sys",
        status: "todo",
        agent: { bin: "" },
        runner: {},
      })
    ).toThrow(RunnerConfigError);

    expect(() =>
      parseConfig("<test>", {
        version: 1,
        boardId: "sys",
        status: "todo",
        agent: {},
        runner: {},
      })
    ).toThrow(RunnerConfigError);
  });

  it("rejects malformed runner.timeout-style fields", () => {
    expect(() =>
      parseConfig("<test>", {
        version: 1,
        boardId: "sys",
        status: "todo",
        agent: { bin: "opencode", timeoutMs: -1 },
        runner: {},
      })
    ).toThrow(RunnerConfigError);

    expect(() =>
      parseConfig("<test>", {
        version: 1,
        boardId: "sys",
        status: "todo",
        agent: { bin: "opencode" },
        runner: { pollIntervalMs: "fast" as unknown as number },
      })
    ).toThrow(RunnerConfigError);
  });
});

describe("resolveAgentBinary", () => {
  let fx: FsFixture;
  beforeEach(() => {
    fx = makeFs();
  });
  afterEach(() => fx.cleanup());

  it("honours binPath when it points at an existing file", () => {
    const bin = join(fx.root, "my-agent");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    const cfg: RunnerConfig = {
      version: 1,
      agent: { bin: "my-agent", binPath: bin },
      runner: {},
    };
    expect(resolveAgentBinary(cfg)).toBe(bin);
  });

  it("uses an absolute agent.bin path directly", () => {
    const bin = join(fx.root, "opencode");
    writeFileSync(bin, "#!/bin/sh\n");
    const cfg: RunnerConfig = {
      version: 1,
      agent: { bin },
      runner: {},
    };
    expect(resolveAgentBinary(cfg)).toBe(bin);
  });

  it("resolves a bare name via PATH", () => {
    const fakeBin = join(fx.root, "opencode");
    writeFileSync(fakeBin, "#!/bin/sh\n");
    const cfg: RunnerConfig = {
      version: 1,
      agent: { bin: "opencode" },
      runner: {},
    };
    expect(resolveAgentBinary(cfg, { PATH: fx.root })).toBe(fakeBin);
  });

  it("throws RunnerConfigError when the binary cannot be resolved", () => {
    const cfg: RunnerConfig = {
      version: 1,
      agent: { bin: "definitely-not-a-real-binary" },
      runner: {},
    };
    try {
      resolveAgentBinary(cfg, { PATH: fx.root });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RunnerConfigError);
      expect((err as RunnerConfigError).field).toBe("agent.bin");
      expect((err as Error).message).toContain("agent.bin");
    }
  });
});

describe("validate — §4.6 strict checks", () => {
  function baseConfig(overrides: Partial<RunnerConfig> = {}): RunnerConfig {
    const binDir = freshDir("kanban-runner-bin-");
    const bin = join(binDir, "opencode");
    writeFileSync(bin, "#!/bin/sh\n");
    const base: RunnerConfig = {
      version: 1,
      boardId: "sys",
      status: "todo",
      agent: { bin, timeoutMs: 1_800_000 },
      runner: {
        pollIntervalMs: 5_000,
        heartbeatIntervalMs: 30_000,
        lockTimeoutMs: 120_000,
        maxConcurrent: 1,
        mode: "claim",
      },
    };
    return {
      ...base,
      ...overrides,
      agent: { ...base.agent, ...(overrides.agent ?? {}) },
      runner: { ...base.runner, ...(overrides.runner ?? {}) },
    };
  }

  it("passes when boardId + status are present and other rules hold", () => {
    const cfg = baseConfig();
    expect(validate(cfg)).toBe(cfg);
  });

  it("passes when mode=mine is set with a logged-in profile", () => {
    const cfg = baseConfig({ mode: "mine", boardId: undefined, status: undefined });
    const checked = validate(cfg, { isLoggedIn: () => true });
    expect(checked.mode).toBe("mine");
  });

  it("rejects boardId+status combined with mode=mine", () => {
    const cfg = baseConfig({ mode: "mine" });
    try {
      validate(cfg, { isLoggedIn: () => true });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RunnerConfigError);
      expect((err as RunnerConfigError).field).toBe("mode");
      expect((err as Error).message).toContain("mutually exclusive");
    }
  });

  it("rejects when neither boardId+status nor mode=mine are provided", () => {
    const cfg = baseConfig({ boardId: undefined, status: undefined });
    try {
      validate(cfg);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RunnerConfigError);
      expect((err as RunnerConfigError).field).toBe("mode");
      expect((err as Error).message).toContain("incomplete");
    }
  });

  it("rejects when lockTimeoutMs is not greater than 2 × heartbeatIntervalMs", () => {
    const cfg = baseConfig({
      runner: { heartbeatIntervalMs: 30_000, lockTimeoutMs: 60_000 },
    });
    try {
      validate(cfg);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RunnerConfigError);
      expect((err as RunnerConfigError).field).toBe("runner.lockTimeoutMs");
      expect((err as Error).message).toContain("runner.lockTimeoutMs");
    }
  });

  it("rejects when agent.bin cannot be resolved", () => {
    const cfg = baseConfig({ agent: { bin: "totally-not-on-path" } });
    try {
      validate(cfg);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RunnerConfigError);
      expect((err as RunnerConfigError).field).toBe("agent.bin");
    }
  });

  it("rejects mode=mine when the CLI profile is not logged in", () => {
    const cfg = baseConfig({ mode: "mine", boardId: undefined, status: undefined });
    try {
      validate(cfg, { isLoggedIn: () => false });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RunnerConfigError);
      expect((err as RunnerConfigError).field).toBe("mode");
      expect((err as Error).message).toContain("logged in");
    }
  });
});
