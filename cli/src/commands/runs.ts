// `kanban runs list` command.
//
// `runs list [--runner-id <id>] [--since <duration>] [--status <status>]` calls
// the backend `GET /api/v1/runs/history` endpoint and renders the terminal
// task_runs rows (status ∈ completed, failed, released). Live rows (claimed /
// running) are intentionally not surfaced here — those are the live locks the
// runner holds, which the CLI exposes through `kanban run`, not through the
// history listing.
//
// Flag surface:
//
//   --runner-id <id>   filter by exact runner identifier
//   --since <duration> lower bound on finished_at. Accepts a relative
//                      duration like `1d`, `2h`, `30m`, `1w`, `45s` (units:
//                      s, m, h, d, w), or an absolute RFC3339 / YYYY-MM-DD
//                      timestamp forwarded verbatim. Relative durations
//                      resolve to `from=<now - duration>` in UTC.
//   --status <status>  one of completed|failed|released
//   --task <id>        filter by task identifier
//   --board <id>       filter by board id
//   --limit <n>        pagination size (server default 50, capped at 200)
//   --offset <n>       pagination offset (default 0)
//
// The endpoint lives behind RequireAuth in backend/cmd/server/main.go, so
// the command needs an OAuth session. Auth errors surface as
// NotLoggedInError so the CLI bootstrap can map them to exit code 2.

import chalk from "chalk";
import Table from "cli-table3";
import { HttpClient, AuthError } from "../http/client.js";
import { InvalidUsageError } from "./boards.js";
import { NotLoggedInError } from "./dashboard.js";
import { formatStructured } from "../output/format.js";

// Re-export so callers (program.ts bootstrap, tests) can use the
// module's typed `InvalidUsageError` without having to know it
// originates in boards.ts.
export { InvalidUsageError };

export type OutputFormat = "table" | "json" | "yaml";

export type RunStatusFilter = "completed" | "failed" | "released";

export const VALID_RUN_STATUSES: readonly RunStatusFilter[] = [
  "completed",
  "failed",
  "released",
];

// TaskRun mirrors the JSON shape returned by GET /api/v1/runs/history
// (the same payload the frontend `runsApi.list` consumes — see
// frontend/src/services/api.ts). Optional fields are typed as
// `T | null | undefined` so JSON `null` and missing keys are both
// accepted; the table renderer collapses both into an empty cell.
export interface TaskRun {
  taskId?: string;
  runnerId?: string;
  agentId?: string;
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

export interface RunsReport {
  apiUrl: string;
  runnerId?: string;
  status?: RunStatusFilter;
  since?: string;
  from?: string;
  to?: string;
  taskId?: string;
  boardId?: string;
  limit?: number;
  offset?: number;
  runs: TaskRun[];
}

export interface RunRunsListOptions {
  apiUrl: string;
  runnerId?: string;
  // since accepts a relative duration (`1d`, `2h`, `30m`, `1w`, `45s`)
  // or an absolute timestamp (`2026-09-12`, RFC3339). The handler
  // resolves the relative form to an ISO `from` query param.
  since?: string;
  status?: string;
  taskId?: string;
  boardId?: string;
  limit?: number;
  offset?: number;
  format?: OutputFormat;
  io?: {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  };
  http: HttpClient;
}

export class InvalidRunStatusError extends InvalidUsageError {
  constructor(value: string) {
    super(
      `invalid --status '${value}' (allowed: ${VALID_RUN_STATUSES.join(", ")})`
    );
    this.name = "InvalidRunStatusError";
  }
}

export class InvalidSinceError extends InvalidUsageError {
  constructor(value: string) {
    super(
      `invalid --since '${value}' (expected relative duration like 1d/2h/30m or RFC3339/YYYY-MM-DD)`
    );
    this.name = "InvalidSinceError";
  }
}

const RELATIVE_DURATION_RE = /^(\d+)\s*([smhdw])$/i;

// parseSince accepts two shapes and resolves both to an ISO-8601
// lower-bound timestamp suitable for the `from` query param:
//
//   * Relative duration: `1d`, `2h`, `30m`, `1w`, `45s` (case
//     insensitive). Resolved against `now()` to UTC midnight-aligned
//     when the unit is `d`/`w`, fractional seconds otherwise.
//   * Absolute timestamp: `YYYY-MM-DD` (date-only) or full RFC3339.
//     Forwarded verbatim — the backend re-parses it through
//     parseHistoryTime.
//
// Returns the resolved timestamp as an ISO-8601 string with no
// fractional seconds (matches the wire shape the backend writes).
export function parseSince(
  raw: string,
  now: Date = new Date()
): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    throw new InvalidSinceError(raw);
  }
  const rel = trimmed.match(RELATIVE_DURATION_RE);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const ms = relativeDurationMs(n, unit);
    return new Date(now.getTime() - ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  }
  // Absolute timestamp — defer to Date parsing; we forward the
  // original input (not the re-formatted Date) so the backend sees
  // exactly what the user typed and re-validates it.
  const abs = new Date(trimmed);
  if (!Number.isNaN(abs.getTime())) {
    return trimmed;
  }
  throw new InvalidSinceError(raw);
}

function relativeDurationMs(n: number, unit: string): number {
  switch (unit) {
    case "s":
      return n * 1_000;
    case "m":
      return n * 60_000;
    case "h":
      return n * 60 * 60_000;
    case "d":
      return n * 24 * 60 * 60_000;
    case "w":
      return n * 7 * 24 * 60 * 60_000;
    default:
      throw new InvalidSinceError(`${n}${unit}`);
  }
}

