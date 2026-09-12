// `kanban workspace upload / batch-upload / list / read / delete / stats`
// commands.
//
// All commands target the /api/v1/workspace/* endpoints declared in
// backend/cmd/server/main.go (grouped behind RequireSignatureVerification
// + RequireAuth), so the CLI must attach an OAuth session before any
// request goes out. The HttpClient handles bearer-token plumbing and 401
// retries, so each runner below only has to worry about request shape
// and output formatting.
//
// `workspace upload <file>` reads a UTF-8 text file from disk and POSTs
// { path, content } to /api/v1/workspace/upload. The server stores the
// content under <workspace>/<path> and returns { path, size }; the path
// is the workspace-relative id other commands use to address the file.
// A local file that does not exist on disk surfaces as InvalidUsageError
// so the CLI exits with code 1 instead of bubbling a network error.
//
// `workspace batch-upload <files...>` reads every local file in parallel
// and POSTs them as a single { files: [{ path, content }] } payload to
// /api/v1/workspace/batch-upload. The server reports per-file results in
// a map keyed by the original path; the CLI prints a table of successes
// and a separate section for failures.
//
// `workspace list [--path <sub>]` GETs /api/v1/workspace/files and prints
// the entries as a table. The server's response shape is
// { files: [{ name, path, isDir, size, modified }] }.
//
// `workspace read <id>` GETs /api/v1/workspace/files/<id>. In the default
// text mode the command writes the raw file content to stdout so it can
// be piped (`kanban workspace read foo.txt | less`). With --output json
// the content is rendered as a base64 string inside a JSON object so
// binary payloads survive a JSON round trip.
//
// `workspace delete <id>` DELETEs /api/v1/workspace/files/<id> and prints
// a one-line confirmation. The --yes flag is accepted for parity with
// the other destructive commands but defaults to true.
//
// `workspace stats` GETs /api/v1/workspace/stats and prints
// totalFiles / totalSize / fileCount / directoryCount as a table or
// raw JSON.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import chalk from "chalk";
import Table from "cli-table3";
import { HttpClient, AuthError, NotFoundError } from "../http/client.js";
import { InvalidUsageError } from "./boards.js";
import { NotLoggedInError } from "./dashboard.js";

export type OutputFormat = "table" | "json";

export interface WorkspaceFileEntry {
  name?: string;
  path?: string;
  isDir?: boolean;
  size?: number;
  modified?: number;
}

export interface WorkspaceFilesResponse {
  files?: WorkspaceFileEntry[];
}

export interface WorkspaceReadResponse {
  content?: string;
  size?: number;
}

export interface WorkspaceStatsRecord {
  totalFiles?: number;
  totalSize?: number;
  fileCount?: number;
  directoryCount?: number;
}

export interface WorkspaceUploadResult {
  apiUrl: string;
  path: string;
  size: number;
  raw: Record<string, unknown>;
}

export interface WorkspaceBatchResult {
  apiUrl: string;
  results: Record<string, WorkspaceUploadResult | { error: string }>;
  summary: {
    succeeded: number;
    failed: number;
  };
}

export interface WorkspaceFilesReport {
  apiUrl: string;
  path?: string;
  files: WorkspaceFileEntry[];
}

export interface WorkspaceReadResult {
  apiUrl: string;
  path: string;
  content: string;
  size: number;
}

export interface WorkspaceReadJsonResult {
  apiUrl: string;
  path: string;
  content: string;
  encoding: "base64";
  size: number;
}

export interface WorkspaceDeleteResult {
  apiUrl: string;
  path: string;
  success: boolean;
}

export interface WorkspaceStatsReport {
  apiUrl: string;
  stats: WorkspaceStatsRecord;
}

export interface RunWorkspaceUploadOptions {
  apiUrl: string;
  file: string;
  remotePath?: string;
  format?: OutputFormat;
  io?: {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  };
  http: HttpClient;
}

export interface RunWorkspaceBatchUploadOptions {
  apiUrl: string;
  files: string[];
  format?: OutputFormat;
  io?: {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  };
  http: HttpClient;
}

export interface RunWorkspaceListOptions {
  apiUrl: string;
  path?: string;
  format?: OutputFormat;
  io?: {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  };
  http: HttpClient;
}

export interface RunWorkspaceReadOptions {
  apiUrl: string;
  format?: OutputFormat;
  io?: {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  };
  http: HttpClient;
}

export interface RunWorkspaceDeleteOptions {
  apiUrl: string;
  yes?: boolean;
  format?: OutputFormat;
  io?: {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  };
  http: HttpClient;
}

export interface RunWorkspaceStatsOptions {
  apiUrl: string;
  format?: OutputFormat;
  io?: {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  };
  http: HttpClient;
}

