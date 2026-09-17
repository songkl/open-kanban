// `kanban mine [--lightweight]` command.
//
// Calls GET /api/v1/mcp/my-tasks and renders the tasks currently assigned
// to (or routed to) the authenticated agent. The endpoint lives behind the
// RequireAuth middleware (registered in backend/cmd/server/main.go via
// RequireSignatureVerification + RequireAuth), so the command needs an
// OAuth bearer token. The MCP tool `list_my_tasks` uses the same endpoint
// shape — { tasks, total, userAgent } — so the CLI mirrors it directly.
//
// `--lightweight` collapses the row to id/title/priority/assignee/createdAt,
// matching the dashboard's default projection. The endpoint does not
// accept a boardId query parameter, so the URL must never include one
// even when callers wire `--board <id>` for forward-compatibility; the
// command simply ignores it (and surfaces a warning) rather than
// silently forwarding to the server.

import chalk from "chalk";
import Table from "cli-table3";
import { HttpClient, AuthError } from "../http/client.js";
import { NotLoggedInError } from "./dashboard.js";
import { formatStructured } from "../output/format.js";

// Re-exported so callers (and tests) can route login-required failures to
// the documented exit code without depending on the dashboard module.
export { NotLoggedInError };

export interface MyTaskRecord {
  id?: string;
  title?: string;
  description?: string | null;
  priority?: string | null;
  assignee?: string | null;
  meta?: unknown;
  columnId?: string;
  columnName?: string;
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
  _count?: { comments?: number; subtasks?: number };
}

export interface MyTasksPayload {
  tasks?: MyTaskRecord[];
  total?: number;
  userAgent?: string;
}

export interface MineReport {
  apiUrl: string;
  userAgent?: string;
  total: number;
  lightweight: boolean;
  tasks: MyTaskRecord[];
}

export type OutputFormat = "table" | "json" | "yaml";

export const MINE_DEFAULT_FIELDS = [
  "id",
  "title",
  "columnName",
  "priority",
  "assignee",
  "createdAt",
] as const;

export const MINE_LIGHTWEIGHT_FIELDS = [
  "id",
  "title",
  "priority",
  "assignee",
  "createdAt",
] as const;

export interface RunMineOptions {
  apiUrl: string;
  boardId?: string;
  lightweight?: boolean;
  format?: OutputFormat;
  io?: {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  };
  http: HttpClient;
}

// runMine fetches the authenticated agent's task list and prints it as a
// table by default. `--lightweight` swaps the default column set to the
// id/title/priority/assignee/createdAt shape used by the rest of the CLI.
// `--board <id>` is accepted for forward-compatibility but ignored — the
// backend does not currently accept a boardId query parameter on this
// endpoint, and the payload omits boardId per row, so the URL must stay
// free of any boardId query string. AuthError is re-shaped into
// NotLoggedInError so the CLI bootstrap can surface the documented "Run
// kanban auth login first" hint.
export async function runMine(opts: RunMineOptions): Promise<MineReport> {
  const stdout = opts.io?.stdout ?? process.stdout;
  const stderr = opts.io?.stderr ?? process.stderr;
  const apiUrl = stripTrailingSlash(opts.apiUrl);
  const format: OutputFormat = opts.format ?? "table";
  const lightweight = opts.lightweight === true;

  if (opts.boardId && opts.boardId.trim()) {
    stderr.write(
      chalk.yellow(
        `warning: --board is not supported by /api/v1/mcp/my-tasks; ignoring boardId=${opts.boardId.trim()}\n`
      )
    );
  }

  let payload: MyTasksPayload;
  try {
    payload = await opts.http.apiGet<MyTasksPayload>("/api/v1/mcp/my-tasks");
  } catch (err) {
    if (err instanceof AuthError) {
      stderr.write(chalk.red("Not logged in. Run 'kanban auth login' first.\n"));
      throw new NotLoggedInError(err.message);
    }
    throw err;
  }

  const tasks = (Array.isArray(payload.tasks) ? payload.tasks : []).map((t) =>
    projectMineTask(t, lightweight)
  );

  const report: MineReport = {
    apiUrl,
    userAgent: payload.userAgent,
    total: tasks.length,
    lightweight,
    tasks,
  };

  const structured = formatStructured(report, format);
  if (structured) {
    stdout.write(structured);
  } else {
    stdout.write(formatMineTable(report) + "\n");
  }
  return report;
}

function projectMineTask(task: MyTaskRecord, lightweight: boolean): MyTaskRecord {
  const fields = lightweight ? [...MINE_LIGHTWEIGHT_FIELDS] : [...MINE_DEFAULT_FIELDS];
  const out: MyTaskRecord = {};
  for (const f of fields) {
    switch (f) {
      case "id":
        out.id = task.id;
        break;
      case "title":
        out.title = task.title;
        break;
      case "columnName":
        out.columnName = task.columnName;
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

function formatMineTable(r: MineReport): string {
  const fields = r.lightweight
    ? [...MINE_LIGHTWEIGHT_FIELDS]
    : [...MINE_DEFAULT_FIELDS];
  const lines: string[] = [];
  const subtitleParts: string[] = [];
  if (r.userAgent) subtitleParts.push(`agent=${r.userAgent}`);
  if (r.lightweight) subtitleParts.push("lightweight");
  const subtitle =
    subtitleParts.length > 0 ? `  ${chalk.gray(subtitleParts.join(" "))}` : "";
  lines.push(`${chalk.bold("My tasks")}  ${chalk.cyan(r.apiUrl)}${subtitle}`);
  if (r.tasks.length === 0) {
    lines.push(chalk.gray("  (no tasks)"));
    return lines.join("\n");
  }
  const table = new Table({
    head: fields.map((f) => chalk.bold(labelForField(f))),
    style: { head: [], border: [] },
  });
  for (const t of r.tasks) {
    table.push(fields.map((f) => renderMineField(t, f)));
  }
  lines.push(table.toString());
  return lines.join("\n");
}

function renderMineField(t: MyTaskRecord, field: string): string {
  switch (field) {
    case "id":
      return t.id ?? "";
    case "title":
      return t.title ?? "(untitled)";
    case "columnName":
      return t.columnName ?? "";
    case "priority":
      return t.priority ?? "";
    case "assignee":
      return t.assignee ?? "";
    case "createdAt":
      return t.createdAt ?? "";
    default:
      return "";
  }
}

function labelForField(f: string): string {
  switch (f) {
    case "columnName":
      return "column";
    case "createdAt":
      return "createdAt";
    case "id":
      return "id";
    case "title":
      return "title";
    case "priority":
      return "priority";
    case "assignee":
      return "assignee";
    default:
      return f;
  }
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
