// Output primitives shared by every command file.
//
// Three responsibilities live here:
//   * The `OutputFormat` discriminated type and its dispatch helper.
//   * The JSON / table tail that ends every command (was duplicated 11×).
//   * Tiny utility helpers (stripTrailingSlash, normalizeFields, isTTY)
//     that were also copy-pasted across command files.
//
// The module is deliberately framework-free: no Commander, no HttpClient.
// It depends on chalk + cli-table3 via the sibling `color.ts` and
// `table.ts` modules so each piece can be unit-tested in isolation.

import { stringify as stringifyYaml } from "yaml";
import type { ColorPalette } from "./color.js";
import { createPalette } from "./color.js";
import { renderListTable, renderRecordTable } from "./table.js";
import { getColorOverride } from "../config.js";

export type OutputFormat = "table" | "json" | "yaml";

export const DEFAULT_OUTPUT_FORMAT: OutputFormat = "table";

/**
 * Resolve a free-form `--output` string into the discriminated union.
 * Commander passes through unknown values verbatim, so we coerce them here
 * instead of letting `=== "json"` checks silently misfire.
 */
export function resolveOutputFormat(value: unknown): OutputFormat {
  if (typeof value !== "string") return DEFAULT_OUTPUT_FORMAT;
  const v = value.trim().toLowerCase();
  if (v === "json") return "json";
  if (v === "yaml" || v === "yml") return "yaml";
  if (v === "table" || v === "") return "table";
  return DEFAULT_OUTPUT_FORMAT;
}

export interface IoStreams {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

export interface CommandContext {
  apiUrl: string;
  format: OutputFormat;
  io: IoStreams;
  palette: ColorPalette;
}

/**
 * Resolve the runtime context every command needs: normalised API URL,
 * output format, IO streams (defaulting to process stdio) and the colour
 * palette. Centralising this removes ~30 lines of repeated prologue per
 * command file.
 *
 * The colour palette honours, in order:
 *   1. `opts.colorForced` — explicit per-command override (highest priority)
 *   2. The CLI root's `--no-color` / `--color` flag (read via `getColorOverride()`)
 *   3. NO_COLOR / FORCE_COLOR env vars and TTY detection
 */
export function createContext(opts: {
  apiUrl: string;
  format?: OutputFormat;
  io?: IoStreams;
  colorForced?: "on" | "off";
  colorEnv?: Record<string, string | undefined>;
}): CommandContext {
  const forced = opts.colorForced ?? getColorOverride();
  return {
    apiUrl: stripTrailingSlash(opts.apiUrl),
    format: opts.format ?? DEFAULT_OUTPUT_FORMAT,
    io: {
      stdout: opts.io?.stdout ?? process.stdout,
      stderr: opts.io?.stderr ?? process.stderr,
    },
    palette: createPalette({
      forced,
      stream: opts.io?.stdout,
      env: opts.colorEnv,
    }),
  };
}

/** Strip one or more trailing slashes from an API URL. */
export function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Serialize a value as pretty-printed JSON followed by a newline.
 * Centralised so the trailing newline + 2-space indent rule lives in one
 * place. Throws on cyclic references — callers must pass JSON-safe data.
 */
export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

/**
 * Serialize a value as YAML followed by a newline. Uses the `yaml` package
 * (already a CLI dependency for batch task input parsing) so the round-trip
 * behaviour matches `kanban tasks batch create --file tasks.yaml`. Cycles
 * fall back to a string annotation rather than throwing so a malformed
 * payload never crashes the CLI mid-report.
 */
export function formatYaml(value: unknown): string {
  try {
    return stringifyYaml(value, { indent: 2, lineWidth: 0 }) + "\n";
  } catch {
    // stringifyYaml only throws on cycles and exotic BigInt values;
    // stringify the value instead so the user at least sees *something*.
    try {
      return stringifyYaml(String(value), { indent: 2, lineWidth: 0 }) + "\n";
    } catch {
      return "<unserialisable value>\n";
    }
  }
}

/**
 * Normalise an arbitrary scalar (or `Date`) into a human-friendly cell
 * value. Used by the table renderer when a column does not declare its
 * own renderer.
 *
 *   * null / undefined  → "" (so the table is not littered with "null")
 *   * Date              → ISO string (YYYY-MM-DDTHH:mm:ss.sssZ)
 *   * boolean           → "yes" / "no"
 *   * number / string   → String(value)
 *   * anything else     → JSON.stringify (best effort)
 */
export function defaultCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return "";
    return value.toISOString();
  }
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

/**
 * Project a record to a subset of fields while keeping the field order
 * supplied by `fields`. Unknown field names are silently dropped. The
 * caller is expected to have already validated the field list against
 * a resource-specific allowlist (see `normalizeFields` below).
 */
export function projectFields<T extends Record<string, unknown>>(
  record: T,
  fields: readonly string[]
): Partial<T> {
  const out: Partial<T> = {};
  for (const f of fields) {
    if (f in record) {
      out[f as keyof T] = record[f as keyof T];
    }
  }
  return out;
}

