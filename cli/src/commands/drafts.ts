// `kanban drafts list / publish / unpublish` commands.
//
// `drafts list [--board <id>]` calls GET /api/v1/drafts (optional
// `?boardId=` filter) and renders the response the same way the kanban
// MCP `list_drafts` tool does. The endpoint lives behind RequireAuth in
// backend/cmd/server/main.go, so the command needs an OAuth session.
//
// `drafts publish <id>` PUTs `{ published: true }` to /api/v1/tasks/:id
// (mirroring the `publish_task` MCP tool) and prints the updated record.
// `drafts unpublish <id>` is the inverse — it PUTs `{ published: false }`
// so a draft that has already been published can be reverted back into
// the drafts queue.
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
import { formatStructured } from "../output/format.js";

export type OutputFormat = "table" | "json" | "yaml";

export interface DraftsReport {
  apiUrl: string;
  boardId?: string;
  drafts: TaskRecord[];
}

export interface PublishResult {
  apiUrl: string;
  id: string;
  published: boolean;
  task: TaskRecord;
}

export interface RunDraftsListOptions {
  apiUrl: string;
  boardId?: string;
  format?: OutputFormat;
  io?: {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  };
  http: HttpClient;
}

export interface RunDraftsPublishOptions {
  apiUrl: string;
  format?: OutputFormat;
  io?: {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  };
  http: HttpClient;
}

// runDraftsList fetches GET /api/v1/drafts, optionally narrowed by
// --board, and prints the result as a table (id / title / priority /
// assignee / createdAt) or raw JSON. An empty list is rendered with the
// same "(no drafts)" hint used by the other list commands.
export async function runDraftsList(
  opts: RunDraftsListOptions
): Promise<DraftsReport> {
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
      "/api/v1/drafts",
      Object.keys(query).length > 0 ? { query } : {}
    );
  } catch (err) {
    throw await mapAuthError(err, stderr);
  }
  const drafts = Array.isArray(raw) ? raw : [];
  const report: DraftsReport = {
    apiUrl,
    boardId: query.boardId,
    drafts,
  };
  const structured = formatStructured(report, format);
  if (structured) {
    stdout.write(structured);
  } else {
    stdout.write(formatDraftsTable(report) + "\n");
  }
  return report;
}

// applyPublishToggle is the shared body of publish / unpublish —
// callers flip the `published` flag to pick the direction.
async function applyPublishToggle(
  opts: RunDraftsPublishOptions,
  id: string,
  published: boolean
): Promise<PublishResult> {
  const stdout = opts.io?.stdout ?? process.stdout;
  const stderr = opts.io?.stderr ?? process.stderr;
  const apiUrl = stripTrailingSlash(opts.apiUrl);
  const format: OutputFormat = opts.format ?? "table";

  if (!id || !id.trim()) {
    throw new InvalidUsageError("kanban drafts publish requires a task id");
  }

  let task: TaskRecord;
  try {
    task = await opts.http.apiPut<TaskRecord>(
      `/api/v1/tasks/${encodeURIComponent(id)}`,
      { published }
    );
  } catch (err) {
    if (err instanceof NotFoundError) {
      stderr.write(chalk.red(`task not found: ${id}\n`));
    }
    throw await mapAuthError(err, stderr);
  }
  const result: PublishResult = {
    apiUrl,
    id,
    published,
    task,
  };
  const structured = formatStructured(result, format);
  if (structured) {
    stdout.write(structured);
  } else {
    stdout.write(
      `${chalk.green(published ? "Published" : "Unpublished")} task ${id}\n`
    );
  }
  return result;
}

// runDraftsPublish sets { published: true } on /api/v1/tasks/:id and
// returns the resulting record. The wrapper exists so the CLI bootstrap
// can dispatch to the right toggle without leaking the boolean through
// the public surface.
export async function runDraftsPublish(
  opts: RunDraftsPublishOptions,
  id: string
): Promise<PublishResult> {
  return applyPublishToggle(opts, id, true);
}

// runDraftsUnpublish is the inverse of runDraftsPublish.
export async function runDraftsUnpublish(
  opts: RunDraftsPublishOptions,
  id: string
): Promise<PublishResult> {
  return applyPublishToggle(opts, id, false);
}

function formatDraftsTable(r: DraftsReport): string {
  const lines: string[] = [];
  const subtitle = r.boardId ? `board=${r.boardId}` : "";
  lines.push(
    `${chalk.bold("Drafts")}  ${chalk.cyan(r.apiUrl)}${
      subtitle ? `  ${chalk.gray(subtitle)}` : ""
    }`
  );
  if (r.drafts.length === 0) {
    lines.push(chalk.gray("  (no drafts)"));
    return lines.join("\n");
  }
  const headers = ["id", "title", "priority", "assignee", "createdAt"];
  const table = new Table({
    head: headers.map((f) => chalk.bold(f)),
    style: { head: [], border: [] },
  });
  for (const t of r.drafts) {
    table.push([
      t.id ?? "",
      t.title ?? "(untitled)",
      t.priority ?? "",
      t.assignee ?? "",
      t.createdAt ?? "",
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