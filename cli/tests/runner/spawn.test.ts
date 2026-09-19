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
  PROMPT_PLACEHOLDER,
  type PrepareSpawnOptions,
  type ProcessSpawner,
  STDERR_TRUNCATE_BYTES,
  STDOUT_TRUNCATE_BYTES,
  expandArgs,
  prepareSpawn,
  readPromptFile,
  splitShellArgs,
  type AgentProcess,
  type AgentResult,
  type SpawnOptions,
} from "../../src/runner/spawn.js";
import type { AgentConfig, ArgVariableValues } from "../../src/runner/types.js";

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

  // s-1191: positional-arg delivery for agents like `opencode run [message..]`.
  // The default `arg` mode used to produce `opencode run --prompt <tmp-file>`
  // which opencode's `run` subcommand rejects with its help banner
  // because `--prompt` is not a `run` flag. The new `argv` mode passes
  // the prompt **content** as a single positional argv entry instead.
  it("appends the prompt content as a positional argv entry for promptMode=argv", () => {
    const cfg: AgentConfig = {
      ...BASE_AGENT,
      promptMode: "argv",
      args: ["run"],
    };
    const out = prepareSpawn({
      cfg,
      prompt: "OPENCODE MESSAGE",
      taskId: "s-argv",
      tmpDir: tmpRoot,
    });
    expect(out.pipeStdin).toBe(false);
    expect(out.promptFile).toBeUndefined();
    expect(out.args).toEqual(["run", "OPENCODE MESSAGE"]);
    out.cleanup();
  });

  it("replaces the {prompt} placeholder with prompt content for promptMode=argv", () => {
    const cfg: AgentConfig = {
      ...BASE_AGENT,
      promptMode: "argv",
      promptPosition: "replace",
      args: ["run", PROMPT_PLACEHOLDER],
    };
    const out = prepareSpawn({
      cfg,
      prompt: "POSITIONAL",
      taskId: "s-argv-replace",
      tmpDir: tmpRoot,
    });
    // The {prompt} placeholder is gone; the prompt content sits in
    // its slot. This is the canonical s-1191 fix shape for opencode:
    // `opencode run <prompt content>`.
    expect(out.args).toEqual(["run", "POSITIONAL"]);
    out.cleanup();
  });

  it("prepends the prompt content when promptMode=argv + promptPosition=prepend", () => {
    const cfg: AgentConfig = {
      ...BASE_AGENT,
      promptMode: "argv",
      promptPosition: "prepend",
      args: ["run"],
    };
    const out = prepareSpawn({
      cfg,
      prompt: "PREPENDED",
      taskId: "s-argv-prepend",
      tmpDir: tmpRoot,
    });
    expect(out.args).toEqual(["PREPENDED", "run"]);
    out.cleanup();
  });

  it("falls back to append when promptMode=argv + replace is missing the placeholder", () => {
    // config.validate() rejects this combo at load time, but the
    // spawn path itself must not throw — runtime safety net for a
    // misconfigured runtime caller. Same guarantee as the arg-mode
    // fallback above.
    const cfg: AgentConfig = {
      ...BASE_AGENT,
      promptMode: "argv",
      promptPosition: "replace",
      args: ["run"],
    };
    const out = prepareSpawn({
      cfg,
      prompt: "FALLBACK ARGV",
      taskId: "s-argv-fallback",
      tmpDir: tmpRoot,
    });
    expect(out.args).toEqual(["run", "FALLBACK ARGV"]);
    out.cleanup();
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

  it("defaults promptPosition to append (backward compatible)", () => {
    const cfg: AgentConfig = {
      ...BASE_AGENT,
      args: ["--non-interactive"],
    };
    const out = prepareSpawn({
      cfg,
      prompt: "X",
      taskId: "s-default-pos",
      tmpDir: tmpRoot,
    });
    // When promptPosition is omitted the prompt pair sits at the end,
    // preserving the original argv layout.
    expect(out.args.slice(-2)).toEqual(["--prompt", out.args[out.args.length - 1]]);
    expect(out.args.indexOf("--prompt")).toBe(out.args.length - 2);
  });

  it("prepends the prompt pair when promptPosition=prepend", () => {
    const cfg: AgentConfig = {
      ...BASE_AGENT,
      promptPosition: "prepend",
      args: ["--non-interactive", "--model", "x"],
    };
    const out = prepareSpawn({
      cfg,
      prompt: "X",
      taskId: "s-prepend",
      tmpDir: tmpRoot,
    });
    expect(out.args.slice(0, 2)).toEqual(["--prompt", out.args[1]]);
    expect(out.args[2]).toBe("--non-interactive");
    expect(out.args[3]).toBe("--model");
    expect(out.args[4]).toBe("x");
    // The prompt file written for "prepend" still exists and is
    // cleaned up by the returned cleanup callback.
    const promptPath = out.args[1];
    expect(readFileSync(promptPath, "utf8")).toBe("X");
    out.cleanup();
    expect(existsSync(promptPath)).toBe(false);
  });

  it("replaces the {prompt} placeholder when promptPosition=replace", () => {
    const cfg: AgentConfig = {
      ...BASE_AGENT,
      promptPosition: "replace",
      args: ["--auto", "true", "run", PROMPT_PLACEHOLDER],
    };
    const out = prepareSpawn({
      cfg,
      prompt: "OPENCODE",
      taskId: "s-replace",
      tmpDir: tmpRoot,
    });
    // The placeholder is gone; the prompt pair takes its slot. The
    // example from the issue (s-1167) was exactly this argv shape for
    // the `opencode` CLI's `run` subcommand.
    expect(out.args).toEqual([
      "--auto",
      "true",
      "run",
      "--prompt",
      out.args[4],
    ]);
    expect(readFileSync(out.args[4], "utf8")).toBe("OPENCODE");
    out.cleanup();
  });

  // s-1238: pre-fix, `agent.args` was opaque to the runner. An
  // operator who wrote a single YAML scalar containing multiple
  // shell tokens — the natural way to type a CLI invocation —
  // produced one argv entry that the agent binary couldn't parse
  // (`opencode '--auto true run "do-kanban T-1003"'` instead of
  // four args). The fix runs every `args` entry through
  // `splitShellArgs` so each whitespace-separated token becomes its
  // own argv slot, with single / double quotes respected exactly as
  // the operator typed them.
  it("tokenises shell-style multi-token args (s-1238)", () => {
    const cfg: AgentConfig = {
      ...BASE_AGENT,
      promptMode: "argv",
      promptPosition: "append",
      args: ['--auto true run "do-kanban T-1003"'],
    };
    const out = prepareSpawn({
      cfg,
      prompt: "bye",
      taskId: "s-shellargs",
      tmpDir: tmpRoot,
    });
    expect(out.args).toEqual([
      "--auto",
      "true",
      "run",
      "do-kanban T-1003",
      "bye",
    ]);
    out.cleanup();
  });

  it("tokenises args before $name substitution so $var survives inside quotes", () => {
    const cfg: AgentConfig = {
      ...BASE_AGENT,
      promptMode: "argv",
      args: ['--task="$taskId" --flag'],
    };
    const out = prepareSpawn({
      cfg,
      prompt: "PROMPT",
      taskId: "s-shellargs-var",
      variables: { taskId: "abc" },
      tmpDir: tmpRoot,
    });
    expect(out.args).toEqual([
      "--task=abc",
      "--flag",
      "PROMPT",
    ]);
    out.cleanup();
  });

  it("tokenises args before the {prompt} placeholder check (s-1238)", () => {
    // The placeholder can now live inside a single tokenised entry,
    // so `promptPosition: replace` with the placeholder next to
    // other flags on the same line works as expected.
    const cfg: AgentConfig = {
      ...BASE_AGENT,
      promptMode: "argv",
      promptPosition: "replace",
      args: ['--auto true run "{prompt}"'],
    };
    const out = prepareSpawn({
      cfg,
      prompt: "POSITIONAL",
      taskId: "s-shellargs-replace",
      tmpDir: tmpRoot,
    });
    expect(out.args).toEqual([
      "--auto",
      "true",
      "run",
      "POSITIONAL",
    ]);
    out.cleanup();
  });

  it("replaces the {prompt} placeholder for promptMode=file", () => {
    const cwd = join(tmpRoot, "project-replace");
    mkdirSync(cwd, { recursive: true });
    const cfg: AgentConfig = {
      ...BASE_AGENT,
      promptMode: "file",
      promptPosition: "replace",
      args: ["run", PROMPT_PLACEHOLDER],
      cwd,
    };
    const out = prepareSpawn({
      cfg,
      prompt: "FILE REPLACE",
      taskId: "s-replace-file",
      cwd,
      tmpDir: tmpRoot,
    });
    expect(out.args).toEqual([
      "run",
      "--prompt-file",
      join(cwd, ".kanban-runner-s-replace-file.md"),
    ]);
    out.cleanup();
  });

  // s-1235: promptMode=acp appends the agent.acpFlag (default
  // `--acp`) to argv and forces pipeStdin=true so the spawn layer
  // opens the child's stdio for the JSON-RPC handshake. The prompt
  // itself never reaches disk or argv; it travels inside the
  // `session/prompt` request issued by `acp.ts`.
  it("appends the default --acp flag for promptMode=acp and forces pipeStdin", () => {
    const cfg: AgentConfig = { ...BASE_AGENT, promptMode: "acp", args: [] };
    const out = prepareSpawn({
      cfg,
      prompt: "ACP PROMPT",
      taskId: "s-acp",
      tmpDir: tmpRoot,
    });
    expect(out.args).toEqual(["--acp"]);
    expect(out.pipeStdin).toBe(true);
    expect(out.stdinPayload).toBeUndefined();
    expect(out.promptFile).toBeUndefined();
    out.cleanup();
  });

  it("honours a custom agent.acpFlag for promptMode=acp", () => {
    const cfg: AgentConfig = {
      ...BASE_AGENT,
      promptMode: "acp",
      acpFlag: "--agent-client-protocol",
      args: [],
    };
    const out = prepareSpawn({
      cfg,
      prompt: "ACP",
      taskId: "s-acp-custom",
      tmpDir: tmpRoot,
    });
    expect(out.args).toEqual(["--agent-client-protocol"]);
    out.cleanup();
  });

  it("falls back to append when promptPosition=replace is missing the placeholder", () => {
    // The strict validation in config.ts rejects this combo at load
    // time, but the spawn path itself must not throw — runtime safety
    // net for a misconfigured runtime caller.
    const cfg: AgentConfig = {
      ...BASE_AGENT,
      promptPosition: "replace",
      args: ["--non-interactive"],
    };
    const out = prepareSpawn({
      cfg,
      prompt: "FALLBACK",
      taskId: "s-replace-missing",
      tmpDir: tmpRoot,
    });
    expect(out.args).toEqual(["--non-interactive", "--prompt", out.args[2]]);
    out.cleanup();
  });

  // s-1187: per-task variable substitution in agent.args so operators
  // can build argv shapes like `--task=$taskId --title=$title` from
  // the hydrated task context.
  it("substitutes $name tokens in agent.args before the prompt splice", () => {
    const cfg: AgentConfig = {
      ...BASE_AGENT,
      args: ["--task=$taskId", "--title=$title", "--body=$body"],
    };
    const out = prepareSpawn({
      cfg,
      prompt: "PROMPT",
      taskId: "s-1187",
      tmpDir: tmpRoot,
      variables: {
        taskId: "s-1187",
        title: "wire up $name substitution",
        body: "support $taskId/$title/$body in args",
      },
    });
    // User-supplied flags land first (expanded), prompt pair appends.
    expect(out.args.slice(0, 3)).toEqual([
      "--task=s-1187",
      "--title=wire up $name substitution",
      "--body=support $taskId/$title/$body in args",
    ]);
    // The prompt flag + path still land at the end (default position).
    expect(out.args[out.args.length - 2]).toBe("--prompt");
    out.cleanup();
  });

  it("renders empty string for missing variables so argv shape is preserved", () => {
    const cfg: AgentConfig = {
      ...BASE_AGENT,
      args: ["--task=$taskId", "--title=$title", "--assignee=$assignee"],
    };
    const out = prepareSpawn({
      cfg,
      prompt: "PROMPT",
      taskId: "s-missing",
      tmpDir: tmpRoot,
      // No title, no assignee supplied.
      variables: { taskId: "s-missing" },
    });
    expect(out.args).toContain("--task=s-missing");
    expect(out.args).toContain("--title=");
    expect(out.args).toContain("--assignee=");
    // No shift in indices — the operator's argv layout survives.
    expect(out.args[0]).toBe("--task=s-missing");
    expect(out.args[1]).toBe("--title=");
    expect(out.args[2]).toBe("--assignee=");
    out.cleanup();
  });

  it("leaves unknown $name tokens unchanged so a stale config fails loudly", () => {
    const cfg: AgentConfig = {
      ...BASE_AGENT,
      // `$bogus` is not in SUPPORTED_ARG_VARIABLES; the validator
      // already rejects it, but the spawn layer must also be a safe
      // runtime fallback.
      args: ["--task=$taskId", "--bad=$bogus"],
    };
    const out = prepareSpawn({
      cfg,
      prompt: "PROMPT",
      taskId: "s-bogus",
      tmpDir: tmpRoot,
      variables: { taskId: "s-bogus" },
    });
    expect(out.args).toContain("--task=s-bogus");
    expect(out.args).toContain("--bad=$bogus");
    out.cleanup();
  });

  it("supports every variable in SUPPORTED_ARG_VARIABLES", () => {
    const cfg: AgentConfig = {
      ...BASE_AGENT,
      args: [
        "--task=$taskId",
        "--title=$title",
        "--body=$body",
        "--priority=$priority",
        "--assignee=$assignee",
        "--column=$columnId",
        "--board=$boardId",
      ],
    };
    const vars: Partial<ArgVariableValues> = {
      taskId: "t-1",
      title: "T",
      body: "B",
      priority: "high",
      assignee: "alice",
      columnId: "col-1",
      boardId: "sys",
    };
    const out = prepareSpawn({
      cfg,
      prompt: "PROMPT",
      taskId: "t-1",
      tmpDir: tmpRoot,
      variables: vars,
    });
    expect(out.args).toEqual([
      "--task=t-1",
      "--title=T",
      "--body=B",
      "--priority=high",
      "--assignee=alice",
      "--column=col-1",
      "--board=sys",
      "--prompt",
      out.args[out.args.length - 1],
    ]);
    out.cleanup();
  });
});

