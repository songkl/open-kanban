// Tests for the `kanban completion <shell>` command and the hidden
// `__complete <line>` runner.
//
// The suite is split into three layers that mirror the production
// code:
//
//   1. `renderShell` — pure generator: feed it (shell, bin) tuples and
//      assert the output contains the right header / `complete -F`
//      registration / `#compdef` directive. No streams touched.
//   2. `runCompletion` — the public command entry: a fake
//      stdout/stderr captures the script; the thrown
//      UnsupportedShellError is covered.
//   3. `runComplete` — the dynamic endpoint. A stubbed HttpClient
//      (the `scriptFetch` pattern from the e2e tests) serves canned
//      responses for `/api/v1/boards`, `/api/v1/columns`, and
//      `/api/v1/tasks`; the runner's stdout is asserted to contain the
//      expected `<value>\t<description>` lines for each scenario.
//
// All tests use table-driven `it.each`-style subtests where it makes
// sense so a future shell / new command path can be covered by adding a
// single row.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";
import { HttpClient } from "../http/client.js";
import {
  COMMON_FLAG_VALUES,
  DYNAMIC_ID_TASKS,
  FLAGS_PER_COMMAND,
  GLOBAL_FLAGS,
  SUBCOMMANDS,
  TOP_LEVEL_COMMANDS,
  UnsupportedShellError,
  listShells,
  normaliseShell,
  pathForTokens,
  renderShell,
  runComplete,
  runCompletion,
  shellQuote,
  type CompleteResult,
} from "./completion.js";

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function makeCapture(): {
  io: {
    stdout: NodeJS.WritableStream;
    stderr: NodeJS.WritableStream;
  };
  read: () => { stdout: string; stderr: string };
  reset: () => void;
} {
  let stdout = "";
  let stderr = "";
  const out = new Writable({
    write(chunk, _enc, cb) {
      stdout += chunk.toString();
      cb();
    },
  });
  const err = new Writable({
    write(chunk, _enc, cb) {
      stderr += chunk.toString();
      cb();
    },
  });
  return {
    io: {
      stdout: out as unknown as NodeJS.WritableStream,
      stderr: err as unknown as NodeJS.WritableStream,
    },
    read: () => ({ stdout, stderr }),
    reset() {
      stdout = "";
      stderr = "";
    },
  };
}

// scriptFetch installs a mock for `globalThis.fetch` that records every
// call and replays a fixed sequence of responses.
function scriptFetch(
  responses: Array<{ status: number; body?: unknown }>
): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let i = 0;
  const spy = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(spy);
  return { calls };
}

describe("normaliseShell / listShells", () => {
  it.each([
    ["bash", "bash"],
    ["BASH", "bash"],
    ["  zsh  ", "zsh"],
    ["Fish", "fish"],
  ])("normalises %s to %s", (input, expected) => {
    expect(normaliseShell(input)).toBe(expected);
  });

  it("returns empty string for unsupported shells", () => {
    expect(normaliseShell("powershell")).toBe("");
    expect(normaliseShell("")).toBe("");
  });

  it("listShells returns the canonical set", () => {
    expect(listShells().slice().sort()).toEqual(["bash", "fish", "zsh"]);
  });
});