function assertRunStatus(value: string): RunStatusFilter {
  const t = value.trim().toLowerCase();
  if (!(VALID_RUN_STATUSES as readonly string[]).includes(t)) {
    throw new InvalidRunStatusError(value);
  }
  return t as RunStatusFilter;
}

// runRunsList fetches GET /api/v1/runs/history with the supplied
// filters and prints the result as a table (taskId / status /
// runnerId / finishedAt / duration / error) or raw JSON/YAML. An
// empty list surfaces the same "(no runs)" hint the other list
// commands use.
export async function runRunsList(
  opts: RunRunsListOptions
): Promise<RunsReport> {
  const stdout = opts.io?.stdout ?? process.stdout;
  const stderr = opts.io?.stderr ?? process.stderr;
  const apiUrl = stripTrailingSlash(opts.apiUrl);
  const format: OutputFormat = opts.format ?? "table";

  const query: Record<string, string | number | undefined> = {};
  let sinceResolved: string | undefined;
  let statusResolved: RunStatusFilter | undefined;

  if (opts.runnerId && opts.runnerId.trim()) {
    query.runnerId = opts.runnerId.trim();
  }
  if (opts.status && opts.status.trim()) {
    statusResolved = assertRunStatus(opts.status);
    query.status = statusResolved;
  }
  if (opts.taskId && opts.taskId.trim()) {
    query.taskId = opts.taskId.trim();
  }
  if (opts.boardId && opts.boardId.trim()) {
    query.boardId = opts.boardId.trim();
  }
  if (opts.since && opts.since.trim()) {
    sinceResolved = parseSince(opts.since);
    query.from = sinceResolved;
  }
  if (typeof opts.limit === "number" && Number.isFinite(opts.limit)) {
    if (opts.limit <= 0) {
      throw new InvalidUsageError("--limit must be a positive integer");
    }
    query.limit = opts.limit;
  }
  if (typeof opts.offset === "number" && Number.isFinite(opts.offset)) {
    if (opts.offset < 0) {
      throw new InvalidUsageError("--offset must be a non-negative integer");
    }
    query.offset = opts.offset;
  }

  let raw: TaskRun[];
  try {
    raw = await opts.http.apiGet<TaskRun[]>(
      "/api/v1/runs/history",
      Object.keys(query).length > 0 ? { query } : {}
    );
  } catch (err) {
    throw await mapAuthError(err, stderr);
  }
  const runs = Array.isArray(raw) ? raw : [];

  const report: RunsReport = {
    apiUrl,
    runnerId: query.runnerId as string | undefined,
    status: statusResolved,
    since: opts.since,
    from: sinceResolved,
    taskId: query.taskId as string | undefined,
    boardId: query.boardId as string | undefined,
    limit: typeof query.limit === "number" ? query.limit : undefined,
    offset: typeof query.offset === "number" ? query.offset : undefined,
    runs,
  };
  const structured = formatStructured(report, format);
  if (structured) {
    stdout.write(structured);
  } else {
    stdout.write(formatRunsTable(report) + "\n");
  }
  return report;
}

function formatRunsTable(r: RunsReport): string {
  const lines: string[] = [];
  const subtitleBits: string[] = [];
  if (r.runnerId) subtitleBits.push(`runner=${r.runnerId}`);
  if (r.status) subtitleBits.push(`status=${r.status}`);
  if (r.from) subtitleBits.push(`from=${r.from}`);
  if (r.taskId) subtitleBits.push(`task=${r.taskId}`);
  if (r.boardId) subtitleBits.push(`board=${r.boardId}`);
  const subtitle = subtitleBits.join(" ");
  lines.push(
    `${chalk.bold("Runs")}  ${chalk.cyan(r.apiUrl)}${
      subtitle ? `  ${chalk.gray(subtitle)}` : ""
    }`
  );
  if (r.runs.length === 0) {
    lines.push(chalk.gray("  (no runs)"));
    return lines.join("\n");
  }
  const headers = [
    "taskId",
    "status",
    "runnerId",
    "finishedAt",
    "duration",
    "error",
  ];
  const table = new Table({
    head: headers.map((f) => chalk.bold(f)),
    style: { head: [], border: [] },
  });
  for (const run of r.runs) {
    table.push([
      run.taskId ?? "",
      colorStatus(run.status),
      run.runnerId ?? "",
      run.finishedAt ?? "",
      formatDuration(run),
      run.error ?? "",
    ]);
  }
  lines.push(table.toString());
  return lines.join("\n");
}

function colorStatus(status: string | undefined): string {
  if (!status) return "";
  switch (status) {
    case "completed":
      return chalk.green(status);
    case "failed":
      return chalk.red(status);
    case "released":
      return chalk.yellow(status);
    default:
      return status;
  }
}

function formatDuration(run: TaskRun): string {
  if (!run.claimedAt || !run.finishedAt) return "";
  const start = Date.parse(run.claimedAt);
  const end = Date.parse(run.finishedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return "";
  const ms = Math.max(0, end - start);
  return humanizeMs(ms);
}

function humanizeMs(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  const s = Math.round(ms / 1_000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs === 0 ? `${m}m` : `${m}m${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm === 0 ? `${h}h` : `${h}h${rm}m`;
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
