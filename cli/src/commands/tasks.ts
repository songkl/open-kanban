// `kanban tasks list / get / create / update / delete / complete / move`.
//
// The list command mirrors the kanban MCP `list_tasks` tool: rather than
// hitting /api/v1/tasks (which only knows boardId / columnId / status), the
// CLI fetches the column list (with embedded tasks) once and filters
// client-side. That gives callers --priority / --assignee / --search /
// --since / --tag / --agent-type without the backend growing a new query
// shape for every column. When --board is omitted, the first column of
// any board becomes the implicit default; the create / move commands use
// the same resolution rules so a "kanban tasks move <id> --status done"
// invocation doesn't need a --column.
//
// get is a straight passthrough to GET /api/v1/tasks/:id. create / update /
// delete / complete are auth-required and call the same RequireAuth-gated
// endpoints the dashboard / whoami commands use. move is a thin wrapper
// around update that resolves --status to a columnId and rejects requests
// where neither --column nor --status is supplied.
//
// All commands honour --output json|table and reuse the InvalidUsageError /
// NotLoggedInError classes exported by the sibling commands so the CLI
// bootstrap can map them to the documented exit codes (1 / 2 / 3 / 4 / 5).

import chalk from "chalk";
import Table from "cli-table3";
import { HttpClient, AuthError, NotFoundError } from "../http/client.js";
import { InvalidUsageError } from "./boards.js";
import { NotLoggedInError } from "./dashboard.js";

export interface TaskRecord {
  id?: string;
  title?: string;
  description?: string | null;
  priority?: "low" | "medium" | "high" | string | null;
  assignee?: string | null;
  meta?: unknown;
  columnId?: string;
  position?: number;
  published?: boolean;
  archived?: boolean;
  archivedAt?: string | null;
  agentId?: string | null;
  agentPrompt?: string | null;
  createdBy?: string;
  createdByUsername?: string;
  createdAt?: string;
  updatedAt?: string;
  commentCount?: number;
  subtaskCount?: number;
}

export interface ColumnRecord {
  id?: string;
  name?: string;
  status?: string | null;
  position?: number;
  boardId?: string;
  tasks?: TaskRecord[];
}

export type TaskStatus = "todo" | "in_progress" | "review" | "done";
export type TaskPriority = "low" | "medium" | "high";
export type DateRange = "today" | "thisWeek" | "thisMonth";
export type TaskFields = "id" | "id+updated" | "default";

export interface TasksListReport {
  apiUrl: string;
  boardId?: string;
  columnId?: string;
  status?: TaskStatus;
  tasks: TaskRecord[];
}

export interface TaskReport {
  apiUrl: string;
  task: TaskRecord;
}

export interface DeleteResult {
  apiUrl: string;
  id: string;
  success: boolean;
}

export type OutputFormat = "table" | "json";

export const TASKS_LIST_DEFAULT_FIELDS = [
  "id",
  "title",
  "priority",
  "assignee",
  "createdAt",
] as const;

export const TASKS_LIST_LIGHTWEIGHT_FIELDS = [
  "id",
  "title",
  "priority",
  "assignee",
  "createdAt",
] as const;

export const TASKS_LIST_AVAILABLE_FIELDS = [
  "id",
  "title",
  "description",
  "priority",
  "assignee",
  "columnId",
  "position",
  "published",
  "archived",
  "archivedAt",
  "createdAt",
  "updatedAt",
  "commentCount",
  "subtaskCount",
] as const;

export const TASK_STATUSES: readonly TaskStatus[] = [
  "todo",
  "in_progress",
  "review",
  "done",
] as const;
export const TASK_PRIORITIES: readonly TaskPriority[] = ["low", "medium", "high"] as const;
export const DATE_RANGES: readonly DateRange[] = ["today", "thisWeek", "thisMonth"] as const;

// statusToColumnName maps a logical status to the Chinese column name the
// kanban dashboard creates columns with. Update both this map and the
// dashboard's seed list together if the canonical names change.
const STATUS_TO_COLUMN_NAME: Record<TaskStatus, string> = {
  todo: "待办",
  in_progress: "进行中",
  review: "待审核",
  done: "已完成",
};