describe("renderShell", () => {
  it.each([
    ["bash", "# bash completion for kanban", "complete -F _kanban_completion kanban"],
    ["zsh", "#compdef kanban", "_kanban() {"],
    ["fish", "# fish completion for kanban", "complete -c kanban"],
  ])(
    "the %s script contains the expected header / registration lines",
    (shell, header, registration) => {
      const script = renderShell(shell as "bash" | "zsh" | "fish");
      expect(script).toContain(header);
      expect(script).toContain(registration);
    }
  );

  it("substitutes a custom binary name everywhere it appears", () => {
    const bash = renderShell("bash", "kbn");
    expect(bash).toContain("# bash completion for kbn");
    expect(bash).toContain("complete -F _kbn_completion kbn");
    const zsh = renderShell("zsh", "kbn");
    expect(zsh).toContain("#compdef kbn");
    const fish = renderShell("fish", "kbn");
    expect(fish).toContain("# fish completion for kbn");
  });

  it("the bash script registers every subcommand in SUBCOMMANDS", () => {
    const script = renderShell("bash");
    for (const [, subs] of Object.entries(SUBCOMMANDS)) {
      for (const sub of subs) {
        expect(script).toContain(sub);
      }
    }
  });

  it("the bash script embeds closed-set flag values", () => {
    const script = renderShell("bash");
    expect(script).toContain("--output)");
    expect(script).toContain("table json yaml");
    expect(script).toContain("--priority)");
    expect(script).toContain("low medium high");
  });

  it("the fish script emits a `complete -c` line per global flag", () => {
    const script = renderShell("fish");
    for (const f of GLOBAL_FLAGS) {
      const short = f.replace(/^--/, "");
      expect(script).toContain(`complete -c kanban -l "${short}"`);
    }
  });

  it("the bash script delegates to `kanban __complete` for dynamic ids", () => {
    const script = renderShell("bash");
    expect(script).toContain('__complete "\${line}\${cur}"');
  });
});

describe("runCompletion", () => {
  it("writes the bash script to stdout and an install hint to stderr", () => {
    const cap = makeCapture();
    const script = runCompletion({ shell: "bash", io: cap.io });
    expect(script).toContain("# bash completion for kanban");
    const { stdout, stderr } = cap.read();
    expect(stdout).toBe(script);
    expect(stderr).toContain("kanban completion bash");
    expect(stderr).toContain("Install per the README");
  });

  it.each(["zsh", "fish"] as const)(
    "supports the %s shell",
    (shell) => {
      const cap = makeCapture();
      const script = runCompletion({ shell, io: cap.io });
      expect(script.length).toBeGreaterThan(100);
      const { stdout } = cap.read();
      expect(stdout).toBe(script);
    }
  );

  it("throws UnsupportedShellError for unknown shells", () => {
    const cap = makeCapture();
    expect(() => runCompletion({ shell: "powershell", io: cap.io })).toThrow(
      UnsupportedShellError
    );
  });

  it("is case-insensitive for the shell name", () => {
    const cap = makeCapture();
    const script = runCompletion({ shell: "BASH", io: cap.io });
    expect(script).toContain("# bash completion for kanban");
  });
});

describe("shellQuote", () => {
  it.each([
    ["plain", "plain"],
    ["with space", "with space"],
    ["with'apos", "with'apos"],
    ["", ""],
  ])("quotes %s", (_label, input) => {
    const out = shellQuote(input);
    expect(out.startsWith("'")).toBe(true);
    expect(out.endsWith("'")).toBe(true);
  });

  it("escapes embedded single quotes per the POSIX rules", () => {
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
  });
});

describe("pathForTokens", () => {
  it.each([
    [["tasks"], "tasks"],
    [["tasks", "list"], "tasks list"],
    [["tasks", "batch", "create"], "tasks batch create"],
    [["boards", "list", "--fields", "id"], "boards list"],
    [["tasks", "list", "--status", "done"], "tasks list"],
    [["unknown"], ""],
    [["boards", "bogus"], "boards"],
    [["--output", "json", "boards", "list"], "boards list"],
  ])("resolves %p → %p", (tokens, expected) => {
    expect(pathForTokens(tokens)).toBe(expected);
  });

  it("does not mistake a flag value for a subcommand", () => {
    expect(pathForTokens(["tasks", "list", "--status", "in_progress"])).toBe(
      "tasks list"
    );
  });

  it("does not match `kanban` (caller strips it before calling)", () => {
    // The runner strips `kanban` before calling pathForTokens, so a
    // stray `kanban` token is treated as an unknown positional and
    // breaks the walk at the first segment.
    expect(pathForTokens(["kanban", "tasks", "list"])).toBe("");
  });
});

