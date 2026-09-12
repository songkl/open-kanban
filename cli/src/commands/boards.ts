// `kanban boards list` / `kanban boards get` commands.
//
// `boards list` pulls GET /api/v1/boards and renders a tabular summary of
// every non-deleted board. The default columns are id, name, and createdAt
// — the same fields the kanban dashboard surfaces — but callers can
// override the column set with `--fields id,name,...` and toggle the
// output format with `--output json|table`.
//
// `boards get <id>` calls GET /api/v1/boards/:id and prints the full board
// record (including description, shortAlias, updatedAt and the column
// count). A missing board surfaces as an ApiError with kind=not_found
// (HTTP 404), so the CLI bootstrap can map it to the documented exit code.
//
// Both endpoints are public (no auth required), matching the route table in
// backend/cmd/server/main.go where boards.GET / boards.GET(":id") are
// registered before the RequireAuth middleware is attached.

import chalk from "chalk";
import Table from "cli-table3";
import { HttpClient, NotFoundError } from "../http/client.js";

export interface BoardRecord {
  id?: string;
  name?: string;
  description?: string;
  shortAlias?: string;
  deleted?: boolean;
  createdAt?: string;
  updatedAt?: string;
  _count?: { columns?: number };
}

export interface BoardsReport {
  apiUrl: string;
  boards: BoardRecord[];
}

export interface BoardReport {
  apiUrl: string;
  board: BoardRecord;
}

export type OutputFormat = "table" | "json";

export const BOARDS_LIST_DEFAULT_FIELDS = ["id", "name", "createdAt"] as const;
export const BOARDS_LIST_AVAILABLE_FIELDS = [
  "id",
  "name",
  "description",
  "shortAlias",
  "createdAt",
  "updatedAt",
  "columnCount",
] as const;
export const BOARDS_GET_DEFAULT_FIELDS = [
  "id",
  "name",
  "description",
  "shortAlias",
  "createdAt",
  "updatedAt",
  "columnCount",
] as const;

export interface RunBoardsListOptions {
  apiUrl: string;
  format?: OutputFormat;
  fields?: string[];
  io?: {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  };
  http: HttpClient;
}

export interface RunBoardsGetOptions {
  apiUrl: string;
  format?: OutputFormat;
  fields?: string[];
  io?: {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  };
  http: HttpClient;
}

// runBoardsList fetches the public boards index, applies the requested
// field projection, and prints the result. The endpoint is unauthenticated
// so the command works without `kanban auth login` having been run first.
// Non-2xx responses bubble up as ApiError subclasses so the CLI bootstrap
// can map them to the right exit code (3 for 404, 4 for 5xx, 5 for
// network, etc.).
export async function runBoardsList(
  opts: RunBoardsListOptions
): Promise<BoardsReport> {
  const stdout = opts.io?.stdout ?? process.stdout;
  const apiUrl = stripTrailingSlash(opts.apiUrl);
  const format: OutputFormat = opts.format ?? "table";
  const fields = normalizeFields(opts.fields, BOARDS_LIST_DEFAULT_FIELDS);
  const raw = await opts.http.apiGet<BoardRecord[]>("/api/v1/boards");
  const boards = Array.isArray(raw) ? raw : [];
  const projected = boards.map((b) => projectBoard(b, fields));
  const report: BoardsReport = { apiUrl, boards: projected };
  if (format === "json") {
    stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    stdout.write(formatBoardsTable(report, fields) + "\n");
  }
  return report;
}