export interface RunTasksListOptions {
  apiUrl: string;
  boardId?: string;
  columnId?: string;
  status?: TaskStatus;
  agentType?: string;
  priority?: TaskPriority;
  assignee?: string;
  search?: string;
  since?: DateRange;
  tag?: string;
  lightweight?: boolean;
  fields?: TaskFields;
  format?: OutputFormat;
  io?: {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  };
  http: HttpClient;
}

export interface RunTaskGetOptions {
  apiUrl: string;
  format?: OutputFormat;
  io?: {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  };
  http: HttpClient;
}

export interface RunTaskCreateOptions {
  apiUrl: string;
  title: string;
  description?: string;
  columnId?: string;
  status?: TaskStatus;
  boardId?: string;
  priority?: TaskPriority;
  assignee?: string;
  meta?: Record<string, string>;
  published?: boolean;
  format?: OutputFormat;
  io?: {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  };
  http: HttpClient;
}

export interface RunTaskUpdateOptions {
  apiUrl: string;
  title?: string;
  description?: string;
  priority?: TaskPriority;
  assignee?: string;
  meta?: Record<string, string>;
  columnId?: string;
  status?: TaskStatus;
  format?: OutputFormat;
  io?: {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  };
  http: HttpClient;
}

export interface RunTaskDeleteOptions {
  apiUrl: string;
  yes?: boolean;
  format?: OutputFormat;
  io?: {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  };
  http: HttpClient;
}

export interface RunTaskCompleteOptions {
  apiUrl: string;
  format?: OutputFormat;
  io?: {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  };
  http: HttpClient;
}

export interface RunTaskMoveOptions {
  apiUrl: string;
  status?: TaskStatus;
  columnId?: string;
  format?: OutputFormat;
  io?: {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  };
  http: HttpClient;
}

// fetchColumns pulls the column list (with embedded tasks) used by list /
// create / update / move. When a boardId is provided the backend narrows
// the result via the columns?boardId= filter; without a boardId all columns
// are returned and the caller can decide what "default" means.
async function fetchColumns(
  http: HttpClient,
  boardId?: string
): Promise<ColumnRecord[]> {
  const query: Record<string, string | undefined> = {};
  if (boardId && boardId.trim()) query.boardId = boardId.trim();
  const raw = await http.apiGet<ColumnRecord[]>(
    "/api/v1/columns",
    Object.keys(query).length > 0 ? { query } : {}
  );
  return Array.isArray(raw) ? raw : [];
}

