// `kanban tasks batch create / update / delete`.
//
// Batch operations hit /api/v1/tasks/batch via three HTTP verbs:
//
//   POST   /api/v1/tasks/batch   → BatchCreateTasks (body: { tasks: [...] })
//   PUT    /api/v1/tasks/batch   → BatchUpdateTasks (body: { ids, columnId|status, priority, assignee })
//   DELETE /api/v1/tasks/batch   → BatchDeleteTasks (body: { ids })
//
// All three require auth, so the commands wire `http.attachOAuth(...)` in
// the CLI bootstrap. The shared helpers below (parseIdsFile, loadTasksFile,
// splitFlagValues) keep the file-based and flag-based input shapes
// interchangeable: `--file tasks.json` may contain a single object that
// fans out into one task, or an array of objects.

import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import chalk from "chalk";
import Table from "cli-table3";
import { HttpClient, AuthError, NotFoundError } from "../http/client.js";
import { InvalidUsageError } from "./boards.js";
import { NotLoggedInError } from "./dashboard.js";
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  type OutputFormat,
  type TaskPriority,
  type TaskRecord,
  type TaskStatus,
} from "./tasks.js";

export interface BatchTaskSpec {
  title?: string;
  description?: string;
  columnId?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  assignee?: string;
  published?: boolean;
  meta?: Record<string, string> | null;
}

export interface BatchCreateResult {
  apiUrl: string;
  created: number;
  failed: number;
  tasks: { id?: string; title?: string }[];
  errors: string[];
}

export interface BatchUpdateResult {
  apiUrl: string;
  ids: string[];
  updated: number;
  failed: number;
  errors: string[];
}

export interface BatchDeleteResult {
  apiUrl: string;
  ids: string[];
  deleted: number;
  failed: number;
  errors: string[];
}

export interface RunTasksBatchCreateOptions {
  apiUrl: string;
  tasks: BatchTaskSpec[];
  format?: OutputFormat;
  io?: {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  };
  http: HttpClient;
}

export interface RunTasksBatchUpdateOptions {
  apiUrl: string;
  ids: string[];
  columnId?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  assignee?: string;
  format?: OutputFormat;
  io?: {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  };
  http: HttpClient;
}

export interface RunTasksBatchDeleteOptions {
  apiUrl: string;
  ids: string[];
  yes?: boolean;
  format?: OutputFormat;
  io?: {
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  };
  http: HttpClient;
}

// splitFlagValues collects repeated --flag invocations into an array.
// Commander invokes the parser once per occurrence with the previous
// accumulator as the second argument, so we just concat.
export function splitFlagValues(
  current: string | string[] | undefined
): string[] {
  if (current === undefined) return [];
  if (Array.isArray(current)) return current;
  return [current];
}

// parseIdsFile reads a UTF-8 text file and splits it into ids, skipping
// blank lines and `# ...` comments. Useful for
// `kanban tasks batch delete --file ids.txt`.
export async function parseIdsFile(path: string): Promise<string[]> {
  const text = await readFile(path, "utf8");
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    out.push(line);
  }
  return out;
}

// loadTasksFile reads a JSON or YAML file describing one task or a list
// of tasks. JSON is detected first (presence of `{` or `[`); otherwise
// the content is parsed as YAML. A single object is normalised to a
// one-element array so callers always receive BatchTaskSpec[].
export async function loadTasksFile(
  path: string
): Promise<BatchTaskSpec[]> {
  const text = await readFile(path, "utf8");
  if (!text.trim()) {
    throw new InvalidUsageError(`task file is empty: ${path}`);
  }
  let parsed: unknown;
  if (text.trimStart().startsWith("{") || text.trimStart().startsWith("[")) {
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new InvalidUsageError(
        `failed to parse JSON from ${path}: ${(err as Error).message}`
      );
    }
  } else {
    try {
      parsed = parseYaml(text);
    } catch (err) {
      throw new InvalidUsageError(
        `failed to parse YAML from ${path}: ${(err as Error).message}`
      );
    }
  }
  return normalizeTaskList(parsed, path);
}

function normalizeTaskList(
  parsed: unknown,
  path: string
): BatchTaskSpec[] {
  let arr: unknown[];
  if (Array.isArray(parsed)) {
    arr = parsed;
  } else if (parsed && typeof parsed === "object") {
    arr = [parsed];
  } else {
    throw new InvalidUsageError(
      `expected an object or array of objects in ${path}, got ${typeof parsed}`
    );
  }
  if (arr.length === 0) {
    throw new InvalidUsageError(`task list is empty in ${path}`);
  }
  return arr.map((item, i) => normalizeTask(item, i, path));
}

