// `kanban dashboard` command.
//
// Pulls GET /api/v1/dashboard/stats and renders a tabular summary that
// matches the structure the frontend / MCP tools surface (totalTasks,
// breakdown by status / priority, archived / published / draft counts, and
// the aggregate board / column / user totals).
//
// Unlike `kanban status`, this endpoint is auth-required (RequireAuth in
// the backend route group), so the command needs an OAuth session. The
// caller is expected to wire the OAuthClient onto the HttpClient before
// invoking runDashboard — the command itself just makes the request and
// re-throws any ApiError so the bootstrap layer can map it to the
// documented exit codes.

import chalk from "chalk";
import Table from "cli-table3";
import { HttpClient, AuthError } from "../http/client.js";
import { formatStructured } from "../output/format.js";

export interface DashboardStats {
  totalTasks?: number;
  tasksByStatus?: Record<string, number>;
  tasksByPriority?: Record<string, number>;
  publishedTasks?: number;
  draftTasks?: number;
  archivedTasks?: number;
  totalBoards?: number;
  totalColumns?: number;
  totalUsers?: number;
}

export interface DashboardReport {
  apiUrl: string;
  stats: DashboardStats;
}

export type OutputFormat = "table" | "json" | "yaml";

export interface RunDashboardOptions {
  apiUrl: string;
  format?: OutputFormat;
  io?: {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  };
  http: HttpClient;
}

// runDashboard fetches /api/v1/dashboard/stats, prints a human-readable
// summary (or the raw JSON when --output json), and returns the parsed
// report so callers / tests can assert against it. Authentication errors
// are re-mapped to NotLoggedInError so the CLI bootstrap can exit with
// the documented "Run kanban auth login first" hint.
export async function runDashboard(
  opts: RunDashboardOptions
): Promise<DashboardReport> {
  const stdout = opts.io?.stdout ?? process.stdout;
  const stderr = opts.io?.stderr ?? process.stderr;
  const format: OutputFormat = opts.format ?? "table";
  const apiUrl = stripTrailingSlash(opts.apiUrl);
  const path = "/api/v1/dashboard/stats";
  let stats: DashboardStats;
  try {
    stats = await opts.http.apiGet<DashboardStats>(path);
  } catch (err) {
    if (err instanceof AuthError) {
      stderr.write(
        chalk.red("Not logged in. Run 'kanban auth login' first.\n")
      );
      throw new NotLoggedInError(err.message);
    }
    throw err;
  }
  const report: DashboardReport = { apiUrl, stats };
  const structured = formatStructured(report, format);
  if (structured) {
    stdout.write(structured);
  } else {
    stdout.write(formatDashboardTable(report) + "\n");
  }
  return report;
}

function formatDashboardTable(r: DashboardReport): string {
  const s = r.stats;
  const lines: string[] = [];
  lines.push(`${chalk.bold("Kanban dashboard")}  ${chalk.cyan(r.apiUrl)}`);
  lines.push("");

  const totals = new Table({
    head: [chalk.bold("Metric"), chalk.bold("Count")],
    style: { head: [], border: [] },
  });
  totals.push(
    ["Total tasks", String(s.totalTasks ?? sum(s.tasksByStatus))],
    ["Published", String(s.publishedTasks ?? 0)],
    ["Drafts", String(s.draftTasks ?? 0)],
    ["Archived", String(s.archivedTasks ?? 0)],
    ["Boards", String(s.totalBoards ?? 0)],
    ["Columns", String(s.totalColumns ?? 0)],
    ["Users", String(s.totalUsers ?? 0)]
  );
  lines.push(totals.toString());

  if (s.tasksByStatus && Object.keys(s.tasksByStatus).length > 0) {
    lines.push("", chalk.bold("Tasks by status"));
    const statusTable = new Table({
      head: [chalk.bold("Status"), chalk.bold("Count")],
      style: { head: [], border: [] },
    });
    const ordered = orderStatus(Object.keys(s.tasksByStatus));
    for (const k of ordered) {
      statusTable.push([k, String(s.tasksByStatus[k] ?? 0)]);
    }
    lines.push(statusTable.toString());
  }

  if (s.tasksByPriority && Object.keys(s.tasksByPriority).length > 0) {
    lines.push("", chalk.bold("Tasks by priority"));
    const prioTable = new Table({
      head: [chalk.bold("Priority"), chalk.bold("Count")],
      style: { head: [], border: [] },
    });
    const ordered = orderPriority(Object.keys(s.tasksByPriority));
    for (const k of ordered) {
      prioTable.push([k, String(s.tasksByPriority[k] ?? 0)]);
    }
    lines.push(prioTable.toString());
  }

  return lines.join("\n");
}

function orderStatus(keys: string[]): string[] {
  const order = ["todo", "in_progress", "review", "done"];
  const known = order.filter((k) => keys.includes(k));
  const extras = keys.filter((k) => !order.includes(k)).sort();
  return [...known, ...extras];
}

function orderPriority(keys: string[]): string[] {
  const order = ["high", "medium", "low"];
  const known = order.filter((k) => keys.includes(k));
  const extras = keys.filter((k) => !order.includes(k)).sort();
  return [...known, ...extras];
}

function sum(values: Record<string, number> | undefined): number {
  if (!values) return 0;
  let total = 0;
  for (const v of Object.values(values)) total += v;
  return total;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

// NotLoggedInError mirrors the auth command's class so the CLI bootstrap
// can apply the same exit-code mapping (authExitCodeForError → exit 2)
// without needing a second branch.
export class NotLoggedInError extends Error {
  constructor(message = "not logged in") {
    super(message);
    this.name = "NotLoggedInError";
  }
}