// runTasksList pulls the column list once and applies all filters
// client-side. --lightweight and --fields id / --fields id+updated control
// the per-task projection; --output json|table toggles the rendered shape.
export async function runTasksList(
  opts: RunTasksListOptions
): Promise<TasksListReport> {
  const stdout = opts.io?.stdout ?? process.stdout;
  const apiUrl = stripTrailingSlash(opts.apiUrl);
  const format: OutputFormat = opts.format ?? "table";
  if (opts.status && !TASK_STATUSES.includes(opts.status)) {
    throw new InvalidUsageError(
      `invalid --status value: ${opts.status} (allowed: ${TASK_STATUSES.join(", ")})`
    );
  }
  if (opts.priority && !TASK_PRIORITIES.includes(opts.priority)) {
    throw new InvalidUsageError(
      `invalid --priority value: ${opts.priority} (allowed: ${TASK_PRIORITIES.join(", ")})`
    );
  }
  if (opts.since && !DATE_RANGES.includes(opts.since)) {
    throw new InvalidUsageError(
      `invalid --since value: ${opts.since} (allowed: ${DATE_RANGES.join(", ")})`
    );
  }
  if (opts.columnId && opts.status) {
    throw new InvalidUsageError(
      "kanban tasks list accepts only one of --column or --status, not both"
    );
  }

  let columns: ColumnRecord[];
  try {
    columns = await fetchColumns(opts.http, opts.boardId);
  } catch (err) {
    throw await mapAuthError(err, opts.io?.stderr);
  }

  const scopedColumns = opts.boardId
    ? columns.filter((c) => c.boardId === opts.boardId)
    : columns;

  // Start from all columns' tasks so that --status / --column lookups
  // can still resolve across boards when the requested board does not
  // own the matching column (matches create-time fallback semantics).
  // When neither --column nor --status is supplied, restrict to the
  // --board scope (or all boards when --board is omitted).
  let tasks: TaskRecord[];
  const columnById = new Map<string, ColumnRecord>();
  for (const c of columns) if (c.id) columnById.set(c.id, c);

  if (opts.columnId) {
    tasks = columns
      .flatMap((c) => c.tasks ?? [])
      .filter((t) => t.columnId === opts.columnId);
  } else if (opts.status) {
    const target = STATUS_TO_COLUMN_NAME[opts.status];
    const matches = columns.filter((c) => c.name === target);
    const columnIds = new Set(matches.map((c) => c.id!));
    tasks = columns
      .flatMap((c) => c.tasks ?? [])
      .filter((t) => t.columnId && columnIds.has(t.columnId));
  } else {
    tasks = scopedColumns.flatMap((c) => c.tasks ?? []);
  }

  if (opts.agentType) {
    const wanted = opts.agentType.toLowerCase();
    tasks = tasks.filter((t) => {
      const col = t.columnId ? columnById.get(t.columnId) : undefined;
      const cfg = (col as unknown as { agentConfig?: { agentTypes?: string[] } } | undefined)?.agentConfig;
      const types = cfg?.agentTypes ?? [];
      return types.some((x) => String(x).toLowerCase() === wanted);
    });
  }

  if (opts.priority) {
    tasks = tasks.filter((t) => t.priority === opts.priority);
  }
  if (opts.assignee) {
    tasks = tasks.filter((t) => t.assignee === opts.assignee);
  }
  if (opts.search) {
    const q = opts.search.toLowerCase();
    tasks = tasks.filter(
      (t) =>
        (t.title?.toLowerCase().includes(q) ?? false) ||
        (typeof t.description === "string" && t.description.toLowerCase().includes(q))
    );
  }
  if (opts.since) {
    const cutoff = dateCutoff(opts.since);
    tasks = tasks.filter((t) => (t.createdAt ? new Date(t.createdAt) >= cutoff : false));
  }
  if (opts.tag) {
    const tag = opts.tag.toLowerCase();
    tasks = tasks.filter((t) => {
      if (!t.meta) return false;
      let parsed: unknown;
      if (typeof t.meta === "string") {
        try {
          parsed = JSON.parse(t.meta);
        } catch {
          return false;
        }
      } else {
        parsed = t.meta;
      }
      if (!parsed || typeof parsed !== "object") return false;
      return Object.values(parsed as Record<string, unknown>).some((v) =>
        String(v).toLowerCase().includes(tag)
      );
    });
  }

  const projected = tasks.map((t) => projectTask(t, opts));
  const report: TasksListReport = {
    apiUrl,
    boardId: opts.boardId,
    columnId: opts.columnId,
    status: opts.status,
    tasks: projected,
  };

  if (format === "json") {
    stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    stdout.write(formatTasksTable(report, opts) + "\n");
  }
  return report;
}

// projectTask applies the --fields / --lightweight projection so the
// output stays consistent regardless of how the caller invoked the
// command. Defaults mirror the kanban dashboard: id / title / priority /
// assignee / createdAt.
function projectTask(task: TaskRecord, opts: RunTasksListOptions): TaskRecord {
  const fields = opts.fields ?? (opts.lightweight === false ? "default" : "default");
  if (fields === "id") {
    return { id: task.id };
  }
  if (fields === "id+updated") {
    return { id: task.id, updatedAt: task.updatedAt };
  }
  const defaultKeys = [...TASKS_LIST_LIGHTWEIGHT_FIELDS];
  const out: TaskRecord = {};
  for (const k of defaultKeys) {
    switch (k) {
      case "id":
        out.id = task.id;
        break;
      case "title":
        out.title = task.title;
        break;
      case "priority":
        out.priority = task.priority ?? null;
        break;
      case "assignee":
        out.assignee = task.assignee ?? null;
        break;
      case "createdAt":
        out.createdAt = task.createdAt;
        break;
    }
  }
  return out;
}