function normalizeTask(
  raw: unknown,
  index: number,
  path: string
): BatchTaskSpec {
  if (!raw || typeof raw !== "object") {
    throw new InvalidUsageError(
      `task at index ${index} in ${path} must be an object`
    );
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.title !== "string" || !obj.title.trim()) {
    throw new InvalidUsageError(
      `task at index ${index} in ${path} is missing a non-empty "title"`
    );
  }
  const spec: BatchTaskSpec = {
    title: obj.title.trim(),
  };
  if (typeof obj.description === "string") spec.description = obj.description;
  if (typeof obj.columnId === "string") spec.columnId = obj.columnId;
  if (typeof obj.priority === "string") {
    spec.priority = normalizePriority(obj.priority, index, path);
  }
  if (typeof obj.assignee === "string") spec.assignee = obj.assignee;
  if (typeof obj.status === "string") {
    spec.status = normalizeStatus(obj.status, index, path);
  }
  if (typeof obj.published === "boolean") spec.published = obj.published;
  if (obj.meta && typeof obj.meta === "object" && !Array.isArray(obj.meta)) {
    spec.meta = obj.meta as Record<string, string>;
  }
  return spec;
}

function normalizePriority(
  value: string,
  index: number,
  path: string
): TaskPriority {
  const t = value.trim();
  if (!TASK_PRIORITIES.includes(t as TaskPriority)) {
    throw new InvalidUsageError(
      `task at index ${index} in ${path} has invalid priority "${value}"`
    );
  }
  return t as TaskPriority;
}

function normalizeStatus(
  value: string,
  index: number,
  path: string
): TaskStatus {
  const t = value.trim();
  if (!TASK_STATUSES.includes(t as TaskStatus)) {
    throw new InvalidUsageError(
      `task at index ${index} in ${path} has invalid status "${value}"`
    );
  }
  return t as TaskStatus;
}

// alignFlagTasks merges the parallel arrays produced by repeated
// --title / --column / --description / --priority / --assignee / --status
// flags into a BatchTaskSpec[]. Missing fields fall back to `undefined`,
// which the backend treats as "leave unchanged".
export function alignFlagTasks(parts: {
  titles: string[];
  columns: string[];
  descriptions: string[];
  priorities: string[];
  assignees: string[];
  statuses: string[];
  publisheds: boolean[];
}): BatchTaskSpec[] {
  const len = Math.max(
    parts.titles.length,
    parts.columns.length,
    parts.descriptions.length,
    parts.priorities.length,
    parts.assignees.length,
    parts.statuses.length,
    parts.publisheds.length
  );
  if (len === 0) return [];
  const out: BatchTaskSpec[] = [];
  for (let i = 0; i < len; i++) {
    const spec: BatchTaskSpec = {};
    const title = parts.titles[i];
    if (title !== undefined) spec.title = title;
    const col = parts.columns[i];
    if (col !== undefined) spec.columnId = col;
    const desc = parts.descriptions[i];
    if (desc !== undefined) spec.description = desc;
    const pri = parts.priorities[i];
    if (pri !== undefined) spec.priority = validatePriority(pri);
    const asg = parts.assignees[i];
    if (asg !== undefined) spec.assignee = asg;
    const stat = parts.statuses[i];
    if (stat !== undefined) spec.status = validateStatus(stat);
    const pub = parts.publisheds[i];
    if (pub !== undefined) spec.published = pub;
    if (!spec.title || !spec.title.trim()) {
      throw new InvalidUsageError(
        `task at index ${i} is missing a non-empty --title`
      );
    }
    spec.title = spec.title.trim();
    out.push(spec);
  }
  return out;
}

function validatePriority(value: string): TaskPriority {
  const t = value.trim();
  if (!TASK_PRIORITIES.includes(t as TaskPriority)) {
    throw new InvalidUsageError(
      `invalid --priority value: ${value} (allowed: ${TASK_PRIORITIES.join(", ")})`
    );
  }
  return t as TaskPriority;
}

