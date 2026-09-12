// `kanban archived list / archive / restore` commands.
//
// `archived list [--board <id>]` calls GET /api/v1/archived (optional
// `?boardId=` filter) and renders the response the same way the kanban
// MCP `list_archived_tasks` tool does. The endpoint lives behind
// RequireAuth in backend/cmd/server/main.go, so the command needs an
// OAuth session.
//
// `archived archive <id>` POSTs `{ archived: true }` to
// /api/v1/tasks/:id/archive (mirroring the `archive_task` MCP tool) and
// prints the updated record. `archived restore <id>` is the inverse —
// it POSTs `{ archived: false }` so an archived task can be brought
// back into the active board.
//
// All commands honour --output json|table. Auth errors surface as
// NotLoggedInError so the CLI bootstrap can map them to the documented
// exit code 2.

import chalk from "chalk";
import Table from "cli-table3";
import { HttpClient, AuthError, NotFoundError } from "../http/client.js";
import { InvalidUsageError } from "./boards.js";
import { NotLoggedInError } from "./dashboard.js";
import { TaskRecord } from "./tasks.js";

export type OutputFormat = "table" | "json";

export interface ArchivedReport {
  apiUrl: string;
  boardId?: string;
  tasks: TaskRecord[];
}

export interface ArchiveResult {
  apiUrl: string;
  id: string;
  archived: boolean;
  task: TaskRecord;
}

export interface RunArchivedListOptions {
  apiUrl: string;
  boardId?: string;
  format?: OutputFormat;
  io?: {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  };
  http: HttpClient;
}

export interface RunArchivedWriteOptions {
  apiUrl: string;
  yes?: boolean;
  format?: OutputFormat;
  io?: {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  };
  http: HttpClient;
}

// runArchivedList fetches GET /api/v1/archived, optionally narrowed by
// --board, and prints the result as a table (id / title / archivedAt /
// priority / assignee) or raw JSON. An empty list is rendered with the
// same "(no archived tasks)" hint used by the other list commands.
export async function runArchivedList(
  opts: RunArchivedListOptions
): Promise<ArchivedReport> {
  const stdout = opts.io?.stdout ?? process.stdout;
  const stderr = opts.io?.stderr ?? process.stderr;
  const apiUrl = stripTrailingSlash(opts.apiUrl);
  const format: OutputFormat = opts.format ?? "table";

  const query: Record<string, string | undefined> = {};
  if (opts.boardId && opts.boardId.trim()) {
    query.boardId = opts.boardId.trim();
  }

  let raw: TaskRecord[];
  try {
    raw = await opts.http.apiGet<TaskRecord[]>(
      "/api/v1/archived",
      Object.keys(query).length > 0 ? { query } : {}
    );
  } catch (err) {
    throw await mapAuthError(err, stderr);
  }
  const tasks = Array.isArray(raw) ? raw : [];
  const report: ArchivedReport = {
    apiUrl,
    boardId: query.boardId,
    tasks,
  };
  if (format === "json") {
    stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    stdout.write(formatArchivedTable(report) + "\n");
  }
  return report;
}

// applyArchiveToggle is the shared body of archive / restore — callers
// flip the `archived` flag to pick the direction. The --yes flag is
// accepted so callers can wire `kanban archived archive <id> --yes`
// into scripts; it defaults to true because the task description
// states "默认有 --yes 跳过确认".
async function applyArchiveToggle(
  opts: RunArchivedWriteOptions,
  id: string,
  archived: boolean
): Promise<ArchiveResult> {
  const stdout = opts.io?.stdout ?? process.stdout;
  const stderr = opts.io?.stderr ?? process.stderr;
  const apiUrl = stripTrailingSlash(opts.apiUrl);
  const format: OutputFormat = opts.format ?? "table";

  if (!id || !id.trim()) {
    throw new InvalidUsageError("kanban archived archive requires a task id");
  }

  let task: TaskRecord;
  try {
    task = await opts.http.apiPost<TaskRecord>(
      `/api/v1/tasks/${encodeURIComponent(id)}/archive`,
      { archived }
    );
  } catch (err) {
    if (err instanceof NotFoundError) {
      stderr.write(chalk.red(`task not found: ${id}\n`));
    }
    throw await mapAuthError(err, stderr);
  }
  const result: ArchiveResult = {
    apiUrl,
    id,
    archived,
    task,
  };
  if (format === "json") {
    stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    stdout.write(
      `${chalk.green(archived ? "Archived" : "Restored")} task ${id}\n`
    );
  }
  return result;
}

// runArchivedArchive POSTs { archived: true } to /api/v1/tasks/:id/archive
// and returns the resulting record.
export async function runArchivedArchive(
  opts: RunArchivedWriteOptions,
  id: string
): Promise<ArchiveResult> {
  return applyArchiveToggle(opts, id, true);
}

// runArchivedRestore is the inverse of runArchivedArchive.
export async function runArchivedRestore(
  opts: RunArchivedWriteOptions,
  id: string
): Promise<ArchiveResult> {
  return applyArchiveToggle(opts, id, false);
}

function formatArchivedTable(r: ArchivedReport): string {
  const lines: string[] = [];
  const subtitle = r.boardId ? `board=${r.boardId}` : "";
  lines.push(
    `${chalk.bold("Archived")}  ${chalk.cyan(r.apiUrl)}${
      subtitle ? `  ${chalk.gray(subtitle)}` : ""
    }`
  );
  if (r.tasks.length === 0) {
    lines.push(chalk.gray("  (no archived tasks)"));
    return lines.join("\n");
  }
  const headers = ["id", "title", "archivedAt", "priority", "assignee"];
  const table = new Table({
    head: headers.map((f) => chalk.bold(f)),
    style: { head: [], border: [] },
  });
  for (const t of r.tasks) {
    table.push([
      t.id ?? "",
      t.title ?? "(untitled)",
      t.archivedAt ?? "",
      t.priority ?? "",
      t.assignee ?? "",
    ]);
  }
  lines.push(table.toString());
  return lines.join("\n");
}

async function mapAuthError(
  err: unknown,
  stderr?: NodeJS.WritableStream
): Promise<never> {
  if (err instanceof AuthError) {
    stderr?.write(
      chalk.red("Not logged in. Run 'kanban auth login' first.\n")
    );
    throw new NotLoggedInError(err.message);
  }
  throw err as Error;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}