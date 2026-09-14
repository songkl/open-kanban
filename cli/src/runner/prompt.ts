// Agent prompt assembly — §4.4 of
// `devDoc/CLI_RUNNER_PLAN_2026-09-12.md`.
//
// The CLI runner does not embed any agent logic; it composes a markdown
// payload and hands it to an external binary (`opencode`, `claude`,
// `cursor`, …). Three concerns drive the shape of this module:
//
//   1. The payload must be **deterministic**. Snapshots are part of the
//      test contract, so the renderer must use the same separator and
//      field order on every call (no random IDs, no timestamps).
//   2. The renderer is **pure**. It does no I/O; the loop module
//      fetches comments / subtasks / board / column ahead of time and
//      passes them in. This keeps the test surface trivial.
//   3. Optional sections are **absent**, not blank. A task without a
//      description still produces a well-formed prompt; the absence
//      of a section is itself a signal the agent can rely on.
//
// The on-the-wire task representation in
// `devDoc/CLI_RUNNER_OPENAPI_2026-09-12.yaml` already includes
// `_count.comments` / `_count.subtasks`. To produce a useful prompt we
// need the full arrays; the loop hydrates them by issuing a follow-up
// `GET /api/v1/tasks/:id` after a claim (see `loop.ts`).

import type { TaskRecord } from "../commands/tasks.js";

/**
 * Minimal board record the renderer needs. Mirrors
 * `GET /api/v1/boards/:id` — we accept the trimmed shape so this
 * module stays free of `boards.ts` plumbing.
 */
export interface BoardContext {
  id: string;
  name: string;
  description?: string | null;
}

/**
 * Minimal column record the renderer needs. Mirrors
 * `GET /api/v1/columns/:id` — name + description are the only fields
 * the agent prompt consumes.
 */
export interface ColumnContext {
  id: string;
  name: string;
  status?: string | null;
  description?: string | null;
}

/**
 * A comment entry as returned by `GET /api/v1/comments?taskId=…`.
 * Only `author` and `content` end up in the prompt body.
 */
export interface CommentContext {
  id?: string;
  author?: string | null;
  content?: string;
  createdAt?: string;
}

/**
 * A subtask entry as returned by `GET /api/v1/subtasks?taskId=…`.
 */
export interface SubtaskContext {
  id?: string;
  title?: string;
  completed?: boolean;
}

/**
 * Inputs to `renderPrompt`. The loop fetches each piece ahead of time
 * and bundles them in here.
 */
export interface PromptContext {
  board: BoardContext;
  column: ColumnContext;
  task: TaskRecord;
  comments: CommentContext[];
  subtasks: SubtaskContext[];
  /** Optional override; defaults to the task's own `agentPrompt`. */
  agentPrompt?: string | null;
}

/**
 * Format a `unknown` `task.meta` payload as a deterministic JSON
 * string. We normalise via `JSON.stringify(value, null, 2)` with a
 * sorted-key replacer so the same object always serialises to the same
 * bytes — important for snapshot tests and for agents that hash the
 * prompt.
 */
function formatMeta(meta: unknown): string {
  if (meta === undefined || meta === null) return "{}";
  const seen = new WeakSet<object>();
  const replacer = (_key: string, value: unknown): unknown => {
    if (typeof value === "bigint") return value.toString();
    if (value && typeof value === "object") {
      if (seen.has(value as object)) return "[Circular]";
      seen.add(value as object);
      if (!Array.isArray(value)) {
        const sorted: Record<string, unknown> = {};
        for (const k of Object.keys(value as Record<string, unknown>).sort()) {
          sorted[k] = (value as Record<string, unknown>)[k];
        }
        return sorted;
      }
    }
    return value;
  };
  try {
    return JSON.stringify(meta, replacer, 2);
  } catch {
    return "{}";
  }
}

function safe(text: string | null | undefined, fallback: string): string {
  if (text === undefined || text === null || text === "") return fallback;
  return text;
}

/**
 * Compose the markdown payload for the agent. The renderer is the
 * single source of truth for the wire format: any change here is a
 * breaking change for downstream agents, so the snapshot test in
 * `tests/runner/prompt.test.ts` pins every line.
 *
 * Section order (and presence) is intentional:
 *
 *   1. `# Board: <name>`           — gives the agent its operating
 *                                    scope (which project, which
 *                                    workflow conventions).
 *   2. `# Column: <name>`          — narrows to the column-level
 *                                    rules / acceptance criteria.
 *   3. `# Task <id>`               — the unit of work (metadata:
 *                                    title / priority / assignee).
 *   4. `## Agent Prompt`           — task-defined instructions.
 *   5. `## Meta`                   — structured metadata.
 *   6. `## Comments`               — discussion thread.
 *   7. `## Subtasks`               — checklist.
 *   8. `## Task Content`           — the task's own description,
 *                                    always rendered last so the
 *                                    agent's final-viewed block is
 *                                    the actionable instruction
 *                                    itself (per s-1165). The
 *                                    section is always present even
 *                                    when the description is empty —
 *                                    the placeholder "(no content)"
 *                                    is a signal the agent can rely
 *                                    on rather than the absence of a
 *                                    header.
 *
 * Earlier drafts inlined the description inside `# Task <id>`; the
 * rearrangement puts context (board / column / meta / comments /
 * subtasks) up front and reserves the bottom of the prompt for the
 * task's own content. Agents that scroll-to-end or quote the last
 * markdown section therefore see the description verbatim.
 */