function validateStatus(value: string): TaskStatus {
  const t = value.trim();
  if (!TASK_STATUSES.includes(t as TaskStatus)) {
    throw new InvalidUsageError(
      `invalid --status value: ${value} (allowed: ${TASK_STATUSES.join(", ")})`
    );
  }
  return t as TaskStatus;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

// runTasksBatchCreate POSTs { tasks: [...] } to /api/v1/tasks/batch and
// prints a summary. Each spec carries a title; columnId (or status+board)
// is resolved by the server. Validation lives in `validateSpecs`.
export async function runTasksBatchCreate(
  opts: RunTasksBatchCreateOptions
): Promise<BatchCreateResult> {
  const stderr = opts.io?.stderr ?? process.stderr;
  const stdout = opts.io?.stdout ?? process.stdout;
  const apiUrl = stripTrailingSlash(opts.apiUrl);
  const format: OutputFormat = opts.format ?? "table";

  validateSpecs(opts.tasks);

  let result: { created?: number; failed?: number; tasks?: { id?: string; title?: string }[]; errors?: string[] };
  try {
    result = await opts.http.apiPost("/api/v1/tasks/batch", {
      tasks: serializeSpecs(opts.tasks),
    });
  } catch (err) {
    if (err instanceof NotFoundError) {
      stderr.write(chalk.red("batch create failed: column not found\n"));
    }
    throw await mapAuthError(err, stderr);
  }

  const report: BatchCreateResult = {
    apiUrl,
    created: result.created ?? 0,
    failed: result.failed ?? 0,
    tasks: Array.isArray(result.tasks) ? result.tasks : [],
    errors: Array.isArray(result.errors) ? result.errors : [],
  };
  if (format === "json") {
    stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    stdout.write(formatBatchCreateTable(report) + "\n");
  }
  return report;
}

function validateSpecs(specs: BatchTaskSpec[]): void {
  if (!Array.isArray(specs) || specs.length === 0) {
    throw new InvalidUsageError(
      "kanban tasks batch create requires at least one task (use --title/--column, --file, or repeated flags)"
    );
  }
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i];
    if (!s.title || !s.title.trim()) {
      throw new InvalidUsageError(
        `task at index ${i} is missing a non-empty --title`
      );
    }
    if (s.priority && !TASK_PRIORITIES.includes(s.priority)) {
      throw new InvalidUsageError(
        `task at index ${i} has invalid --priority "${s.priority}"`
      );
    }
    if (s.status && !TASK_STATUSES.includes(s.status)) {
      throw new InvalidUsageError(
        `task at index ${i} has invalid --status "${s.status}"`
      );
    }
  }
}

function serializeSpecs(specs: BatchTaskSpec[]): Record<string, unknown>[] {
  return specs.map((s) => {
    const body: Record<string, unknown> = {
      title: s.title!.trim(),
      priority: s.priority ?? "medium",
      published: s.published ?? true,
    };
    if (s.columnId !== undefined) body.columnId = s.columnId;
    if (s.description !== undefined) body.description = s.description;
    if (s.assignee !== undefined) body.assignee = s.assignee;
    if (s.meta !== undefined) body.meta = s.meta;
    return body;
  });
}

function formatBatchCreateTable(r: BatchCreateResult): string {
  const lines: string[] = [];
  lines.push(`${chalk.bold("Batch create")}  ${chalk.cyan(r.apiUrl)}`);
  lines.push(`  ${chalk.green(`created: ${r.created}`)}  ${r.failed > 0 ? chalk.red(`failed: ${r.failed}`) : "failed: 0"}`);
  if (r.tasks.length > 0) {
    const table = new Table({
      head: ["id", "title"].map((f) => chalk.bold(f)),
      style: { head: [], border: [] },
    });
    for (const t of r.tasks) {
      table.push([t.id ?? "", t.title ?? ""]);
    }
    lines.push(table.toString());
  }
  if (r.errors.length > 0) {
    lines.push(chalk.red("  errors:"));
    for (const e of r.errors) lines.push(`    - ${e}`);
  }
  return lines.join("\n");
}

// runTasksBatchUpdate PUTs the supplied ids + patch fields to
// /api/v1/tasks/batch. At least one of --column / --status /
// --priority / --assignee is required.
export async function runTasksBatchUpdate(
  opts: RunTasksBatchUpdateOptions
): Promise<BatchUpdateResult> {
  const stderr = opts.io?.stderr ?? process.stderr;
  const stdout = opts.io?.stdout ?? process.stdout;
  const apiUrl = stripTrailingSlash(opts.apiUrl);
  const format: OutputFormat = opts.format ?? "table";

  const ids = normalizeIds(opts.ids);
  if (ids.length === 0) {
    throw new InvalidUsageError(
      "kanban tasks batch update requires at least one task id"
    );
  }
  if (opts.columnId && opts.status) {
    throw new InvalidUsageError(
      "kanban tasks batch update accepts only one of --column or --status, not both"
    );
  }
  if (
    !opts.columnId &&
    !opts.status &&
    !opts.priority &&
    opts.assignee === undefined
  ) {
    throw new InvalidUsageError(
      "kanban tasks batch update requires at least one of --column / --status / --priority / --assignee"
    );
  }
  if (opts.priority && !TASK_PRIORITIES.includes(opts.priority)) {
    throw new InvalidUsageError(
      `invalid --priority value: ${opts.priority} (allowed: ${TASK_PRIORITIES.join(", ")})`
    );
  }
  if (opts.status && !TASK_STATUSES.includes(opts.status)) {
    throw new InvalidUsageError(
      `invalid --status value: ${opts.status} (allowed: ${TASK_STATUSES.join(", ")})`
    );
  }

  const body: Record<string, unknown> = { ids };
  if (opts.columnId) body.columnId = opts.columnId;
  if (opts.status) body.status = opts.status;
  if (opts.priority) body.priority = opts.priority;
  if (opts.assignee !== undefined) body.assignee = opts.assignee;

  let result: { updated?: number; failed?: number; errors?: string[] };
  try {
    result = await opts.http.apiPut("/api/v1/tasks/batch", body);
  } catch (err) {
    if (err instanceof NotFoundError) {
      stderr.write(chalk.red("batch update failed: column not found\n"));
    }
    throw await mapAuthError(err, stderr);
  }

  const report: BatchUpdateResult = {
    apiUrl,
    ids,
    updated: result.updated ?? 0,
    failed: result.failed ?? 0,
    errors: Array.isArray(result.errors) ? result.errors : [],
  };
  if (format === "json") {
    stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    stdout.write(formatBatchUpdateTable(report) + "\n");
  }
  return report;
}

