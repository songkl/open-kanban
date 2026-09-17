// `kanban status` command.
//
// Mirrors the data returned by the MCP server's `get_status` tool: probe the
// boards endpoint, time the round trip, and surface a single-screen summary
// (apiUrl / latency / boardsCount / online-or-error). The endpoint is public
// (no auth required) so the command works without a stored OAuth token — it
// just reports offline + the error message if the API is unreachable.

import chalk from "chalk";
import { HttpClient } from "../http/client.js";
import { formatStructured } from "../output/format.js";

export interface StatusReport {
  apiUrl: string;
  status: "online" | "offline";
  latencyMs: number;
  boardsCount: number;
  boards: BoardSummary[];
  error?: string;
  timestamp: string;
}

export interface BoardSummary {
  id: string;
  name: string;
  columns: number;
}

export type OutputFormat = "table" | "json" | "yaml";

export interface RunStatusOptions {
  apiUrl: string;
  // format controls how the report is rendered. "table" prints a fixed
  // header + per-board rows; "json" emits the raw StatusReport so the
  // output is consumable by scripts (jq, CI, etc.).
  format?: OutputFormat;
  // io lets the bootstrap layer and the tests redirect stdout/stderr.
  io?: {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  };
  // http is injected so tests can stub the network boundary. The CLI
  // bootstrap builds an HttpClient from KANBAN_API_URL / --api-url.
  http: HttpClient;
}

// runStatus calls GET /api/v1/boards, measures the round-trip latency, and
// prints a one-screen summary. Unlike `auth status`, this command is meant
// to be the operator's first sanity check ("is the API reachable?"), so it
// does not require authentication and never throws on transport errors —
// instead the StatusReport.status is set to "offline" with the error
// captured in the report. Callers (the CLI entry / tests) decide whether to
// exit non-zero based on the returned report.
export async function runStatus(
  opts: RunStatusOptions
): Promise<StatusReport> {
  const stdout = opts.io?.stdout ?? process.stdout;
  const stderr = opts.io?.stderr ?? process.stderr;
  const format: OutputFormat = opts.format ?? "table";
  const apiUrl = stripTrailingSlash(opts.apiUrl);
  const path = "/api/v1/boards";
  const timestamp = new Date().toISOString();
  const start = Date.now();
  let boards: BoardSummary[] = [];
  let status: "online" | "offline" = "online";
  let error: string | undefined;
  try {
    const raw = await opts.http.apiGet<BoardRaw[]>(path);
    boards = raw.map(toSummary);
  } catch (err) {
    status = "offline";
    error = (err as Error).message ?? String(err);
  }
  const latencyMs = Date.now() - start;
  const report: StatusReport = {
    apiUrl,
    status,
    latencyMs,
    boardsCount: boards.length,
    boards,
    error,
    timestamp,
  };
  const structured = formatStructured(report, format);
  if (structured) {
    stdout.write(structured);
  } else {
    stdout.write(formatStatusTable(report) + "\n");
    if (status === "offline") {
      stderr.write(chalk.red(`kanban status: ${error ?? "API unreachable"}\n`));
    }
  }
  return report;
}

interface BoardRaw {
  id?: string;
  name?: string;
  description?: string;
  deleted?: boolean;
  createdAt?: string;
  updatedAt?: string;
  _count?: { columns?: number };
}

function toSummary(raw: BoardRaw): BoardSummary {
  return {
    id: raw.id ?? "",
    name: raw.name ?? "(unnamed)",
    columns: raw._count?.columns ?? 0,
  };
}

function formatStatusTable(r: StatusReport): string {
  const statusLine =
    r.status === "online"
      ? chalk.green("online")
      : chalk.red(`offline${r.error ? `: ${r.error}` : ""}`);
  const lines = [
    `${chalk.bold("Kanban API")}        ${chalk.cyan(r.apiUrl)}`,
    `${chalk.bold("Status")}            ${statusLine}`,
    `${chalk.bold("Latency")}           ${r.latencyMs} ms`,
    `${chalk.bold("Boards")}            ${r.boardsCount}`,
    `${chalk.bold("Timestamp")}         ${r.timestamp}`,
  ];
  if (r.boards.length > 0) {
    lines.push("", chalk.bold("Boards:"));
    for (const b of r.boards) {
      lines.push(
        `  - ${chalk.cyan(b.id)}  ${b.name}  ${chalk.gray(`(${b.columns} columns)`)}`
      );
    }
  }
  return lines.join("\n");
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