function formatTasksTable(r: TasksListReport, opts: RunTasksListOptions): string {
  const lines: string[] = [];
  const subtitle = describeFilter(r);
  lines.push(
    `${chalk.bold("Tasks")}  ${chalk.cyan(r.apiUrl)}${
      subtitle ? `  ${chalk.gray(subtitle)}` : ""
    }`
  );
  if (r.tasks.length === 0) {
    lines.push(chalk.gray("  (no tasks)"));
    return lines.join("\n");
  }
  const show = opts.fields ?? "default";
  const headers =
    show === "id"
      ? ["id"]
      : show === "id+updated"
        ? ["id", "updatedAt"]
        : [...TASKS_LIST_LIGHTWEIGHT_FIELDS];
  const table = new Table({
    head: headers.map((f) => chalk.bold(labelForField(f))),
    style: { head: [], border: [] },
  });
  for (const t of r.tasks) {
    table.push(headers.map((f) => renderTaskField(t, f)));
  }
  lines.push(table.toString());
  return lines.join("\n");
}

function describeFilter(r: TasksListReport): string {
  const parts: string[] = [];
  if (r.boardId) parts.push(`board=${r.boardId}`);
  if (r.columnId) parts.push(`column=${r.columnId}`);
  if (r.status) parts.push(`status=${r.status}`);
  return parts.join(" ");
}

function renderTaskField(t: TaskRecord, field: string): string {
  switch (field) {
    case "id":
      return t.id ?? "";
    case "title":
      return t.title ?? "(untitled)";
    case "description":
      return typeof t.description === "string" ? t.description : "";
    case "priority":
      return t.priority ?? "";
    case "assignee":
      return t.assignee ?? "";
    case "columnId":
      return t.columnId ?? "";
    case "position":
      return t.position === undefined ? "" : String(t.position);
    case "published":
      return t.published === undefined ? "" : t.published ? "yes" : "no";
    case "archived":
      return t.archived === undefined ? "" : t.archived ? "yes" : "no";
    case "archivedAt":
      return t.archivedAt ?? "";
    case "createdAt":
      return t.createdAt ?? "";
    case "updatedAt":
      return t.updatedAt ?? "";
    case "commentCount":
      return t.commentCount === undefined ? "" : String(t.commentCount);
    case "subtaskCount":
      return t.subtaskCount === undefined ? "" : String(t.subtaskCount);
    default:
      return "";
  }
}

function labelForField(f: string): string {
  switch (f) {
    case "commentCount":
      return "comments";
    case "subtaskCount":
      return "subtasks";
    case "createdAt":
      return "createdAt";
    case "updatedAt":
      return "updatedAt";
    case "columnId":
      return "columnId";
    case "archivedAt":
      return "archivedAt";
    default:
      return f;
  }
}

// runTaskGet fetches a single task by id. The /api/v1/tasks/:id endpoint is
// public so callers can run it without `kanban auth login`, matching the
// `boards get` behaviour.
export async function runTaskGet(
  opts: RunTaskGetOptions,
  id: string
): Promise<TaskReport> {
  if (!id || !id.trim()) {
    throw new InvalidUsageError("kanban tasks get requires a task id");
  }
  const stdout = opts.io?.stdout ?? process.stdout;
  const stderr = opts.io?.stderr ?? process.stderr;
  const apiUrl = stripTrailingSlash(opts.apiUrl);
  const format: OutputFormat = opts.format ?? "table";
  let task: TaskRecord;
  try {
    task = await opts.http.apiGet<TaskRecord>(
      `/api/v1/tasks/${encodeURIComponent(id)}`
    );
  } catch (err) {
    if (err instanceof NotFoundError) {
      stderr.write(chalk.red(`task not found: ${id}\n`));
    }
    throw err;
  }
  const report: TaskReport = { apiUrl, task };
  if (format === "json") {
    stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    stdout.write(formatTaskTable(report) + "\n");
  }
  return report;
}