function formatBatchUpdateTable(r: BatchUpdateResult): string {
  const lines: string[] = [];
  lines.push(`${chalk.bold("Batch update")}  ${chalk.cyan(r.apiUrl)}`);
  lines.push(
    `  ids: ${r.ids.join(", ")}\n  ${chalk.green(`updated: ${r.updated}`)}  ${r.failed > 0 ? chalk.red(`failed: ${r.failed}`) : "failed: 0"}`
  );
  if (r.errors.length > 0) {
    lines.push(chalk.red("  errors:"));
    for (const e of r.errors) lines.push(`    - ${e}`);
  }
  return lines.join("\n");
}

// runTasksBatchDelete DELETEs { ids } against /api/v1/tasks/batch.
// The default is to skip the confirmation prompt so the command works
// in shell pipelines; --no-yes would currently fall back to the same
// behaviour because the task description mandates "默认有 --yes 跳过确认".
export async function runTasksBatchDelete(
  opts: RunTasksBatchDeleteOptions
): Promise<BatchDeleteResult> {
  const stderr = opts.io?.stderr ?? process.stderr;
  const stdout = opts.io?.stdout ?? process.stdout;
  const apiUrl = stripTrailingSlash(opts.apiUrl);
  const format: OutputFormat = opts.format ?? "table";

  const ids = normalizeIds(opts.ids);
  if (ids.length === 0) {
    throw new InvalidUsageError(
      "kanban tasks batch delete requires at least one task id"
    );
  }

  let result: { deleted?: number; failed?: number; errors?: string[] };
  try {
    result = await opts.http.apiDelete("/api/v1/tasks/batch", { ids });
  } catch (err) {
    if (err instanceof NotFoundError) {
      stderr.write(chalk.red("batch delete failed: target column not found\n"));
    }
    throw await mapAuthError(err, stderr);
  }

  const report: BatchDeleteResult = {
    apiUrl,
    ids,
    deleted: result.deleted ?? 0,
    failed: result.failed ?? 0,
    errors: Array.isArray(result.errors) ? result.errors : [],
  };
  if (format === "json") {
    stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    stdout.write(formatBatchDeleteTable(report) + "\n");
  }
  return report;
}

function formatBatchDeleteTable(r: BatchDeleteResult): string {
  const lines: string[] = [];
  lines.push(`${chalk.bold("Batch delete")}  ${chalk.cyan(r.apiUrl)}`);
  lines.push(
    `  ids: ${r.ids.join(", ")}\n  ${chalk.green(`deleted: ${r.deleted}`)}  ${r.failed > 0 ? chalk.red(`failed: ${r.failed}`) : "failed: 0"}`
  );
  if (r.errors.length > 0) {
    lines.push(chalk.red("  errors:"));
    for (const e of r.errors) lines.push(`    - ${e}`);
  }
  return lines.join("\n");
}

function normalizeIds(ids: string[]): string[] {
  if (!Array.isArray(ids)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string") continue;
    const t = id.trim();
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

async function mapAuthError(
  err: unknown,
  stderr?: NodeJS.WritableStream
): Promise<never> {
  if (err instanceof AuthError) {
    stderr?.write(chalk.red("Not logged in. Run 'kanban auth login' first.\n"));
    throw new NotLoggedInError(err.message);
  }
  throw err as Error;
}

// re-export the underlying types for the CLI bootstrap / test files.
export type { TaskRecord, TaskStatus, TaskPriority };