// runWorkspaceUpload reads a UTF-8 text file from disk and POSTs
// { path, content } to /api/v1/workspace/upload. The path defaults to
// the file's basename but can be overridden via opts.remotePath so
// callers can place the upload at an explicit workspace-relative
// location (e.g. `kanban workspace upload foo.txt --path src/foo.txt`).
export async function runWorkspaceUpload(
  opts: RunWorkspaceUploadOptions
): Promise<WorkspaceUploadResult> {
  const stdout = opts.io?.stdout ?? process.stdout;
  const stderr = opts.io?.stderr ?? process.stderr;
  const apiUrl = stripTrailingSlash(opts.apiUrl);
  const format: OutputFormat = opts.format ?? "table";

  if (!opts.file || !opts.file.trim()) {
    throw new InvalidUsageError("kanban workspace upload requires a file path");
  }
  const localPath = opts.file.trim();
  const remotePath = (opts.remotePath ?? path.basename(localPath)).trim();
  if (!remotePath) {
    throw new InvalidUsageError(
      "kanban workspace upload --path must not be empty"
    );
  }

  const content = await readLocalFile(localPath);

  let raw: Record<string, unknown>;
  try {
    raw = await opts.http.apiPost<Record<string, unknown>>(
      "/api/v1/workspace/upload",
      { path: remotePath, content }
    );
  } catch (err) {
    throw await mapAuthError(err, stderr);
  }
  const storedPath = typeof raw.path === "string" ? raw.path : remotePath;
  const storedSize = typeof raw.size === "number" ? raw.size : Buffer.byteLength(content, "utf8");
  const result: WorkspaceUploadResult = {
    apiUrl,
    path: storedPath,
    size: storedSize,
    raw,
  };
  if (format === "json") {
    stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    stdout.write(
      `${chalk.green("Uploaded")} ${storedPath} (${storedSize} bytes)\n`
    );
  }
  return result;
}

// runWorkspaceBatchUpload reads every supplied local file in parallel
// and POSTs them as one { files: [{ path, content }] } payload to
// /api/v1/workspace/batch-upload. Per-file results from the server are
// returned as a map keyed by the original (client-supplied) path.
export async function runWorkspaceBatchUpload(
  opts: RunWorkspaceBatchUploadOptions
): Promise<WorkspaceBatchResult> {
  const stdout = opts.io?.stdout ?? process.stdout;
  const stderr = opts.io?.stderr ?? process.stderr;
  const apiUrl = stripTrailingSlash(opts.apiUrl);
  const format: OutputFormat = opts.format ?? "table";

  if (!Array.isArray(opts.files) || opts.files.length === 0) {
    throw new InvalidUsageError(
      "kanban workspace batch-upload requires at least one file"
    );
  }
  const trimmed = opts.files.map((f) => (f ?? "").trim()).filter(Boolean);
  if (trimmed.length === 0) {
    throw new InvalidUsageError(
      "kanban workspace batch-upload requires at least one non-empty file path"
    );
  }
  const readFiles = await Promise.all(
    trimmed.map(async (file) => ({
      path: path.basename(file),
      content: await readLocalFile(file),
    }))
  );

  let raw: Record<string, Record<string, unknown>>;
  try {
    raw = await opts.http.apiPost<Record<string, Record<string, unknown>>>(
      "/api/v1/workspace/batch-upload",
      { files: readFiles }
    );
  } catch (err) {
    throw await mapAuthError(err, stderr);
  }
  const summary = { succeeded: 0, failed: 0 };
  const results: Record<string, WorkspaceUploadResult | { error: string }> = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (value && typeof value === "object" && "error" in value) {
      const errMsg =
        typeof (value as { error?: unknown }).error === "string"
          ? (value as { error: string }).error
          : "unknown error";
      results[key] = { error: errMsg };
      summary.failed++;
    } else {
      const entry = value as { path?: unknown; size?: unknown };
      const storedPath = typeof entry?.path === "string" ? entry.path : key;
      const storedSize =
        typeof entry?.size === "number" ? entry.size : 0;
      results[key] = {
        apiUrl,
        path: storedPath,
        size: storedSize,
        raw: value,
      };
      summary.succeeded++;
    }
  }
  const report: WorkspaceBatchResult = { apiUrl, results, summary };
  if (format === "json") {
    stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    stdout.write(formatBatchTable(report) + "\n");
  }
  return report;
}

