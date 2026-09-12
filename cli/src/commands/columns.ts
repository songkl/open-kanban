// `kanban columns list` / `kanban columns get` commands.
//
// `columns list [--board <id>] [--positions 1,3,5]` pulls
// GET /api/v1/columns with optional query parameters. The backend filters
// rows by boardId and position IN (...) when those query params are
// present, mirroring the same filters the kanban dashboard exposes.
//
// `columns get <id>` calls GET /api/v1/columns/:id and prints the matched
// column. The column detail route is registered as part of the same
// public group as GET /api/v1/columns, so neither command requires an
// OAuth session — callers can run them after `kanban auth login` fails.
//
// Both endpoints accept `--output json|table` and `--fields` for field
// projection, matching the conventions used by the boards command.

import chalk from "chalk";
import Table from "cli-table3";
import { HttpClient, NotFoundError } from "../http/client.js";
import { InvalidUsageError } from "./boards.js";
import { formatStructured } from "../output/format.js";

export interface ColumnRecord {
  id?: string;
  name?: string;
  status?: string | null;
  position?: number;
  color?: string;
  description?: string;
  ownerAgentId?: string | null;
  boardId?: string;
  createdAt?: string;
  updatedAt?: string;
  tasks?: unknown[];
  agentConfig?: unknown;
}

export interface ColumnsReport {
  apiUrl: string;
  boardId?: string;
  positions?: number[];
  columns: ColumnRecord[];
}

export interface ColumnReport {
  apiUrl: string;
  column: ColumnRecord;
}

export type OutputFormat = "table" | "json" | "yaml";

export interface RunColumnsListOptions {
  apiUrl: string;
  boardId?: string;
  positions?: number[];
  format?: OutputFormat;
  fields?: string[];
  io?: {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  };
  http: HttpClient;
}

export interface RunColumnsGetOptions {
  apiUrl: string;
  format?: OutputFormat;
  fields?: string[];
  io?: {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  };
  http: HttpClient;
}

export const COLUMNS_LIST_DEFAULT_FIELDS = [
  "id",
  "name",
  "boardId",
  "position",
  "status",
] as const;
export const COLUMNS_LIST_AVAILABLE_FIELDS = [
  "id",
  "name",
  "boardId",
  "position",
  "status",
  "color",
  "description",
  "ownerAgentId",
  "createdAt",
  "updatedAt",
] as const;
export const COLUMNS_GET_DEFAULT_FIELDS = [
  "id",
  "name",
  "boardId",
  "position",
  "status",
  "color",
  "description",
] as const;

// runColumnsList fetches GET /api/v1/columns, optionally filtered by
// --board and --positions. The positions argument is normalised into a
// sorted, de-duplicated list before being forwarded to the server, so the
// resulting query string stays stable regardless of CLI ordering.
export async function runColumnsList(
  opts: RunColumnsListOptions
): Promise<ColumnsReport> {
  const stdout = opts.io?.stdout ?? process.stdout;
  const apiUrl = stripTrailingSlash(opts.apiUrl);
  const format: OutputFormat = opts.format ?? "table";
  const fields = normalizeFields(opts.fields, COLUMNS_LIST_DEFAULT_FIELDS);
  const positions = normalizePositions(opts.positions);
  const query: Record<string, string | number | undefined> = {};
  if (opts.boardId && opts.boardId.trim()) {
    query.boardId = opts.boardId.trim();
  }
  if (positions.length > 0) {
    query.positions = positions.join(",");
  }
  const raw = await opts.http.apiGet<ColumnRecord[]>(
    "/api/v1/columns",
    Object.keys(query).length > 0 ? { query } : {}
  );
  const columns = Array.isArray(raw) ? raw : [];
  const projected = columns.map((c) => projectColumn(c, fields));
  const report: ColumnsReport = {
    apiUrl,
    boardId: query.boardId as string | undefined,
    positions: positions.length > 0 ? positions : undefined,
    columns: projected,
  };
  const structured = formatStructured(report, format);
  if (structured) {
    stdout.write(structured);
  } else {
    stdout.write(formatColumnsTable(report, fields) + "\n");
  }
  return report;
}