describe("runComplete", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("suggests subcommands when the cursor sits on a parent", async () => {
    const cap = makeCapture();
    const http = new HttpClient({ apiUrl: "http://kanban.test" });
    const result = await runComplete({
      line: "kanban ",
      io: cap.io,
      http,
    });
    expect(result.path).toBe("");
    const lines = cap.read().stdout.split("\n").filter((l) => l.length > 0);
    // Only top-level commands (no nested paths with spaces) are
    // surfaced as single tokens at the top level.
    for (const sub of TOP_LEVEL_COMMANDS) {
      if (sub.includes(" ")) continue;
      expect(lines).toContain(sub);
    }
  });

  it("suggests subcommand children when the path resolves", async () => {
    const cap = makeCapture();
    const http = new HttpClient({ apiUrl: "http://kanban.test" });
    const result = await runComplete({
      line: "kanban tasks ",
      io: cap.io,
      http,
    });
    expect(result.path).toBe("tasks");
    const lines = cap.read().stdout.split("\n").filter((l) => l.length > 0);
    for (const child of SUBCOMMANDS.tasks) {
      expect(lines).toContain(child);
    }
  });

  it("suggests global flags when the cursor is on `--`", async () => {
    const cap = makeCapture();
    const http = new HttpClient({ apiUrl: "http://kanban.test" });
    const result = await runComplete({
      line: "kanban --",
      io: cap.io,
      http,
    });
    const lines = cap.read().stdout.split("\n").filter((l) => l.length > 0);
    for (const f of GLOBAL_FLAGS) {
      expect(lines).toContain(f);
    }
    expect(result.candidates.length).toBe(GLOBAL_FLAGS.length);
  });

  it("suggests per-command flags when the path is set", async () => {
    const cap = makeCapture();
    const http = new HttpClient({ apiUrl: "http://kanban.test" });
    const result = await runComplete({
      line: "kanban tasks list --",
      io: cap.io,
      http,
    });
    const lines = cap.read().stdout.split("\n").filter((l) => l.length > 0);
    for (const f of FLAGS_PER_COMMAND["tasks list"]) {
      expect(lines).toContain(f);
    }
    expect(result.path).toBe("tasks list");
  });

  it("suggests closed-set flag values when the previous token is the flag", async () => {
    const cap = makeCapture();
    const http = new HttpClient({ apiUrl: "http://kanban.test" });
    await runComplete({
      line: "kanban tasks list --status ",
      io: cap.io,
      http,
    });
    const lines = cap.read().stdout.split("\n").filter((l) => l.length > 0);
    for (const v of COMMON_FLAG_VALUES["--status"]) {
      expect(lines).toContain(v);
    }
  });

  it("fetches dynamic task ids when completing `kanban tasks get `", async () => {
    const { calls } = scriptFetch([
      {
        status: 200,
        body: [
          { id: "t1", title: "First task" },
          { id: "t2", title: "Second task" },
        ],
      },
    ]);
    const cap = makeCapture();
    const http = new HttpClient({ apiUrl: "http://kanban.test" });
    const result = await runComplete({
      line: "kanban tasks get ",
      io: cap.io,
      http,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://kanban.test/api/v1/tasks");
    const { stdout } = cap.read();
    expect(stdout).toContain("t1\tFirst task");
    expect(stdout).toContain("t2\tSecond task");
    expect(result.candidates.map((c) => c.value)).toEqual(["t1", "t2"]);
  });

  it("fetches dynamic board ids for `kanban boards get `", async () => {
    scriptFetch([
      {
        status: 200,
        body: [
          { id: "b1", name: "Alpha" },
          { id: "b2", name: "Beta" },
        ],
      },
    ]);
    const cap = makeCapture();
    const http = new HttpClient({ apiUrl: "http://kanban.test" });
    await runComplete({
      line: "kanban boards get ",
      io: cap.io,
      http,
    });
    const { stdout } = cap.read();
    expect(stdout).toContain("b1\tAlpha");
    expect(stdout).toContain("b2\tBeta");
  });

  it("scopes column ids by `--board` when fetching `tasks create` columns", async () => {
    const { calls } = scriptFetch([
      {
        status: 200,
        body: [{ id: "c1", name: "Todo" }],
      },
    ]);
    const cap = makeCapture();
    const http = new HttpClient({ apiUrl: "http://kanban.test" });
    await runComplete({
      line: "kanban tasks create --board b1 ",
      io: cap.io,
      http,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "http://kanban.test/api/v1/columns?boardId=b1"
    );
  });

  it("returns an empty candidate list (and writes to stderr) when the API errors", async () => {
    scriptFetch([{ status: 500, body: { error: "boom" } }]);
    const cap = makeCapture();
    const http = new HttpClient({ apiUrl: "http://kanban.test" });
    const result = await runComplete({
      line: "kanban tasks get ",
      io: cap.io,
      http,
    });
    expect(result.candidates).toEqual([]);
    const { stderr } = cap.read();
    expect(stderr).toContain("kanban __complete:");
  });

  it("returns an empty candidate list when the API is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    const cap = makeCapture();
    const http = new HttpClient({ apiUrl: "http://kanban.test" });
    const result: CompleteResult = await runComplete({
      line: "kanban tasks get ",
      io: cap.io,
      http,
    });
    expect(result.candidates).toEqual([]);
    const { stderr } = cap.read();
    expect(stderr).toContain("network unreachable");
  });

  it("clamps the cursor point so partial tokens don't lock the completion", async () => {
    scriptFetch([
      {
        status: 200,
        body: [{ id: "t1", title: "Only" }],
      },
    ]);
    const cap = makeCapture();
    const http = new HttpClient({ apiUrl: "http://kanban.test" });
    const result = await runComplete({
      line: "kanban tasks get t",
      point: "kanban tasks get t".length,
      io: cap.io,
      http,
    });
    // The path should resolve to `tasks get`, not `tasks get t`, so the
    // dynamic fetcher is invoked (rather than being skipped because the
    // partial token "looks completed").
    expect(result.path).toBe("tasks get");
    expect(result.candidates.map((c) => c.value)).toEqual(["t1"]);
  });

  it("does not fire a network request when the cursor sits on a subcommand position", async () => {
    const { calls } = scriptFetch([{ status: 200, body: [] }]);
    const cap = makeCapture();
    const http = new HttpClient({ apiUrl: "http://kanban.test" });
    await runComplete({
      line: "kanban ",
      io: cap.io,
      http,
    });
    expect(calls).toHaveLength(0);
  });
});

describe("static tables", () => {
  it("TOP_LEVEL_COMMANDS contains every subcommand root", () => {
    const expected = [
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
      "workspace",
      "shell",
      "completion",
      "config",
    ];
    for (const e of expected) {
      expect(TOP_LEVEL_COMMANDS).toContain(e);
    }
  });

  it("FLAGS_PER_COMMAND has a flag list for every leaf command", () => {
    // Walk SUBCOMMANDS and collect every leaf path. Each leaf should
    // have a flag list so the completer can surface `--api-url` /
    // `--output` etc. when the user types `<command> <sub> --`.
    const leaves: string[] = [];
    function collect(prefix: string, children: readonly string[]) {
      for (const c of children) {
        const next = prefix === "" ? c : `${prefix} ${c}`;
        const nested = SUBCOMMANDS[next];
        if (nested && nested.length > 0) {
          collect(next, nested);
        } else {
          leaves.push(next);
        }
      }
    }
    for (const [prefix, children] of Object.entries(SUBCOMMANDS)) {
      collect(prefix, children);
    }
    // Plus the empty path (used when the user is at the root).
    leaves.push("");
    const missing = leaves.filter((l) => !(l in FLAGS_PER_COMMAND));
    expect(missing, `missing flag lists for: ${missing.join(", ")}`).toEqual([]);
  });

  it("DYNAMIC_ID_TASKS only references valid subcommand paths", () => {
    for (const t of DYNAMIC_ID_TASKS) {
      // Walk the command path segment-by-segment. Each segment must be
      // a child of its parent in SUBCOMMANDS; the final segment can be
      // a leaf (no further children needed).
      const segments = t.command.split(" ");
      let parent = "";
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const allowed =
          parent === ""
            ? (TOP_LEVEL_COMMANDS as readonly string[])
            : (SUBCOMMANDS[parent] ?? []);
        expect(allowed.includes(seg)).toBe(true);
        parent = parent === "" ? seg : `${parent} ${seg}`;
      }
    }
  });
});