export function renderPrompt(ctx: PromptContext): string {
  const sections: string[] = [];
  sections.push(`# Board: ${safe(ctx.board.name, ctx.board.id)}`);
  sections.push(safe(ctx.board.description, "(no description)"));
  sections.push("");
  sections.push(`# Column: ${safe(ctx.column.name, ctx.column.id)}`);
  sections.push(safe(ctx.column.description, "(no description)"));
  sections.push("");
  sections.push(`# Task ${safe(ctx.task.id, "(unknown id)")}`);
  sections.push(`Title: ${safe(ctx.task.title, "(untitled)")}`);
  sections.push(`Priority: ${safe(ctx.task.priority as string | null | undefined, "unspecified")}`);
  sections.push(`Assignee: ${safe(ctx.task.assignee as string | null | undefined, "unassigned")}`);
  const agentPrompt = ctx.agentPrompt !== undefined ? ctx.agentPrompt : ctx.task.agentPrompt;
  sections.push("");
  sections.push("## Agent Prompt");
  sections.push(safe(agentPrompt as string | null | undefined, "(none provided)"));
  sections.push("");
  sections.push("## Meta");
  sections.push(formatMeta(ctx.task.meta));
  sections.push("");
  sections.push("## Comments");
  if (ctx.comments.length === 0) {
    sections.push("(none)");
  } else {
    for (const c of ctx.comments) {
      const author = safe(c.author as string | null | undefined, "anonymous");
      const body = safe(c.content, "");
      sections.push(`- ${author}: ${body}`);
    }
  }
  sections.push("");
  sections.push("## Subtasks");
  if (ctx.subtasks.length === 0) {
    sections.push("(none)");
  } else {
    for (const s of ctx.subtasks) {
      const mark = s.completed ? "x" : " ";
      sections.push(`- [${mark}] ${safe(s.title, "(untitled)")}`);
    }
  }
  // Task content is intentionally the final section (s-1165). The
  // agent's last-read block is the description itself, so a model
  // that summarises / quotes only the closing section still
  // receives the actionable instruction.
  sections.push("");
  sections.push("## Task Content");
  if (
    typeof ctx.task.description === "string" &&
    ctx.task.description.length > 0
  ) {
    sections.push(ctx.task.description);
  } else {
    sections.push("(no content)");
  }
  sections.push("");
  return sections.join("\n");
}

/**
 * Normalise a raw task record into a `TaskRecord` the renderer can use.
 * Defensive against the API occasionally returning `meta` as a string
 * (the server already JSON-parses it; we still tolerate the raw form).
 */
export function normaliseTask(raw: unknown): TaskRecord {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const meta = r.meta;
  return {
    id: typeof r.id === "string" ? r.id : undefined,
    title: typeof r.title === "string" ? r.title : undefined,
    description: typeof r.description === "string" ? r.description : null,
    priority: (r.priority as TaskRecord["priority"]) ?? undefined,
    assignee: (r.assignee as TaskRecord["assignee"]) ?? undefined,
    meta,
    columnId: typeof r.columnId === "string" ? r.columnId : undefined,
    position: typeof r.position === "number" ? r.position : undefined,
    agentId: (r.agentId as TaskRecord["agentId"]) ?? undefined,
    agentPrompt: (r.agentPrompt as TaskRecord["agentPrompt"]) ?? undefined,
  };
}

/**
 * Hydrate a `PromptContext` by issuing two extra `GET`s against the
 * `/api/v1/comments` and `/api/v1/subtasks` endpoints and combining the
 * results with the freshly-claimed task. The loop calls this between
 * `claim` and `spawnAgent` so the renderer can include the full thread.
 *
 * Either fetch failing is non-fatal: the loop continues with an empty
 * array. This matches the plan's "best effort" tone (the agent prompt
 * is useful without comments, and we'd rather start the task than
 * drop it because the comments endpoint hiccupped).
 */
export interface TaskHydrator {
  fetchComments(taskId: string): Promise<CommentContext[]>;
  fetchSubtasks(taskId: string): Promise<SubtaskContext[]>;
  fetchBoard(boardId: string): Promise<BoardContext>;
  fetchColumn(columnId: string): Promise<ColumnContext>;
  fetchTask(taskId: string): Promise<TaskRecord>;
}

export interface HydrateOptions {
  boardId?: string;
  columnId?: string;
  /** When `true`, a missing board/column fetch throws instead of falling back. */
  strict?: boolean;
}

export async function hydrateContext(
  hydrator: TaskHydrator,
  task: TaskRecord,
  opts: HydrateOptions = {}
): Promise<PromptContext> {
  const taskId = task.id ?? "";
  const [comments, subtasks, fetchedTask] = await Promise.all([
    safeFetch(() => hydrator.fetchComments(taskId), [] as CommentContext[]),
    safeFetch(() => hydrator.fetchSubtasks(taskId), [] as SubtaskContext[]),
    safeFetch(() => hydrator.fetchTask(taskId), task),
  ]);
  const boardId = opts.boardId ?? task.columnId ?? "";
  const columnId = opts.columnId ?? task.columnId ?? "";
  const board = opts.strict
    ? await hydrator.fetchBoard(boardId)
    : await safeFetch(() => hydrator.fetchBoard(boardId), {
        id: boardId,
        name: boardId,
        description: null,
      } as BoardContext);
  const column = opts.strict
    ? await hydrator.fetchColumn(columnId)
    : await safeFetch(() => hydrator.fetchColumn(columnId), {
        id: columnId,
        name: columnId,
        status: null,
        description: null,
      } as ColumnContext);
  return {
    board,
    column,
    task: fetchedTask ?? task,
    comments,
    subtasks,
  };
}

async function safeFetch<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}
