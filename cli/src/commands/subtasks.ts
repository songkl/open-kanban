// `kanban subtasks list / create / update / delete` commands.
//
// `subtasks list <taskId>` GETs /api/v1/subtasks?taskId=<id> and renders
// the response as a table (id / title / completed / taskId / createdAt)
// or raw JSON. The endpoint lives behind RequireAuth in
// backend/cmd/server/main.go so the command needs an OAuth session.
//
// `subtasks create <taskId> --title <t>` POSTs { taskId, title } to
// /api/v1/subtasks and prints the created record. The backend creates
// the subtask with completed=false and broadcasts the change so any
// open WebSocket clients refresh their task panels.
//
// `subtasks update <id> [--title <t>] [--completed|--no-completed]`
// PUTs `{ title?, completed? }` to /api/v1/subtasks/:id. The
// --completed / --no-completed pair is implemented via Commander's
// negatable boolean option; the runner only sends the keys that were
// actually supplied so callers can patch title only or completed only.
//
// `subtasks delete <id>` DELETEs /api/v1/subtasks/:id. The CLI follows
// the archived convention where --yes is the default so the call is
// safe to embed in scripts; an explicit --no flag was deliberately
// omitted because every other destructive command accepts --yes to
// opt in.
//
// All commands honour --output json|table. Auth errors surface as
// NotLoggedInError so the CLI bootstrap can map them to the documented
// exit code 2.

import chalk from "chalk";
import Table from "cli-table3";
import { HttpClient, AuthError, NotFoundError } from "../http/client.js";
import { InvalidUsageError } from "./boards.js";
import { NotLoggedInError } from "./dashboard.js";
import { formatStructured } from "../output/format.js";

export type OutputFormat = "table" | "json" | "yaml";