/**
 * Normalise a `--fields` argument (a free-form comma-separated list) into
 * the deduplicated, allowlisted, default-filled form every command needs.
 * Shared between `boards`, `columns`, and any future command that exposes
 * a `--fields` flag.
 *
 *   * `fields` empty / undefined → return `[...defaults]`
 *   * unknown / empty entries → skipped
 *   * duplicates → first occurrence wins
 *   * if nothing survives, fall back to defaults (never return [])
 */
export function normalizeFields(
  fields: string[] | undefined,
  defaults: readonly string[],
  allowed: readonly string[]
): string[] {
  const raw = fields && fields.length > 0 ? fields : [...defaults];
  const allowedSet = new Set<string>(allowed);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of raw) {
    const trimmed = f.trim();
    if (!trimmed) continue;
    if (!allowedSet.has(trimmed)) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out.length > 0 ? out : [...defaults];
}

/**
 * Dispatch the "render this report" tail that every command ended with.
 *
 *   * JSON mode: serialises `report` with `formatJson`.
 *   * YAML mode: serialises `report` with `formatYaml`.
 *   * Table mode: calls `renderTable(report, ctx)` (the caller wires in the
 *     resource-specific renderer).
 *
 * Centralising the dispatch removes the 11× copy-pasted
 * `if (format === "json") { stdout.write(...) } else { stdout.write(...) }`
 * blocks and ensures every command produces the same trailing newline.
 */
export function emitReport<T>(
  report: T,
  ctx: CommandContext,
  renderTable: (report: T, ctx: CommandContext) => string
): void {
  const stdout = ctx.io.stdout!;
  if (ctx.format === "json") {
    stdout.write(formatJson(report));
    return;
  }
  if (ctx.format === "yaml") {
    stdout.write(formatYaml(report));
    return;
  }
  stdout.write(renderTable(report, ctx) + "\n");
}

/**
 * Build the non-table render of a report. Returns the JSON string when
 * `format === "json"`, the YAML string when `format === "yaml"`, and an
 * empty string otherwise (so callers can fall back to their own table
 * rendering). Used by commands that still have bespoke table renderers
 * (`columns`, `tasks`, `workspace`, …) but want yaml/json emission to flow
 * through the same shared formatter.
 */
export function formatStructured<T>(report: T, format: OutputFormat): string {
  if (format === "json") return formatJson(report);
  if (format === "yaml") return formatYaml(report);
  return "";
}

/**
 * Convenience wrapper: emit a list-shaped table for `records`. Equivalent
 * to `emitReport(report, ctx, (r, c) => renderListTable({ rows: r, ... }))`
 * but with the right types and a cleaner call site. The `report` only
 * needs to expose an `apiUrl`.
 */
export interface ListRenderOptions<Row extends Record<string, unknown>> {
  title: string;
  apiUrl: string;
  subtitle?: string;
  emptyMessage?: string;
  fields: readonly string[];
  rows: readonly Row[];
  labelFor?: (field: string) => string;
  renderField: (row: Row, field: string) => string;
  palette: ColorPalette;
}

export function emitListReport<Row extends Record<string, unknown>>(
  report: { apiUrl: string; [k: string]: unknown },
  ctx: CommandContext,
  opts: Omit<ListRenderOptions<Row>, "apiUrl" | "palette">
): void {
  emitReport(report, ctx, (r, c) =>
    renderListTable<Row>({
      title: opts.title,
      apiUrl: r.apiUrl,
      subtitle: opts.subtitle,
      emptyMessage: opts.emptyMessage,
      fields: opts.fields,
      rows: opts.rows,
      labelFor: opts.labelFor,
      renderField: opts.renderField,
      palette: c.palette,
    })
  );
}

/**
 * Convenience wrapper: emit a record-shaped table (one bold-label row per
 * field). The `report` only needs to expose an `apiUrl` — the caller
 * supplies the rendered values directly through `opts.values`.
 */
export interface RecordRenderOptions {
  title: string;
  apiUrl: string;
  fields: readonly string[];
  values: Record<string, unknown>;
  labelFor?: (field: string) => string;
  renderField: (key: string, value: unknown) => string;
  palette: ColorPalette;
}

export function emitRecordReport(
  report: { apiUrl: string; [k: string]: unknown },
  ctx: CommandContext,
  opts: Omit<RecordRenderOptions, "apiUrl" | "palette">
): void {
  emitReport(report, ctx, (r, c) =>
    renderRecordTable({
      title: opts.title,
      apiUrl: r.apiUrl,
      fields: opts.fields,
      values: opts.values,
      labelFor: opts.labelFor,
      renderField: opts.renderField,
      palette: c.palette,
    })
  );
}

/**
 * Write a one-line, stderr-side error message in red. Centralises the
 * `chalk.red("<resource> not found: <id>")` pattern duplicated across
 * boards / tasks / columns.
 */
export function reportNotFound(
  ctx: CommandContext,
  resource: string,
  id: string
): void {
  ctx.io.stderr!.write(`${ctx.palette.red(`${resource} not found: ${id}`)}\n`);
}