// runBoardsGet fetches a single board by id. The CLI requires the caller to
// supply the id (there is no default), and surfaces 404 from the server as
// a NotFoundError so the bootstrap layer can exit with code 3.
export async function runBoardsGet(
  opts: RunBoardsGetOptions,
  id: string
): Promise<BoardReport> {
  if (!id || !id.trim()) {
    throw new InvalidUsageError("kanban boards get requires a board id");
  }
  const stdout = opts.io?.stdout ?? process.stdout;
  const stderr = opts.io?.stderr ?? process.stderr;
  const apiUrl = stripTrailingSlash(opts.apiUrl);
  const format: OutputFormat = opts.format ?? "table";
  const fields = normalizeFields(opts.fields, BOARDS_GET_DEFAULT_FIELDS);
  let board: BoardRecord;
  try {
    board = await opts.http.apiGet<BoardRecord>(`/api/v1/boards/${encodeURIComponent(id)}`);
  } catch (err) {
    if (err instanceof NotFoundError) {
      stderr.write(chalk.red(`board not found: ${id}\n`));
    }
    throw err;
  }
  const projected = projectBoard(board, fields);
  const report: BoardReport = { apiUrl, board: projected };
  if (format === "json") {
    stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    stdout.write(formatBoardTable(report, fields) + "\n");
  }
  return report;
}

function projectBoard(board: BoardRecord, fields: string[]): BoardRecord {
  const out: BoardRecord = {};
  for (const f of fields) {
    switch (f) {
      case "id":
        out.id = board.id;
        break;
      case "name":
        out.name = board.name;
        break;
      case "description":
        out.description = board.description ?? "";
        break;
      case "shortAlias":
        out.shortAlias = board.shortAlias ?? "";
        break;
      case "createdAt":
        out.createdAt = board.createdAt;
        break;
      case "updatedAt":
        out.updatedAt = board.updatedAt;
        break;
      case "columnCount":
        out._count = { columns: board._count?.columns ?? 0 };
        break;
    }
  }
  return out;
}

function formatBoardsTable(r: BoardsReport, fields: string[]): string {
  const lines: string[] = [];
  lines.push(`${chalk.bold("Boards")}  ${chalk.cyan(r.apiUrl)}`);
  if (r.boards.length === 0) {
    lines.push(chalk.gray("  (no boards)"));
    return lines.join("\n");
  }
  const table = new Table({
    head: fields.map((f) => chalk.bold(labelForField(f))),
    style: { head: [], border: [] },
  });
  for (const b of r.boards) {
    table.push(fields.map((f) => renderBoardField(b, f)));
  }
  lines.push(table.toString());
  return lines.join("\n");
}

function formatBoardTable(r: BoardReport, fields: string[]): string {
  const lines: string[] = [];
  lines.push(`${chalk.bold("Board")}   ${chalk.cyan(r.apiUrl)}`);
  for (const f of fields) {
    lines.push(`  ${chalk.bold(labelForField(f))}: ${renderBoardField(r.board, f)}`);
  }
  return lines.join("\n");
}

function renderBoardField(b: BoardRecord, field: string): string {
  switch (field) {
    case "id":
      return b.id ?? "";
    case "name":
      return b.name ?? "(unnamed)";
    case "description":
      return b.description ?? "";
    case "shortAlias":
      return b.shortAlias ?? "";
    case "createdAt":
      return b.createdAt ?? "";
    case "updatedAt":
      return b.updatedAt ?? "";
    case "columnCount":
      return String(b._count?.columns ?? 0);
    default:
      return "";
  }
}

function labelForField(f: string): string {
  switch (f) {
    case "createdAt":
      return "createdAt";
    case "updatedAt":
      return "updatedAt";
    case "shortAlias":
      return "shortAlias";
    case "columnCount":
      return "columns";
    case "description":
      return "description";
    case "name":
      return "name";
    case "id":
      return "id";
    default:
      return f;
  }
}

function normalizeFields(
  fields: string[] | undefined,
  defaults: readonly string[]
): string[] {
  const raw = fields && fields.length > 0 ? fields : [...defaults];
  const allowed = new Set<string>(BOARDS_LIST_AVAILABLE_FIELDS);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of raw) {
    const trimmed = f.trim();
    if (!trimmed) continue;
    if (!allowed.has(trimmed)) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out.length > 0 ? out : [...defaults];
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

// InvalidUsageError signals a CLI-level misuse (missing argument, etc.)
// rather than an API error. The CLI bootstrap maps it to exit code 1.
export class InvalidUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidUsageError";
  }
}