describe("expandArgs", () => {
  it("returns an empty array when given an empty input", () => {
    expect(expandArgs([], { taskId: "x" })).toEqual([]);
  });

  it("returns the same array contents when there are no $ tokens", () => {
    expect(expandArgs(["--foo", "bar"], { taskId: "x" })).toEqual([
      "--foo",
      "bar",
    ]);
  });

  it("does not mutate the input array", () => {
    const input = ["--task=$taskId", "--literal"];
    const snapshot = [...input];
    expandArgs(input, { taskId: "abc" });
    expect(input).toEqual(snapshot);
  });

  it("replaces multiple occurrences in the same string", () => {
    expect(
      expandArgs(
        ["$taskId-$taskId"],
        { taskId: "z" }
      )
    ).toEqual(["z-z"]);
  });

  it("ignores POSIX shell-style references that look like variables", () => {
    // `${HOME}`, `$1`, `$?`, `$$` must NOT be substituted — only the
    // narrow `$name` form is recognised.
    expect(
      expandArgs(
        ["${HOME}", "$1", "$?", "$$"],
        { HOME: "should-not-show" }
      )
    ).toEqual(["${HOME}", "$1", "$?", "$$"]);
  });
});

describe("splitShellArgs", () => {
  // s-1238: each `agent.args` entry is opaque to YAML, so an
  // operator who writes a single scalar containing multiple shell
  // tokens (the natural way to type a CLI invocation) ends up with
  // one argv entry that the agent binary cannot parse. The runner
  // now runs every entry through a POSIX-style shell tokenizer
  // before any other transform. Fast-path is the common case
  // (`args: ["--flag", "value"]`) — no whitespace, no quoting →
  // returned unchanged.

  it("returns a single token unchanged when there is no whitespace or quoting", () => {
    expect(splitShellArgs("--flag")).toEqual(["--flag"]);
    expect(splitShellArgs("/usr/local/bin/opencode")).toEqual([
      "/usr/local/bin/opencode",
    ]);
    expect(splitShellArgs("--key=value")).toEqual(["--key=value"]);
  });

  it("splits on whitespace", () => {
    expect(splitShellArgs("--auto true run")).toEqual([
      "--auto",
      "true",
      "run",
    ]);
  });

  it("groups double-quoted segments into one token", () => {
    // The exact failure from s-1238: the operator wrote
    //   args:
    //     - --auto true run "do-kanban T-1003"
    // expecting four argv entries.
    expect(splitShellArgs('--auto true run "do-kanban T-1003"')).toEqual([
      "--auto",
      "true",
      "run",
      "do-kanban T-1003",
    ]);
  });

  it("groups single-quoted segments into one token", () => {
    expect(splitShellArgs("--key='hello world'")).toEqual([
      "--key=hello world",
    ]);
  });

  it("treats single quotes as fully literal (no backslash escape)", () => {
    // POSIX rule: inside '…' nothing is interpreted, not even \\.
    expect(splitShellArgs("--key='a\\b'")).toEqual(["--key=a\\b"]);
  });

  it("honours backslash escapes inside double quotes", () => {
    expect(splitShellArgs('--key="he said \\"hi\\""')).toEqual([
      '--key=he said "hi"',
    ]);
  });

  it("honours backslash escapes outside quotes", () => {
    expect(splitShellArgs("--key=a\\ b")).toEqual(["--key=a b"]);
  });

  it("collapses runs of whitespace and ignores leading / trailing spaces", () => {
    expect(splitShellArgs("  --a   --b  ")).toEqual(["--a", "--b"]);
  });

  it("treats tabs and newlines as separators", () => {
    expect(splitShellArgs("--a\t--b\n--c")).toEqual(["--a", "--b", "--c"]);
  });

  it("preserves $name tokens intact for downstream substitution", () => {
    // splitShellArgs runs *before* expandArgs, so a quoted $var must
    // survive tokenisation as a literal `$taskId` token. We assert
    // the full round-trip with expandArgs below.
    expect(splitShellArgs('--task="$taskId" --flag')).toEqual([
      "--task=$taskId",
      "--flag",
    ]);
  });

  it("throws on an unterminated double quote", () => {
    expect(() => splitShellArgs('--key="unterminated')).toThrow(
      /unterminated double quote/
    );
  });

  it("throws on an unterminated single quote", () => {
    expect(() => splitShellArgs("--key='unterminated")).toThrow(
      /unterminated single quote/
    );
  });

  it("returns an empty array only when the input is fully whitespace", () => {
    // Defensive: the upstream loop ignores empty `args`, but we
    // don't want a stray whitespace entry to drop the whole config.
    expect(splitShellArgs("")).toEqual([""]);
    expect(splitShellArgs("   ")).toEqual([]);
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

  // s-1185: pre-fix, the runner silently discarded stdout (`on("data", () => undefined)`).
  // opencode's banner was painted to stderr and the agent's actual
  // reply on stdout was lost, so the task detail page showed the
  // banner as the user-facing "Error" field. Capture stdout in the
  // same shape as stderr and the two streams stay independent.
  it("captures stdout separately from stderr when both are written", async () => {
    const { result } = await runInlineScript(
      `process.stdout.write("hello world\\n");process.stderr.write("opencode build · v1\\n");process.exit(0);`
    );
    expect(result.exitCode).toBe(0);
    expect(result.reason).toBe("exit");
    expect(result.stdout).toBe("hello world\n");
    expect(result.stderr).toBe("opencode build · v1\n");
  });

  it("defaults stdout to an empty string when the child writes nothing", async () => {
    const { result } = await runInlineScript("process.exit(0);");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("truncates stdout to 64 KiB when the child writes more", async () => {
    // Same shape as the stderr truncation test: a delay between
    // write and exit lets the OS pipe drain so the parent sees
    // the full 80 KiB request before the close event fires.
    const { result } = await runInlineScript(
      `process.stdout.write("B".repeat(80 * 1024));await new Promise(r=>setTimeout(r,100));process.exit(0);`
    );
    expect(result.exitCode).toBe(0);
    expect(result.reason).toBe("exit");
    expect(result.stdout.length).toBeGreaterThan(0);
    expect(result.stdout.length).toBeLessThanOrEqual(
      STDOUT_TRUNCATE_BYTES + "[truncated]".length + 5
    );
    expect(result.stdout).toContain("[truncated]");
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
      stdout: "",
      reason: "exit",
    });
    const result = await child.wait();
    expect(result.exitCode).toBe(0);
    expect(fakes.calls[0].bin).toBe(process.execPath);
    expect(fakes.calls[0].args).toContain("--prompt");
  });
});