// runWorkspaceList GETs /api/v1/workspace/files (optionally narrowed by
// ?path=<sub>) and renders the response as a table or raw JSON. The
// server always wraps the array in { files: [...] }, so we unwrap once
// and tolerate a missing `files` key by returning an empty list.
export async function runWorkspaceList(
  opts: RunWorkspaceListOptions
): Promise<WorkspaceFilesReport> {
  const stdout = opts.io?.stdout ?? process.stdout;
  const stderr = opts.io?.stderr ?? process.stderr;
  const apiUrl = stripTrailingSlash(opts.apiUrl);
  const format: OutputFormat = opts.format ?? "table";

  const query: Record<string, string | undefined> = {};
  if (opts.path && opts.path.trim()) {
    query.path = opts.path.trim();
  }

  let raw: WorkspaceFilesResponse;
  try {
    raw = await opts.http.apiGet<WorkspaceFilesResponse>(
      "/api/v1/workspace/files",
      Object.keys(query).length > 0 ? { query } : {}
    );
  } catch (err) {
    throw await mapAuthError(err, stderr);
  }
  const files = Array.isArray(raw?.files) ? raw.files : [];
  const report: WorkspaceFilesReport = {
    apiUrl,
    path: query.path,
    files,
  };
  if (format === "json") {
    stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    stdout.write(formatFilesTable(report) + "\n");
  }
  return report;
}

// runWorkspaceRead GETs /api/v1/workspace/files/<id> and prints the
// file content. Default text mode writes the raw content to stdout so
// the command can be piped (`kanban workspace read foo.txt | less`).
// With --output json the content is base64-encoded inside a JSON
// envelope so binary payloads survive the round trip and downstream
// consumers can decode deterministically.
export async function runWorkspaceRead(
  opts: RunWorkspaceReadOptions,
  id: string
): Promise<WorkspaceReadResult | WorkspaceReadJsonResult> {
  const stdout = opts.io?.stdout ?? process.stdout;
  const stderr = opts.io?.stderr ?? process.stderr;
  const apiUrl = stripTrailingSlash(opts.apiUrl);
  const format: OutputFormat = opts.format ?? "table";

  const trimmed = (id ?? "").trim();
  if (!trimmed) {
    throw new InvalidUsageError("kanban workspace read requires a path");
  }

  let raw: WorkspaceReadResponse;
  try {
    raw = await opts.http.apiGet<WorkspaceReadResponse>(
      `/api/v1/workspace/files/${encodeURIComponent(trimmed)}`
    );
  } catch (err) {
    if (err instanceof NotFoundError) {
      stderr.write(chalk.red(`file not found: ${trimmed}\n`));
    }
    throw await mapAuthError(err, stderr);
  }
  const content = typeof raw?.content === "string" ? raw.content : "";
  const size = typeof raw?.size === "number" ? raw.size : Buffer.byteLength(content, "utf8");

  if (format === "json") {
    const encoded = Buffer.from(content, "utf8").toString("base64");
    const result: WorkspaceReadJsonResult = {
      apiUrl,
      path: trimmed,
      content: encoded,
      encoding: "base64",
      size,
    };
    stdout.write(JSON.stringify(result, null, 2) + "\n");
    return result;
  }
  stdout.write(content);
  if (!content.endsWith("\n")) stdout.write("\n");
  const result: WorkspaceReadResult = { apiUrl, path: trimmed, content, size };
  return result;
}

// runWorkspaceDelete DELETEs /api/v1/workspace/files/<id> and prints a
// short confirmation. The --yes flag is accepted for parity with the
// other destructive commands but defaults to true.
export async function runWorkspaceDelete(
  opts: RunWorkspaceDeleteOptions,
  id: string
): Promise<WorkspaceDeleteResult> {
  const stdout = opts.io?.stdout ?? process.stdout;
  const stderr = opts.io?.stderr ?? process.stderr;
  const apiUrl = stripTrailingSlash(opts.apiUrl);
  const format: OutputFormat = opts.format ?? "table";

  const trimmed = (id ?? "").trim();
  if (!trimmed) {
    throw new InvalidUsageError("kanban workspace delete requires a path");
  }
  try {
    await opts.http.apiDelete(
      `/api/v1/workspace/files/${encodeURIComponent(trimmed)}`
    );
  } catch (err) {
    if (err instanceof NotFoundError) {
      stderr.write(chalk.red(`file not found: ${trimmed}\n`));
    }
    throw await mapAuthError(err, stderr);
  }
  const result: WorkspaceDeleteResult = {
    apiUrl,
    path: trimmed,
    success: true,
  };
  if (format === "json") {
    stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    stdout.write(`${chalk.green("Deleted")} ${trimmed}\n`);
  }
  return result;
}