function formatTaskTable(r: TaskReport): string {
  const lines: string[] = [];
  lines.push(`${chalk.bold("Task")}   ${chalk.cyan(r.apiUrl)}`);
  const t = r.task;
  const rows: [string, string][] = [
    ["id", t.id ?? ""],
    ["title", t.title ?? "(untitled)"],
    ["description", typeof t.description === "string" ? t.description : ""],
    ["priority", t.priority ?? ""],
    ["assignee", t.assignee ?? ""],
    ["columnId", t.columnId ?? ""],
    ["position", t.position === undefined ? "" : String(t.position)],
    ["published", t.published === undefined ? "" : t.published ? "yes" : "no"],
    ["archived", t.archived === undefined ? "" : t.archived ? "yes" : "no"],
    ["createdBy", t.createdByUsername ?? t.createdBy ?? ""],
    ["createdAt", t.createdAt ?? ""],
    ["updatedAt", t.updatedAt ?? ""],
    ["comments", t.commentCount === undefined ? "" : String(t.commentCount)],
    ["subtasks", t.subtaskCount === undefined ? "" : String(t.subtaskCount)],
  ];
  for (const [k, v] of rows) {
    lines.push(`  ${chalk.bold(k)}: ${v}`);
  }
  return lines.join("\n");
}

// resolveColumnForCreate finds the columnId the POST /api/v1/tasks call
// should target. The order matches the MCP behaviour:
//   1. explicit --column (highest priority)
//   2. --status mapped to a Chinese column name within --board (or any
//      board when --board is omitted)
//   3. the first column of the chosen board
//   4. any column at all (across all boards)
function resolveColumnForCreate(
  columns: ColumnRecord[],
  opts: { boardId?: string; columnId?: string; status?: TaskStatus }
): { columnId?: string; error?: InvalidUsageError } {
  if (opts.columnId) return { columnId: opts.columnId };
  const boardColumns = opts.boardId
    ? columns.filter((c) => c.boardId === opts.boardId)
    : columns;
  if (opts.status) {
    const wanted = STATUS_TO_COLUMN_NAME[opts.status];
    const match = boardColumns.find((c) => c.name === wanted);
    if (match?.id) return { columnId: match.id };
    const fallback = columns.find((c) => c.name === wanted);
    if (fallback?.id) return { columnId: fallback.id };
    throw new InvalidUsageError(
      `no column named "${wanted}" exists for status "${opts.status}"`
    );
  }
  if (boardColumns.length > 0 && boardColumns[0].id) {
    return { columnId: boardColumns[0].id };
  }
  if (columns.length > 0 && columns[0].id) {
    return { columnId: columns[0].id };
  }
  throw new InvalidUsageError(
    "no columns available; create a board with at least one column first"
  );
}

// runTaskCreate validates the input, resolves a columnId, then POSTs the
// task. The CLI defaults --priority to "medium" and --published to true
// when neither is supplied so the new task actually appears on the
// dashboard; the backend treats published=false as a draft.
export async function runTaskCreate(
  opts: RunTaskCreateOptions
): Promise<TaskReport> {
  const stderr = opts.io?.stderr ?? process.stderr;
  const stdout = opts.io?.stdout ?? process.stdout;
  const apiUrl = stripTrailingSlash(opts.apiUrl);
  const format: OutputFormat = opts.format ?? "table";

  if (!opts.title || !opts.title.trim()) {
    throw new InvalidUsageError("kanban tasks create requires --title");
  }
  if (opts.columnId && opts.status) {
    throw new InvalidUsageError(
      "kanban tasks create accepts only one of --column or --status, not both"
    );
  }
  if (opts.priority && !TASK_PRIORITIES.includes(opts.priority)) {
    throw new InvalidUsageError(
      `invalid --priority value: ${opts.priority} (allowed: ${TASK_PRIORITIES.join(", ")})`
    );
  }
  if (opts.status && !TASK_STATUSES.includes(opts.status)) {
    throw new InvalidUsageError(
      `invalid --status value: ${opts.status} (allowed: ${TASK_STATUSES.join(", ")})`
    );
  }

  let columns: ColumnRecord[];
  try {
    columns = await fetchColumns(opts.http, opts.boardId);
  } catch (err) {
    throw await mapAuthError(err, opts.io?.stderr);
  }
  const { columnId, error } = resolveColumnForCreate(columns, {
    boardId: opts.boardId,
    columnId: opts.columnId,
    status: opts.status,
  });
  if (error) throw error;
  if (!columnId) {
    throw new InvalidUsageError("could not resolve a target column");
  }

  const body: Record<string, unknown> = {
    title: opts.title.trim(),
    columnId,
    priority: opts.priority ?? "medium",
    published: opts.published ?? true,
  };
  if (opts.description !== undefined) body.description = opts.description;
  if (opts.assignee !== undefined) body.assignee = opts.assignee;
  if (opts.meta !== undefined) body.meta = opts.meta;

  let task: TaskRecord;
  try {
    task = await opts.http.apiPost<TaskRecord>("/api/v1/tasks", body);
  } catch (err) {
    throw await mapAuthError(err, stderr);
  }
  const report: TaskReport = { apiUrl, task };
  if (format === "json") {
    stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    stdout.write(formatTaskTable(report) + "\n");
  }
  return report;
}

