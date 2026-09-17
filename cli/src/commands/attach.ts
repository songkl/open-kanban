// `kanban attach <taskId>` command — claim a specific task
// by id without owning the surrounding column or inbox.
//
// Where `kanban run` walks a board / column / mine-mode queue
// scanning for eligible work, `kanban attach` lets an operator
// (or an AI agent that has been handed a task id via the UI,
// MCP, or a queue) pin a specific task to the calling runner.
//
// The command is intentionally minimal: it does NOT spawn the
// runner loop. The operator's automation can call this command
// to grab the lock, then drive the heartbeat / finish cycle
// itself (or call `kanban run` with a hand-rolled config that
// points back at the same task).
//
// Wire shape:
//
//   POST /api/v1/runs/:taskId/attach
//   body: { runnerId, agentType?, lockTimeoutMs?, reason? }
//
// Returns the canonical { task, run } payload — same shape as
// the claim endpoint — so the CLI prompt-rendering path can be
// reused verbatim if the caller wants to follow up with a
// `kanban run` against the same task.

import chalk from "chalk";
import { HttpClient, ApiError } from "../http/client.js";
import { InvalidUsageError } from "./boards.js";
import { NotLoggedInError } from "./dashboard.js";
import { formatStructured } from "../output/format.js";
import {
  defaultRunnerId,
  resolveAgentType,
} from "./run.js";

// Re-export the InvalidUsageError so callers (program.ts
// bootstrap) can route the documented exit code without
// depending on the boards module. Mirrors the pattern used
// in commands/runs.ts.
export { InvalidUsageError };

export type OutputFormat = "table" | "json" | "yaml";

export interface AttachTaskRecord {
  id?: string;
  title?: string;
  priority?: string;
  columnId?: string;
  columnName?: string;
  position?: number;
  published?: boolean;
  archived?: boolean;
  archivedAt?: string | null;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
  description?: string | null;
  assignee?: string | null;
  meta?: unknown;
  _count?: { comments?: number; subtasks?: number };
}

export interface AttachRunRecord {
  taskId?: string;
  runnerId?: string;
  agentId?: string | null;
  boardId?: string;
  columnId?: string;
  status?: string;
  claimedAt?: string;
  lastHeartbeatAt?: string;
  expiresAt?: string;
  finishedAt?: string | null;
  exitCode?: number | null;
  error?: string | null;
}

export interface AttachResponsePayload {
  task?: AttachTaskRecord;
  run?: AttachRunRecord;
}

export interface RunAttachOptions {
  apiUrl: string;
  taskId: string;
  runnerId?: string;
  agentType?: string;
  lockTimeoutMs?: number;
  reason?: string;
  format?: OutputFormat;
  io?: {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  };
  http: HttpClient;
}

export interface AttachReport {
  apiUrl: string;
  taskId: string;
  runnerId: string;
  task: AttachTaskRecord;
  run: AttachRunRecord;
}

// runAttach claims a specific task by id and prints a
// confirmation table. Errors are mapped to the documented CLI
// exit-code contract: 1 for usage / validation, 2 for
// unauthenticated, the original code for protocol failures
// (HTTP 404 → CLI exit 5 etc. — surfaced through exitCodeForError
// at the caller).
export async function runAttach(opts: RunAttachOptions): Promise<AttachReport> {
  const stdout = opts.io?.stdout ?? process.stdout;
  const stderr = opts.io?.stderr ?? process.stderr;
  const apiUrl = stripTrailingSlash(opts.apiUrl);
  const format: OutputFormat = opts.format ?? "table";

  const taskId = (opts.taskId ?? "").trim();
  if (!taskId) {
    throw new InvalidUsageError("kanban attach requires a task id");
  }

  const runnerId = (opts.runnerId ?? "").trim() || defaultRunnerId();
  const agentType = (opts.agentType ?? "").trim() || resolveAgentType();

  const body: Record<string, unknown> = { runnerId, agentType };
  if (typeof opts.lockTimeoutMs === "number" && Number.isFinite(opts.lockTimeoutMs)) {
    if (opts.lockTimeoutMs <= 0) {
      throw new InvalidUsageError("--lock-timeout-ms must be a positive integer");
    }
    body.lockTimeoutMs = Math.floor(opts.lockTimeoutMs);
  }
  if (opts.reason && opts.reason.trim()) {
    body.reason = opts.reason.trim();
  }

  let payload: AttachResponsePayload;
  try {
    payload = await opts.http.apiPost<AttachResponsePayload>(
      `/api/v1/runs/${encodeURIComponent(taskId)}/attach`,
      body
    );
  } catch (err) {
    throw await mapAttachError(err, stderr);
  }

  if (!payload.task || !payload.run) {
    throw new InvalidUsageError(
      `server returned an unexpected attach response: ${JSON.stringify(payload)}`
    );
  }

  const report: AttachReport = {
    apiUrl,
    taskId,
    runnerId,
    task: payload.task,
    run: payload.run,
  };

  const structured = formatStructured(report, format);
  if (structured) {
    stdout.write(structured);
  } else {
    stdout.write(formatAttachTable(report) + "\n");
  }
  return report;
}

// formatAttachTable mirrors the layout used by `kanban runs
// list` and `kanban tasks get` — the same single-row "you
// just attached to this task" framing. The runnerId is
// surfaced so the operator can copy it into a follow-up
// heartbeat / finish curl.
function formatAttachTable(r: AttachReport): string {
  const lines: string[] = [];
  lines.push(`${chalk.bold("Attach")}  ${chalk.cyan(r.apiUrl)}`);
  lines.push(`  ${chalk.gray("taskId:")}    ${r.task.id ?? r.taskId}`);
  if (r.task.title) {
    lines.push(`  ${chalk.gray("title:")}     ${r.task.title}`);
  }
  if (r.task.columnName) {
    lines.push(`  ${chalk.gray("column:")}    ${r.task.columnName}`);
  }
  if (r.task.priority) {
    lines.push(`  ${chalk.gray("priority:")}  ${r.task.priority}`);
  }
  if (r.task.assignee) {
    lines.push(`  ${chalk.gray("assignee:")}  ${r.task.assignee}`);
  }
  lines.push(`  ${chalk.gray("runnerId:")}  ${r.run.runnerId ?? r.runnerId}`);
  lines.push(`  ${chalk.gray("status:")}    ${chalk.green(r.run.status ?? "claimed")}`);
  if (r.run.expiresAt) {
    lines.push(`  ${chalk.gray("expiresAt:")} ${r.run.expiresAt}`);
  }
  lines.push(
    `  ${chalk.gray(
      `follow up with: kanban run --task ${r.task.id ?? r.taskId}`
    )}`
  );
  return lines.join("\n");
}

async function mapAttachError(
  err: unknown,
  stderr?: NodeJS.WritableStream
): Promise<never> {
  if (err instanceof ApiError) {
    const status = err.status;
    if (status === 401 || status === 403) {
      stderr?.write(
        chalk.red("Not logged in. Run 'kanban auth login' first.\n")
      );
      throw new NotLoggedInError(err.message);
    }
    if (status === 404) {
      throw new InvalidUsageError(`task not found: ${(err.body && (err.body as { error?: string }).error) ?? err.message}`);
    }
    if (status === 409) {
      throw new InvalidUsageError(
        `task is already locked by another runner: ${(err.body && (err.body as { error?: string }).error) ?? err.message}`
      );
    }
    if (status === 422) {
      throw new InvalidUsageError(
        `cannot attach task: ${(err.body && (err.body as { error?: string }).error) ?? err.message}`
      );
    }
  }
  throw err as Error;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