export interface SubtaskRecord {
  id?: string;
  title?: string;
  completed?: boolean;
  taskId?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface SubtasksReport {
  apiUrl: string;
  taskId: string;
  subtasks: SubtaskRecord[];
}

export interface SubtaskResult {
  apiUrl: string;
  subtask: SubtaskRecord;
}

export interface SubtaskDeleteResult {
  apiUrl: string;
  id: string;
  success: boolean;
}

export interface RunSubtasksListOptions {
  apiUrl: string;
  format?: OutputFormat;
  io?: {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  };
  http: HttpClient;
}

export interface RunSubtasksCreateOptions {
  apiUrl: string;
  title: string;
  format?: OutputFormat;
  io?: {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  };
  http: HttpClient;
}

export interface RunSubtasksUpdateOptions {
  apiUrl: string;
  title?: string;
  completed?: boolean;
  format?: OutputFormat;
  io?: {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  };
  http: HttpClient;
}

export interface RunSubtasksDeleteOptions {
  apiUrl: string;
  yes?: boolean;
  format?: OutputFormat;
  io?: {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  };
  http: HttpClient;
}

// runSubtasksList GETs /api/v1/subtasks?taskId=<id> and renders the
// response as a table (id / title / completed / taskId / createdAt) or
// raw JSON. An empty list is rendered with the same "(no subtasks)"
// hint used by the other list commands.
export async function runSubtasksList(
  opts: RunSubtasksListOptions,
  taskId: string
): Promise<SubtasksReport> {
  const stdout = opts.io?.stdout ?? process.stdout;
  const stderr = opts.io?.stderr ?? process.stderr;
  const apiUrl = stripTrailingSlash(opts.apiUrl);
  const format: OutputFormat = opts.format ?? "table";

  const trimmedId = (taskId ?? "").trim();
  if (!trimmedId) {
    throw new InvalidUsageError("kanban subtasks list requires a task id");
  }

  let raw: SubtaskRecord[];
  try {
    raw = await opts.http.apiGet<SubtaskRecord[]>(
      "/api/v1/subtasks",
      { query: { taskId: trimmedId } }
    );
  } catch (err) {
    if (err instanceof NotFoundError) {
      stderr.write(chalk.red(`task not found: ${trimmedId}\n`));
    } else if (err instanceof AuthError) {
      // AuthError is re-mapped by mapAuthError below; the early branch
      // here just keeps the human-readable hint consistent.
      stderr.write(
        chalk.red("Not logged in. Run 'kanban auth login' first.\n")
      );
    }
    throw await mapAuthError(err, stderr);
  }
  const subtasks = Array.isArray(raw) ? raw : [];
  const report: SubtasksReport = {
    apiUrl,
    taskId: trimmedId,
    subtasks,
  };
  const structured = formatStructured(report, format);
  if (structured) {
    stdout.write(structured);
  } else {
    stdout.write(formatSubtasksTable(report) + "\n");
  }
  return report;
}

// runSubtasksCreate POSTs { taskId, title } to /api/v1/subtasks and
// prints the resulting record. An empty / whitespace-only title is
// rejected with InvalidUsageError so callers don't silently create
// blank subtasks.
export async function runSubtasksCreate(
  opts: RunSubtasksCreateOptions,
  taskId: string
): Promise<SubtaskResult> {
  const stdout = opts.io?.stdout ?? process.stdout;
  const stderr = opts.io?.stderr ?? process.stderr;
  const apiUrl = stripTrailingSlash(opts.apiUrl);
  const format: OutputFormat = opts.format ?? "table";

  const trimmedId = (taskId ?? "").trim();
  if (!trimmedId) {
    throw new InvalidUsageError("kanban subtasks create requires a task id");
  }
  const trimmedTitle = (opts.title ?? "").trim();
  if (!trimmedTitle) {
    throw new InvalidUsageError(
      "kanban subtasks create requires a non-empty --title"
    );
  }

  let subtask: SubtaskRecord;
  try {
    subtask = await opts.http.apiPost<SubtaskRecord>("/api/v1/subtasks", {
      taskId: trimmedId,
      title: trimmedTitle,
    });
  } catch (err) {
    if (err instanceof NotFoundError) {
      stderr.write(chalk.red(`task not found: ${trimmedId}\n`));
    }
    throw await mapAuthError(err, stderr);
  }
  const result: SubtaskResult = { apiUrl, subtask };
  const structured = formatStructured(result, format);
  if (structured) {
    stdout.write(structured);
  } else {
    stdout.write(
      `${chalk.green("Created subtask")} ${subtask.id ?? ""} on task ${trimmedId}\n`
    );
  }
  return result;
}

// runSubtasksUpdate PUTs { title?, completed? } to /api/v1/subtasks/:id
// and prints the updated record. The backend treats null/omitted
// fields as "leave unchanged", so the CLI only forwards the keys the
// caller actually supplied. At least one field must be present.
export async function runSubtasksUpdate(
  opts: RunSubtasksUpdateOptions,
  id: string
): Promise<SubtaskResult> {
  const stdout = opts.io?.stdout ?? process.stdout;
  const stderr = opts.io?.stderr ?? process.stderr;
  const apiUrl = stripTrailingSlash(opts.apiUrl);
  const format: OutputFormat = opts.format ?? "table";

  const trimmedId = (id ?? "").trim();
  if (!trimmedId) {
    throw new InvalidUsageError("kanban subtasks update requires a subtask id");
  }

  const payload: { title?: string; completed?: boolean } = {};
  if (opts.title !== undefined) {
    const t = opts.title.trim();
    if (!t) {
      throw new InvalidUsageError(
        "kanban subtasks update --title must not be empty or whitespace"
      );
    }
    payload.title = t;
  }
  if (opts.completed !== undefined) {
    payload.completed = opts.completed;
  }
  if (Object.keys(payload).length === 0) {
    throw new InvalidUsageError(
      "kanban subtasks update requires at least one of --title or --completed/--no-completed"
    );
  }

  let subtask: SubtaskRecord;
  try {
    subtask = await opts.http.apiPut<SubtaskRecord>(
      `/api/v1/subtasks/${encodeURIComponent(trimmedId)}`,
      payload
    );
  } catch (err) {
    if (err instanceof NotFoundError) {
      stderr.write(chalk.red(`subtask not found: ${trimmedId}\n`));
    }
    throw await mapAuthError(err, stderr);
  }
  const result: SubtaskResult = { apiUrl, subtask };
  const structured = formatStructured(result, format);
  if (structured) {
    stdout.write(structured);
  } else {
    stdout.write(
      `${chalk.green("Updated subtask")} ${subtask.id ?? trimmedId}\n`
    );
  }
  return result;
}

// runSubtasksDelete DELETEs /api/v1/subtasks/:id and prints a short
// confirmation. The --yes flag is accepted for parity with archived /
// batch delete but defaults to true so the call is safe in scripts.
export async function runSubtasksDelete(
  opts: RunSubtasksDeleteOptions,
  id: string
): Promise<SubtaskDeleteResult> {
  const stdout = opts.io?.stdout ?? process.stdout;
  const stderr = opts.io?.stderr ?? process.stderr;
  const apiUrl = stripTrailingSlash(opts.apiUrl);
  const format: OutputFormat = opts.format ?? "table";

  const trimmedId = (id ?? "").trim();
  if (!trimmedId) {
    throw new InvalidUsageError("kanban subtasks delete requires a subtask id");
  }

  try {
    await opts.http.apiDelete(
      `/api/v1/subtasks/${encodeURIComponent(trimmedId)}`
    );
  } catch (err) {
    if (err instanceof NotFoundError) {
      stderr.write(chalk.red(`subtask not found: ${trimmedId}\n`));
    }
    throw await mapAuthError(err, stderr);
  }
  const result: SubtaskDeleteResult = {
    apiUrl,
    id: trimmedId,
    success: true,
  };
  const structured = formatStructured(result, format);
  if (structured) {
    stdout.write(structured);
  } else {
    stdout.write(`${chalk.green("Deleted subtask")} ${trimmedId}\n`);
  }
  return result;
}

function formatSubtasksTable(r: SubtasksReport): string {
  const lines: string[] = [];
  lines.push(
    `${chalk.bold("Subtasks")}  ${chalk.cyan(r.apiUrl)}  ${chalk.gray(
      `task=${r.taskId}`
    )}`
  );
  if (r.subtasks.length === 0) {
    lines.push(chalk.gray("  (no subtasks)"));
    return lines.join("\n");
  }
  const headers = ["id", "title", "completed", "taskId", "createdAt"];
  const table = new Table({
    head: headers.map((f) => chalk.bold(f)),
    style: { head: [], border: [] },
    wordWrap: true,
    colWidths: [12, 32, 10, 12, 22],
  });
  for (const s of r.subtasks) {
    table.push([
      s.id ?? "",
      s.title ?? "",
      s.completed ? chalk.green("✓") : chalk.gray("·"),
      s.taskId ?? "",
      s.createdAt ?? "",
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