// runTaskUpdate applies a partial update to an existing task. When
// --status is provided without --column, the current task's column is
// fetched so the status→column lookup stays scoped to its board.
export async function runTaskUpdate(
  opts: RunTaskUpdateOptions,
  id: string
): Promise<TaskReport> {
  const stderr = opts.io?.stderr ?? process.stderr;
  const stdout = opts.io?.stdout ?? process.stdout;
  const apiUrl = stripTrailingSlash(opts.apiUrl);
  const format: OutputFormat = opts.format ?? "table";

  if (!id || !id.trim()) {
    throw new InvalidUsageError("kanban tasks update requires a task id");
  }
  if (opts.columnId && opts.status) {
    throw new InvalidUsageError(
      "kanban tasks update accepts only one of --column or --status, not both"
    );
  }
  if (opts.priority && !TASK_PRIORITIES.includes(opts.priority)) {
    throw new InvalidUsageError(
      `invalid --priority value: ${opts.priority} (allowed: ${TASK_PRIORITIES.join(", ")})`
    );
  }
  if (opts.status && !TASK_STATUSES.includes(opts.status)) {
    throw new InvalidUsageError(
      `invalid --status value: ${opts.status} (allowed: ${TASK_STATUSES.join(", ")})`
    );
  }

  const body: Record<string, unknown> = {};
  if (opts.title !== undefined) body.title = opts.title;
  if (opts.description !== undefined) body.description = opts.description;
  if (opts.priority !== undefined) body.priority = opts.priority;
  if (opts.assignee !== undefined) body.assignee = opts.assignee;
  if (opts.meta !== undefined) body.meta = opts.meta;

  if (opts.columnId) {
    body.columnId = opts.columnId;
  } else if (opts.status) {
    let columns: ColumnRecord[];
    try {
      columns = await fetchColumns(opts.http);
    } catch (err) {
      throw await mapAuthError(err, stderr);
    }
    const wanted = STATUS_TO_COLUMN_NAME[opts.status];
    const match = columns.find((c) => c.name === wanted);
    if (!match?.id) {
      throw new InvalidUsageError(
        `no column named "${wanted}" exists for status "${opts.status}"`
      );
    }
    body.columnId = match.id;
  }

  if (Object.keys(body).length === 0) {
    throw new InvalidUsageError(
      "kanban tasks update requires at least one of --title / --description / --priority / --assignee / --meta / --column / --status"
    );
  }

  let task: TaskRecord;
  try {
    task = await opts.http.apiPut<TaskRecord>(
      `/api/v1/tasks/${encodeURIComponent(id)}`,
      body
    );
  } catch (err) {
    if (err instanceof NotFoundError) {
      stderr.write(chalk.red(`task not found: ${id}\n`));
    }
    throw await mapAuthError(err, stderr);
  }
  const report: TaskReport = { apiUrl, task };
  if (format === "json") {
    stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    stdout.write(formatTaskTable(report) + "\n");
  }
  return report;
}

// runTaskDelete removes a task. --yes is accepted so callers can wire
// `kanban tasks delete <id> --yes` into scripts without an interactive
// confirmation prompt; the default is to still allow the call (matching
// the dashboard's silent delete) because the task description states
// "默认有 --yes 跳过确认".
export async function runTaskDelete(
  opts: RunTaskDeleteOptions,
  id: string
): Promise<DeleteResult> {
  const stderr = opts.io?.stderr ?? process.stderr;
  const stdout = opts.io?.stdout ?? process.stdout;
  const apiUrl = stripTrailingSlash(opts.apiUrl);
  const format: OutputFormat = opts.format ?? "table";

  if (!id || !id.trim()) {
    throw new InvalidUsageError("kanban tasks delete requires a task id");
  }

  try {
    await opts.http.apiDelete(
      `/api/v1/tasks/${encodeURIComponent(id)}`
    );
  } catch (err) {
    if (err instanceof NotFoundError) {
      stderr.write(chalk.red(`task not found: ${id}\n`));
    }
    throw await mapAuthError(err, stderr);
  }
  const result: DeleteResult = { apiUrl, id, success: true };
  if (format === "json") {
    stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    stdout.write(chalk.green(`Deleted task ${id}\n`));
  }
  return result;
}