// runWorkspaceStats GETs /api/v1/workspace/stats and prints the four
// counters (totalFiles / totalSize / fileCount / directoryCount) as a
// table or raw JSON. Missing fields are coerced to 0 so the output
// always renders.
export async function runWorkspaceStats(
  opts: RunWorkspaceStatsOptions
): Promise<WorkspaceStatsReport> {
  const stdout = opts.io?.stdout ?? process.stdout;
  const stderr = opts.io?.stderr ?? process.stderr;
  const apiUrl = stripTrailingSlash(opts.apiUrl);
  const format: OutputFormat = opts.format ?? "table";

  let raw: WorkspaceStatsRecord;
  try {
    raw = await opts.http.apiGet<WorkspaceStatsRecord>(
      "/api/v1/workspace/stats"
    );
  } catch (err) {
    throw await mapAuthError(err, stderr);
  }
  const stats: WorkspaceStatsRecord = {
    totalFiles: numberOrZero(raw?.totalFiles),
    totalSize: numberOrZero(raw?.totalSize),
    fileCount: numberOrZero(raw?.fileCount),
    directoryCount: numberOrZero(raw?.directoryCount),
  };
  const report: WorkspaceStatsReport = { apiUrl, stats };
  if (format === "json") {
    stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    stdout.write(formatStatsTable(report) + "\n");
  }
  return report;
}

// readLocalFile loads a UTF-8 text file from disk and surfaces the
// usual "file missing" failure as an InvalidUsageError so the CLI can
// exit with code 1 instead of bubbling a low-level Node error to the
// top-level catch.
async function readLocalFile(file: string): Promise<string> {
  let buf: Buffer;
  try {
    buf = await fs.readFile(file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      throw new InvalidUsageError(
        `kanban workspace upload: local file not found: ${file}`
      );
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new InvalidUsageError(
        `kanban workspace upload: cannot read ${file}: ${code}`
      );
    }
    throw err;
  }
  // The server stores req.Content verbatim, so we always send the raw
  // UTF-8 text. We use Buffer.toString("utf8") rather than a decoder
  // pipeline so the result is stable across Node versions.
  return buf.toString("utf8");
}

// numberOrZero coerces an unknown value into a finite number, falling
// back to 0 for anything that isn't a real number. The workspace
// stats endpoint always returns numeric counters, but the CLI still
// tolerates missing keys so an upstream change never produces a NaN
// in the rendered output.
function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function formatFilesTable(r: WorkspaceFilesReport): string {
  const lines: string[] = [];
  const subtitle = r.path ? `path=${r.path}` : "";
  lines.push(
    `${chalk.bold("Workspace")} ${chalk.cyan(r.apiUrl)}${
      subtitle ? `  ${chalk.gray(subtitle)}` : ""
    }`
  );
  if (r.files.length === 0) {
    lines.push(chalk.gray("  (no files)"));
    return lines.join("\n");
  }
  const headers = ["name", "path", "type", "size", "modified"];
  const table = new Table({
    head: headers.map((f) => chalk.bold(f)),
    style: { head: [], border: [] },
  });
  for (const f of r.files) {
    table.push([
      f.name ?? "",
      f.path ?? "",
      f.isDir ? chalk.cyan("dir") : chalk.gray("file"),
      String(f.size ?? 0),
      f.modified ? new Date(f.modified * 1000).toISOString() : "",
    ]);
  }
  lines.push(table.toString());
  return lines.join("\n");
}

function formatStatsTable(r: WorkspaceStatsReport): string {
  const lines: string[] = [];
  lines.push(`${chalk.bold("Workspace")} ${chalk.cyan(r.apiUrl)}`);
  const table = new Table({
    head: ["metric", "value"].map((f) => chalk.bold(f)),
    style: { head: [], border: [] },
  });
  table.push(["totalFiles", String(r.stats.totalFiles ?? 0)]);
  table.push(["totalSize", String(r.stats.totalSize ?? 0)]);
  table.push(["fileCount", String(r.stats.fileCount ?? 0)]);
  table.push(["directoryCount", String(r.stats.directoryCount ?? 0)]);
  lines.push(table.toString());
  return lines.join("\n");
}

function formatBatchTable(r: WorkspaceBatchResult): string {
  const lines: string[] = [];
  lines.push(
    `${chalk.bold("Workspace")} ${chalk.cyan(r.apiUrl)}  ${chalk.gray(
      `${r.summary.succeeded} ok / ${r.summary.failed} failed`
    )}`
  );
  const headers = ["path", "status", "storedAs", "size"];
  const table = new Table({
    head: headers.map((f) => chalk.bold(f)),
    style: { head: [], border: [] },
  });
  for (const [key, value] of Object.entries(r.results)) {
    if ("error" in value) {
      table.push([key, chalk.red("error"), "-", value.error]);
    } else {
      table.push([
        key,
        chalk.green("ok"),
        value.path,
        String(value.size),
      ]);
    }
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
