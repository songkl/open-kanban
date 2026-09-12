// Tests for `cli/src/runner/spawn.ts` — the `child_process` wrapper.
//
// We test three surfaces:
//
//   * `prepareSpawn` — pure path / argv assembly for each
//     `promptMode`. No real subprocess is launched; the temp file is
//     readable on disk so the agent binary would receive the exact
//     bytes we wrote.
//   * `ChildProcessSpawner` — actually launches `process.execPath`
//     (i.e. the test runner) with `-e <inline-script>` so we cover
//     the signal / timeout / stderr-truncation paths without pulling
//     in any external binary.
//   * `AgentSpawner` façade — combines `prepareSpawn` and the chosen
//     `ProcessSpawner`; we drive it with a fake `ProcessSpawner` so
//     the test asserts the contract independently of the real one.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentSpawner,
  ChildProcessSpawner,
  type PrepareSpawnOptions,
  type ProcessSpawner,
  STDERR_TRUNCATE_BYTES,
  prepareSpawn,
  readPromptFile,
  type AgentProcess,
  type AgentResult,
  type SpawnOptions,
} from "../../src/runner/spawn.js";
import type { AgentConfig } from "../../src/runner/types.js";

const BASE_AGENT: AgentConfig = {
  bin: process.execPath,
  promptMode: "arg",
  promptArg: "--prompt",
  args: ["-e"],
  cwd: process.cwd(),
  env: {},
  timeoutMs: 5_000,
};

afterEach(() => {
  // best-effort cleanup of tempdirs; vitest resets cwd
});

describe("prepareSpawn", () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "kanban-runner-test-"));
  });

  it("writes the prompt to a temp file and appends --prompt <path> (arg mode)", () => {
    const out = prepareSpawn({
      cfg: BASE_AGENT,
      prompt: "hello agent",
      taskId: "s-1",
      tmpDir: tmpRoot,
    });
    expect(out.bin).toBe(process.execPath);
    expect(out.pipeStdin).toBe(false);
    expect(out.args).toContain("--prompt");
    const promptPath = out.args[out.args.indexOf("--prompt") + 1];
    expect(promptPath).toBeTruthy();
    expect(readFileSync(promptPath!, "utf8")).toBe("hello agent");
    expect(out.promptFile).toBe(promptPath);
    out.cleanup();
    expect(existsSync(promptPath!)).toBe(false);
  });

  it("honours --prompt-file for promptMode=file and writes under cwd", () => {
    const cwd = join(tmpRoot, "project");
    mkdirSync(cwd, { recursive: true });
    const cfg: AgentConfig = {
      ...BASE_AGENT,
      promptMode: "file",
      cwd,
    };
    const out = prepareSpawn({
      cfg,
      prompt: "FILE MODE",
      taskId: "s-2",
      cwd,
      tmpDir: tmpRoot,
    });
    const idx = out.args.indexOf("--prompt-file");
    expect(idx).toBeGreaterThanOrEqual(0);
    const path = out.args[idx + 1];
    expect(path).toBe(join(cwd, ".kanban-runner-s-2.md"));
    expect(readFileSync(path!, "utf8")).toBe("FILE MODE");
    out.cleanup();
    expect(existsSync(path!)).toBe(false);
  });

  it("pipes the prompt over stdin for promptMode=stdin", () => {
    const cfg: AgentConfig = { ...BASE_AGENT, promptMode: "stdin" };
    const out = prepareSpawn({
      cfg,
      prompt: "STDIN MODE",
      taskId: "s-3",
      tmpDir: tmpRoot,
    });
    expect(out.pipeStdin).toBe(true);
    expect(out.stdinPayload).toBe("STDIN MODE");
    // No file should be written for stdin mode.
    expect(out.promptFile).toBeUndefined();
  });

  it("resolves a relative cwd against the current working directory", () => {
    const cfg: AgentConfig = { ...BASE_AGENT, cwd: "relative/path" };
    const out = prepareSpawn({
      cfg,
      prompt: "X",
      taskId: "s-4",
      tmpDir: tmpRoot,
    });
    expect(out.cwd.endsWith("relative/path")).toBe(true);
  });

  it("merges cfg.env over the inherited environment", () => {
    const cfg: AgentConfig = {
      ...BASE_AGENT,
      env: { OVERRIDE: "yes" },
    };
    const out = prepareSpawn({
      cfg,
      prompt: "X",
      taskId: "s-5",
      env: { OVERRIDE: "no", KEEP: "yes" },
      tmpDir: tmpRoot,
    });
    expect(out.env.OVERRIDE).toBe("yes");
    expect(out.env.KEEP).toBe("yes");
  });

  it("appends user-supplied args after the prompt flag", () => {
    const cfg: AgentConfig = {
      ...BASE_AGENT,
      args: ["--non-interactive", "--model", "x"],
    };
    const out = prepareSpawn({
      cfg,
      prompt: "X",
      taskId: "s-6",
      tmpDir: tmpRoot,
    });
    // User args come before the prompt flag.
    expect(out.args.slice(0, 4)).toEqual([
      "--non-interactive",
      "--model",
      "x",
      "--prompt",
    ]);
  });
});