// runTaskComplete advances a task to the next column via the
// /api/v1/tasks/:id/complete endpoint and prints the resulting record.
export async function runTaskComplete(
  opts: RunTaskCompleteOptions,
  id: string
): Promise<TaskReport> {
  const stderr = opts.io?.stderr ?? process.stderr;
  const stdout = opts.io?.stdout ?? process.stdout;
  const apiUrl = stripTrailingSlash(opts.apiUrl);
  const format: OutputFormat = opts.format ?? "table";

  if (!id || !id.trim()) {
    throw new InvalidUsageError("kanban tasks complete requires a task id");
  }

  let task: TaskRecord;
  try {
    task = await opts.http.apiPost<TaskRecord>(
      `/api/v1/tasks/${encodeURIComponent(id)}/complete`,
      {}
    );
  } catch (err) {
    if (err instanceof NotFoundError) {
      stderr.write(chalk.red(`task not found: ${id}\n`));
    }
    throw await mapAuthError(err, stderr);
  }
  const report: TaskReport = { apiUrl, task };
  if (format === "json") {
    stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    stdout.write(formatTaskTable(report) + "\n");
  }
  return report;
}

// runTaskMove is a thin wrapper around runTaskUpdate that resolves
// --status to a columnId. It exists so callers can wire
// `kanban tasks move <id> --status done` without needing to know which
// column id maps to "done" in the active board.
export async function runTaskMove(
  opts: RunTaskMoveOptions,
  id: string
): Promise<TaskReport> {
  if (!id || !id.trim()) {
    throw new InvalidUsageError("kanban tasks move requires a task id");
  }
  if (!opts.columnId && !opts.status) {
    throw new InvalidUsageError(
      "kanban tasks move requires one of --column or --status"
    );
  }
  if (opts.columnId && opts.status) {
    throw new InvalidUsageError(
      "kanban tasks move accepts only one of --column or --status, not both"
    );
  }
  return runTaskUpdate(
    {
      apiUrl: opts.apiUrl,
      format: opts.format,
      io: opts.io,
      http: opts.http,
      columnId: opts.columnId,
      status: opts.status,
    },
    id
  );
}

// mapAuthError re-shapes AuthError into NotLoggedInError so the CLI
// bootstrap can apply the "Run 'kanban auth login' first" hint. Stderr is
// optional so the CLI's test capture streams get the same message the user
// would see in production.
async function mapAuthError(
  err: unknown,
  stderr?: NodeJS.WritableStream
): Promise<never> {
  if (err instanceof AuthError) {
    stderr?.write(chalk.red("Not logged in. Run 'kanban auth login' first.\n"));
    throw new NotLoggedInError(err.message);
  }
  throw err as Error;
}

// parseMetaArgs converts an array of --meta k=v tokens (with optional
// comma-separated values inside one token) into a plain object. Repeated
// keys overwrite earlier values. An empty / malformed entry is skipped.
export function parseMetaArgs(values: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!values || values.length === 0) return out;
  for (const v of values) {
    if (!v) continue;
    const parts = v.split(",");
    for (const p of parts) {
      const idx = p.indexOf("=");
      if (idx <= 0) continue;
      const key = p.slice(0, idx).trim();
      const val = p.slice(idx + 1).trim();
      if (!key) continue;
      out[key] = val;
    }
  }
  return out;
}

// dateCutoff returns the lower-bound Date for the supported --since
// presets. Matches the same definitions used by the kanban MCP tool.
function dateCutoff(range: DateRange): Date {
  const now = new Date();
  if (range === "today") {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }
  if (range === "thisWeek") {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    start.setDate(start.getDate() - start.getDay());
    return start;
  }
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  return monthStart;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
