// Tests for `cli/src/runner/prompt.ts` — §4.4 markdown assembly.
//
// Three categories of coverage:
//
//   1. Snapshot — the full prompt body for a representative task. Any
//      change here is a deliberate breaking change for downstream
//      agents; the snapshot pins every line.
//   2. Section omission — optional sections (description, comments,
//      subtasks) must be absent, not blank, so the agent can rely on
//      absence as a signal.
//   3. `hydrateContext` — best-effort fallback when an auxiliary
//      fetch fails; the loop must never drop a task because of a
//      comments-endpoint hiccup.

import { describe, expect, it } from "vitest";
import {
  type BoardContext,
  type ColumnContext,
  type CommentContext,
  hydrateContext,
  type HydrateOptions,
  normaliseTask,
  type PromptContext,
  type SubtaskContext,
  type TaskHydrator,
  renderPrompt,
} from "../../src/runner/prompt.js";
import type { TaskRecord } from "../../src/commands/tasks.js";

const SAMPLE_TASK: TaskRecord = {
  id: "s-1090",
  title: "Implement CLI runner loop",
  description: "Wire the long-lived loop that picks up tasks and runs the agent binary.",
  priority: "high",
  assignee: "claude-bot",
  columnId: "zhong-sys",
  agentPrompt: "Follow the §4.2 algorithm verbatim; do not skip the heartbeat step.",
  meta: {
    labels: ["runner", "loop"],
    retry: 3,
  },
};

const SAMPLE_BOARD: BoardContext = {
  id: "sys",
  name: "Open Kanban",
  description: "Primary engineering kanban",
};

const SAMPLE_COLUMN: ColumnContext = {
  id: "zhong-sys",
  name: "进行中",
  status: "in_progress",
  description: "Tasks being actively worked on by a runner or human",
};

const SAMPLE_COMMENTS: CommentContext[] = [
  { id: "c1", author: "alice", content: "Make sure to use fake timers in the loop test." },
  { id: "c2", author: "bob", content: "Heartbeat must be configurable." },
];

const SAMPLE_SUBTASKS: SubtaskContext[] = [
  { id: "st1", title: "Implement claim/finish/release helpers", completed: true },
  { id: "st2", title: "Wire the heartbeat scheduler", completed: false },
  { id: "st3", title: "Cover SIGTERM drain with a test", completed: false },
];

function sampleContext(): PromptContext {
  return {
    board: SAMPLE_BOARD,
    column: SAMPLE_COLUMN,
    task: SAMPLE_TASK,
    comments: SAMPLE_COMMENTS,
    subtasks: SAMPLE_SUBTASKS,
  };
}

describe("renderPrompt — happy path snapshot", () => {
  it("renders the full markdown payload deterministically", () => {
    const out = renderPrompt(sampleContext());
    expect(out).toMatchInlineSnapshot(`
      "# Board: Open Kanban
      Primary engineering kanban

      # Column: 进行中
      Tasks being actively worked on by a runner or human

      # Task s-1090
      Title: Implement CLI runner loop
      Priority: high
      Assignee: claude-bot

      ## Description
      Wire the long-lived loop that picks up tasks and runs the agent binary.

      ## Agent Prompt
      Follow the §4.2 algorithm verbatim; do not skip the heartbeat step.

      ## Meta
      {
        "labels": [
          "runner",
          "loop"
        ],
        "retry": 3
      }

      ## Comments
      - alice: Make sure to use fake timers in the loop test.
      - bob: Heartbeat must be configurable.

      ## Subtasks
      - [x] Implement claim/finish/release helpers
      - [ ] Wire the heartbeat scheduler
      - [ ] Cover SIGTERM drain with a test
      "
    `);
  });
});

describe("renderPrompt — optional sections", () => {
  it("omits the description section when the task has none", () => {
    const ctx: PromptContext = {
      ...sampleContext(),
      task: { ...SAMPLE_TASK, description: "" },
    };
    const out = renderPrompt(ctx);
    expect(out).not.toContain("## Description");
  });

  it("shows the comments section as '(none)' when the thread is empty", () => {
    const ctx: PromptContext = { ...sampleContext(), comments: [] };
    const out = renderPrompt(ctx);
    expect(out).toContain("## Comments\n(none)");
  });

  it("shows the subtasks section as '(none)' when the checklist is empty", () => {
    const ctx: PromptContext = { ...sampleContext(), subtasks: [] };
    const out = renderPrompt(ctx);
    expect(out).toContain("## Subtasks\n(none)");
  });

  it("falls back to safe sentinels for missing board/column/task fields", () => {
    const ctx: PromptContext = {
      board: { id: "b", name: "" },
      column: { id: "c", name: "" },
      task: {},
      comments: [],
      subtasks: [],
    };
    const out = renderPrompt(ctx);
    expect(out).toContain("# Board: b");
    expect(out).toContain("# Column: c");
    expect(out).toContain("# Task (unknown id)");
    expect(out).toContain("Title: (untitled)");
    expect(out).toContain("Assignee: unassigned");
    expect(out).toContain("(no description)");
  });

  it("honours ctx.agentPrompt overrides over task.agentPrompt", () => {
    const ctx: PromptContext = {
      ...sampleContext(),
      agentPrompt: "OVERRIDE",
    };
    const out = renderPrompt(ctx);
    expect(out).toContain("## Agent Prompt\nOVERRIDE");
  });
});