describe("ChildProcessSpawner — real subprocess paths", () => {
  function runInlineScript(script: string, opts: { timeoutMs?: number } = {}): Promise<{ result: AgentResult; out: { process: AgentProcess; cleanup: () => void } }> {
    return new Promise((resolve) => {
      const spawner = new ChildProcessSpawner({
        timeoutMs: opts.timeoutMs ?? 5_000,
      });
      const out = spawner.spawn({
        bin: process.execPath,
        args: ["-e", script],
        cwd: process.cwd(),
        env: process.env,
        pipeStdin: false,
      });
      out.process.wait().then((result) => {
        resolve({ result, out });
      });
    });
  }

  it("captures the agent exit code on a clean exit", async () => {
    const { result } = await runInlineScript("process.exit(0);");
    expect(result.exitCode).toBe(0);
    expect(result.reason).toBe("exit");
    expect(result.stderr).toBe("");
  });

  it("captures stderr when the child exits non-zero", async () => {
    const { result } = await runInlineScript(
      `process.stderr.write("boom");process.exit(2);`
    );
    expect(result.exitCode).toBe(2);
    expect(result.reason).toBe("exit");
    expect(result.stderr).toBe("boom");
  });

  it("kills the child via SIGTERM when timeoutMs elapses", async () => {
    const { result } = await runInlineScript("setTimeout(()=>{},60_000);", {
      timeoutMs: 200,
    });
    expect(result.reason === "signal" || result.reason === "timeout").toBe(
      true
    );
  });

  it("truncates stderr to 64 KiB when the child writes more", async () => {
    // The OS pipe buffer caps a single round-trip at ~8 KiB so the
    // child must delay briefly between writing and exiting to let
    // its buffered stderr drain into the parent. We sleep 100ms
    // before `process.exit(1)`.
    const { result } = await runInlineScript(
      `process.stderr.write("A".repeat(80 * 1024));await new Promise(r=>setTimeout(r,100));process.exit(1);`
    );
    expect(result.exitCode).toBe(1);
    expect(result.reason).toBe("exit");
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(result.stderr.length).toBeLessThanOrEqual(
      STDERR_TRUNCATE_BYTES + "[truncated]".length + 5
    );
    expect(result.stderr).toContain("[truncated]");
  });
});

describe("AgentSpawner façade", () => {
  function makeFakeSpawner(): { spawner: ProcessSpawner; calls: SpawnOptions[]; resolvers: Array<(r: AgentResult) => void>; processRefs: AgentProcess[] } {
    const calls: SpawnOptions[] = [];
    const resolvers: Array<(r: AgentResult) => void> = [];
    const processRefs: AgentProcess[] = [];
    let killed: Array<{ signal: NodeJS.Signals }> = [];
    const spawner: ProcessSpawner = {
      spawn(opts: SpawnOptions) {
        calls.push(opts);
        let resolveFn: ((r: AgentResult) => void) | null = null;
        const waitPromise = new Promise<AgentResult>((resolve) => {
          resolveFn = resolve;
        });
        resolvers.push((r) => resolveFn!(r));
        const proc: AgentProcess = {
          kill: (signal: NodeJS.Signals = "SIGTERM") => {
            killed.push({ signal });
            return true;
          },
          wait: () => waitPromise,
          pid: 1000 + calls.length,
        };
        processRefs.push(proc);
        return {
          process: proc,
          cleanup: () => undefined,
        };
      },
    };
    return {
      spawner,
      calls,
      resolvers,
      processRefs,
    };
  }

  it("delegates to the wrapped spawner and forwards the result", async () => {
    const fakes = makeFakeSpawner();
    const spawner = new AgentSpawner(BASE_AGENT, fakes.spawner);
    const { process: child } = spawner.spawn({
      cfg: BASE_AGENT,
      prompt: "PROMPT",
      taskId: "s-x",
      tmpDir: mkdtempSync(join(tmpdir(), "kanban-runner-fake-")),
    });
    fakes.resolvers[0]({
      exitCode: 0,
      signal: null,
      stderr: "",
      reason: "exit",
    });
    const result = await child.wait();
    expect(result.exitCode).toBe(0);
    expect(fakes.calls[0].bin).toBe(process.execPath);
    expect(fakes.calls[0].args).toContain("--prompt");
  });
});
