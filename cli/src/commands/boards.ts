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

import { HttpClient, NotFoundError } from "../http/client.js";
import {
  CommandContext,
  IoStreams,
  OutputFormat,
  createContext,
  defaultCell,
  emitListReport,
  emitRecordReport,
  normalizeFields,
  reportNotFound,
} from "../output/format.js";
import { makeLabelFor } from "../output/table.js";

export interface BoardRecord extends Record<string, unknown> {
  id?: string;
  name?: string;
  description?: string;
  shortAlias?: string;
  deleted?: boolean;
  createdAt?: string;
  updatedAt?: string;
  isPublic?: boolean;
  isOwner?: boolean;
  effectiveAccess?: string;
  taskCount?: number;
  lastActiveAt?: string;
  _count?: { columns?: number };
}

export interface BoardsReport extends Record<string, unknown> {
  apiUrl: string;
  boards: BoardRecord[];
}

export interface BoardReport extends Record<string, unknown> {
  apiUrl: string;
  board: BoardRecord;
}

export const BOARDS_LIST_DEFAULT_FIELDS = ["id", "name", "createdAt"] as const;
export const BOARDS_LIST_AVAILABLE_FIELDS = [
  "id",
  "name",
  "description",
  "shortAlias",
  "createdAt",
  "updatedAt",
  "isPublic",
  "isOwner",
  "effectiveAccess",
  "taskCount",
  "lastActiveAt",
  "columnCount",
] as const;
export const BOARDS_GET_DEFAULT_FIELDS = [
  "id",
  "name",
  "description",
  "shortAlias",
  "createdAt",
  "updatedAt",
  "isPublic",
  "isOwner",
  "effectiveAccess",
  "taskCount",
  "lastActiveAt",
  "columnCount",
] as const;

export interface RunBoardsListOptions {
  apiUrl: string;
  format?: OutputFormat;
  fields?: string[];
  io?: IoStreams;
  http: HttpClient;
}

export interface RunBoardsGetOptions {
  apiUrl: string;
  format?: OutputFormat;
  fields?: string[];
  io?: IoStreams;
  http: HttpClient;
}

function projectBoard(board: BoardRecord, fields: readonly string[]): BoardRecord {
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
      case "isPublic":
        out.isPublic = board.isPublic ?? false;
        break;
      case "isOwner":
        out.isOwner = board.isOwner ?? false;
        break;
      case "effectiveAccess":
        out.effectiveAccess = board.effectiveAccess ?? "";
        break;
      case "taskCount":
        out.taskCount = board.taskCount ?? 0;
        break;
      case "lastActiveAt":
        out.lastActiveAt = board.lastActiveAt ?? "";
        break;
      case "columnCount":
        out._count = { columns: board._count?.columns ?? 0 };
        break;
    }
  }
  return out;
}

function renderBoardCell(b: BoardRecord, field: string): string {
  switch (field) {
    case "id":
      return defaultCell(b.id);
    case "name":
      return b.name ?? "(unnamed)";
    case "description":
      return defaultCell(b.description);
    case "shortAlias":
      return defaultCell(b.shortAlias);
    case "createdAt":
      return defaultCell(b.createdAt);
    case "updatedAt":
      return defaultCell(b.updatedAt);
    case "isPublic":
      return b.isPublic ? "yes" : "no";
    case "isOwner":
      return b.isOwner ? "yes" : "no";
    case "effectiveAccess":
      return defaultCell(b.effectiveAccess);
    case "taskCount":
      return String(b.taskCount ?? 0);
    case "lastActiveAt":
      return defaultCell(b.lastActiveAt);
    case "columnCount":
      return String(b._count?.columns ?? 0);
    default:
      return "";
  }
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
  const ctx = createContext({
    apiUrl: opts.apiUrl,
    format: opts.format,
    io: opts.io,
  });
  const fields = normalizeFields(
    opts.fields,
    BOARDS_LIST_DEFAULT_FIELDS,
    BOARDS_LIST_AVAILABLE_FIELDS
  );
  const raw = await opts.http.apiGet<BoardRecord[]>("/api/v1/boards");
  const boards = Array.isArray(raw) ? raw : [];
  const projected = boards.map((b) => projectBoard(b, fields));
  const report: BoardsReport = { apiUrl: ctx.apiUrl, boards: projected };
  emitListReport<BoardRecord>(report, ctx, {
    title: "Boards",
    emptyMessage: "no boards",
    fields,
    rows: projected,
    labelFor: makeLabelFor({ columnCount: "columns" }),
    renderField: renderBoardCell,
  });
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
  const ctx = createContext({
    apiUrl: opts.apiUrl,
    format: opts.format,
    io: opts.io,
  });
  const fields = normalizeFields(
    opts.fields,
    BOARDS_GET_DEFAULT_FIELDS,
    BOARDS_LIST_AVAILABLE_FIELDS
  );
  let board: BoardRecord;
  try {
    board = await opts.http.apiGet<BoardRecord>(
      `/api/v1/boards/${encodeURIComponent(id)}`
    );
  } catch (err) {
    if (err instanceof NotFoundError) {
      reportNotFound(ctx, "board", id);
    }
    throw err;
  }
  const projected = projectBoard(board, fields);
  const report: BoardReport = { apiUrl: ctx.apiUrl, board: projected };
  emitRecordReport(report, ctx, {
    title: "Board",
    fields,
    values: projected as unknown as Record<string, unknown>,
    labelFor: makeLabelFor({ columnCount: "columns" }),
    renderField: (_f, v) => renderBoardCell(projected, _f),
  });
  return report;
}

// InvalidUsageError signals a CLI-level misuse (missing argument, etc.)
// rather than an API error. The CLI bootstrap maps it to exit code 1.
export class InvalidUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidUsageError";
  }
}

// Internal alias kept for the test file which imports CommandContext indirectly.
export type { CommandContext };