describe("normaliseTask", () => {
  it("extracts the well-known fields from a raw API payload", () => {
    const raw = {
      id: "s-1",
      title: "title",
      description: "desc",
      priority: "high",
      assignee: "alice",
      columnId: "col-1",
      position: 7,
      meta: { x: 1 },
      agentId: "agent-1",
      agentPrompt: "go",
    };
    const task = normaliseTask(raw);
    expect(task).toEqual({
      id: "s-1",
      title: "title",
      description: "desc",
      priority: "high",
      assignee: "alice",
      meta: { x: 1 },
      columnId: "col-1",
      position: 7,
      agentId: "agent-1",
      agentPrompt: "go",
    });
  });

  it("returns an empty record for non-object inputs", () => {
    expect(normaliseTask(null)).toEqual({});
    expect(normaliseTask(undefined)).toEqual({});
    expect(normaliseTask("not-an-object")).toEqual({});
  });
});

describe("hydrateContext", () => {
  function makeHydrator(opts: Partial<{
    comments: () => Promise<CommentContext[]>;
    subtasks: () => Promise<SubtaskContext[]>;
    board: () => Promise<BoardContext>;
    column: () => Promise<ColumnContext>;
    task: () => Promise<TaskRecord>;
  }> = {}): TaskHydrator {
    return {
      fetchComments: opts.comments ?? (async () => []),
      fetchSubtasks: opts.subtasks ?? (async () => []),
      fetchBoard: opts.board ?? (async () => ({ id: "b", name: "Board" })),
      fetchColumn: opts.column ?? (async () => ({ id: "c", name: "Column" })),
      fetchTask: opts.task ?? (async () => SAMPLE_TASK),
    };
  }

  it("combines comments, subtasks, board, column into a PromptContext", async () => {
    const hydrator = makeHydrator({
      comments: async () => SAMPLE_COMMENTS,
      subtasks: async () => SAMPLE_SUBTASKS,
      board: async () => SAMPLE_BOARD,
      column: async () => SAMPLE_COLUMN,
    });
    const ctx = await hydrateContext(hydrator, { id: "s-1", columnId: "c" }, {
      boardId: "sys",
      columnId: "c",
    } satisfies HydrateOptions);
    expect(ctx.board).toEqual(SAMPLE_BOARD);
    expect(ctx.column).toEqual(SAMPLE_COLUMN);
    expect(ctx.comments).toEqual(SAMPLE_COMMENTS);
    expect(ctx.subtasks).toEqual(SAMPLE_SUBTASKS);
  });

  it("falls back to empty arrays when comments/subtasks fetch fails", async () => {
    const hydrator = makeHydrator({
      comments: async () => {
        throw new Error("down");
      },
      subtasks: async () => {
        throw new Error("down");
      },
    });
    const ctx = await hydrateContext(hydrator, { id: "s-1", columnId: "c" });
    expect(ctx.comments).toEqual([]);
    expect(ctx.subtasks).toEqual([]);
  });

  it("falls back to a placeholder board when board fetch fails (non-strict)", async () => {
    const hydrator = makeHydrator({
      board: async () => {
        throw new Error("down");
      },
    });
    const ctx = await hydrateContext(hydrator, { id: "s-1", columnId: "c" }, {
      boardId: "sys",
    });
    expect(ctx.board).toEqual({ id: "sys", name: "sys", description: null });
  });

  it("throws when board fetch fails in strict mode", async () => {
    const hydrator = makeHydrator({
      board: async () => {
        throw new Error("down");
      },
    });
    await expect(
      hydrateContext(
        hydrator,
        { id: "s-1", columnId: "c" },
        { boardId: "sys", strict: true }
      )
    ).rejects.toThrow("down");
  });
});