// runColumnsGet fetches a single column by id. Missing IDs raise
// InvalidUsageError before any HTTP call is made; a missing record on the
// server surfaces as NotFoundError so the CLI bootstrap can exit with the
// documented code 3.
export async function runColumnsGet(
  opts: RunColumnsGetOptions,
  id: string
): Promise<ColumnReport> {
  if (!id || !id.trim()) {
    throw new InvalidUsageError("kanban columns get requires a column id");
  }
  const stdout = opts.io?.stdout ?? process.stdout;
  const stderr = opts.io?.stderr ?? process.stderr;
  const apiUrl = stripTrailingSlash(opts.apiUrl);
  const format: OutputFormat = opts.format ?? "table";
  const fields = normalizeFields(opts.fields, COLUMNS_GET_DEFAULT_FIELDS);
  let column: ColumnRecord;
  try {
    column = await opts.http.apiGet<ColumnRecord>(`/api/v1/columns/${encodeURIComponent(id)}`);
  } catch (err) {
    if (err instanceof NotFoundError) {
      stderr.write(chalk.red(`column not found: ${id}\n`));
    }
    throw err;
  }
  const projected = projectColumn(column, fields);
  const report: ColumnReport = { apiUrl, column: projected };
  const structured = formatStructured(report, format);
  if (structured) {
    stdout.write(structured);
  } else {
    stdout.write(formatColumnTable(report, fields) + "\n");
  }
  return report;
}

function projectColumn(column: ColumnRecord, fields: string[]): ColumnRecord {
  const out: ColumnRecord = {};
  for (const f of fields) {
    switch (f) {
      case "id":
        out.id = column.id;
        break;
      case "name":
        out.name = column.name;
        break;
      case "boardId":
        out.boardId = column.boardId;
        break;
      case "position":
        out.position = column.position;
        break;
      case "status":
        out.status = column.status ?? null;
        break;
      case "color":
        out.color = column.color;
        break;
      case "description":
        out.description = column.description ?? "";
        break;
      case "ownerAgentId":
        out.ownerAgentId = column.ownerAgentId ?? null;
        break;
      case "createdAt":
        out.createdAt = column.createdAt;
        break;
      case "updatedAt":
        out.updatedAt = column.updatedAt;
        break;
    }
  }
  return out;
}

function formatColumnsTable(r: ColumnsReport, fields: string[]): string {
  const lines: string[] = [];
  const subtitle = describeFilter(r);
  lines.push(
    `${chalk.bold("Columns")} ${chalk.cyan(r.apiUrl)}${
      subtitle ? `  ${chalk.gray(subtitle)}` : ""
    }`
  );
  if (r.columns.length === 0) {
    lines.push(chalk.gray("  (no columns)"));
    return lines.join("\n");
  }
  const table = new Table({
    head: fields.map((f) => chalk.bold(labelForField(f))),
    style: { head: [], border: [] },
  });
  for (const c of r.columns) {
    table.push(fields.map((f) => renderColumnField(c, f)));
  }
  lines.push(table.toString());
  return lines.join("\n");
}

function formatColumnTable(r: ColumnReport, fields: string[]): string {
  const lines: string[] = [];
  lines.push(`${chalk.bold("Column")}  ${chalk.cyan(r.apiUrl)}`);
  for (const f of fields) {
    lines.push(`  ${chalk.bold(labelForField(f))}: ${renderColumnField(r.column, f)}`);
  }
  return lines.join("\n");
}

function describeFilter(r: ColumnsReport): string {
  const parts: string[] = [];
  if (r.boardId) parts.push(`board=${r.boardId}`);
  if (r.positions && r.positions.length > 0) {
    parts.push(`positions=${r.positions.join(",")}`);
  }
  return parts.join(" ");
}

function renderColumnField(c: ColumnRecord, field: string): string {
  switch (field) {
    case "id":
      return c.id ?? "";
    case "name":
      return c.name ?? "(unnamed)";
    case "boardId":
      return c.boardId ?? "";
    case "position":
      return c.position === undefined ? "" : String(c.position);
    case "status":
      return c.status ?? "";
    case "color":
      return c.color ?? "";
    case "description":
      return c.description ?? "";
    case "ownerAgentId":
      return c.ownerAgentId ?? "";
    case "createdAt":
      return c.createdAt ?? "";
    case "updatedAt":
      return c.updatedAt ?? "";
    default:
      return "";
  }
}

function labelForField(f: string): string {
  switch (f) {
    case "id":
      return "id";
    case "name":
      return "name";
    case "boardId":
      return "boardId";
    case "position":
      return "position";
    case "status":
      return "status";
    case "color":
      return "color";
    case "description":
      return "description";
    case "ownerAgentId":
      return "ownerAgentId";
    case "createdAt":
      return "createdAt";
    case "updatedAt":
      return "updatedAt";
    default:
      return f;
  }
}

function normalizeFields(
  fields: string[] | undefined,
  defaults: readonly string[]
): string[] {
  const raw = fields && fields.length > 0 ? fields : [...defaults];
  const allowed = new Set<string>(COLUMNS_LIST_AVAILABLE_FIELDS);
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

function normalizePositions(input: number[] | undefined): number[] {
  if (!input || input.length === 0) return [];
  const seen = new Set<number>();
  for (const p of input) {
    if (!Number.isFinite(p)) {
      throw new InvalidUsageError(
        `invalid position value: ${String(p)} (must be an integer)`
      );
    }
    seen.add(Math.trunc(p));
  }
  return [...seen].sort((a, b) => a - b);
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
