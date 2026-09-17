// Table renderers backed by `cli-table3`.
//
// Every command previously declared its own `format<Thing>Table` function,
// each one ~30 lines of `new Table({ head: [...], style: {...} })` +
// `lines.push(...)`. This module collapses those skeletons into two
// reusable renderers: `renderListTable` (rows × columns) and
// `renderRecordTable` (one bold-label row per field).
//
// Both take a `palette` from `color.ts` so the colour decision lives in one
// place and table rendering never touches `chalk` directly.

import Table from "cli-table3";
import type { ColorPalette } from "./color.js";

export interface ListRenderArgs<Row> {
  title: string;
  apiUrl: string;
  subtitle?: string;
  emptyMessage?: string;
  fields: readonly string[];
  rows: readonly Row[];
  renderField: (row: Row, field: string) => string;
  labelFor?: (field: string) => string;
  palette: ColorPalette;
}

/**
 * Render a `<title>  <apiUrl>[  <subtitle>]` header followed by either an
 * empty-state placeholder or a `cli-table3` grid.
 */
export function renderListTable<Row>(args: ListRenderArgs<Row>): string {
  const palette = args.palette;
  const header =
    `${palette.bold(args.title)}  ${palette.cyan(args.apiUrl)}` +
    (args.subtitle ? `  ${palette.gray(args.subtitle)}` : "");
  if (args.rows.length === 0) {
    const empty = args.emptyMessage ?? `(no ${args.title.toLowerCase()})`;
    return [header, palette.gray(`  ${empty}`)].join("\n");
  }
  const labelFor = args.labelFor ?? defaultLabelFor;
  const table = new Table({
    head: args.fields.map((f) => palette.bold(labelFor(f))),
    style: { head: [], border: [] },
  });
  for (const row of args.rows) {
    table.push(args.fields.map((f) => args.renderField(row, f)));
  }
  return [header, table.toString()].join("\n");
}

export interface RecordRenderArgs {
  title: string;
  apiUrl: string;
  fields: readonly string[];
  values: Record<string, unknown>;
  renderField: (key: string, value: unknown) => string;
  labelFor?: (field: string) => string;
  palette: ColorPalette;
}

/**
 * Render a `<title>  <apiUrl>` header followed by one bold-label row per
 * field, e.g.
 *
 *     Board   http://localhost:8080
 *       id: b1
 *       name: Alpha
 */
export function renderRecordTable(args: RecordRenderArgs): string {
  const palette = args.palette;
  const labelFor = args.labelFor ?? defaultLabelFor;
  const header = `${palette.bold(args.title)}  ${palette.cyan(args.apiUrl)}`;
  const lines = args.fields.map(
    (f) => `  ${palette.bold(labelFor(f))}: ${args.renderField(f, args.values[f])}`
  );
  return [header, ...lines].join("\n");
}

/**
 * Default field-label function: pass through the raw field name. Commands
 * that need singularisation (columnCount → columns) supply their own.
 */
export function defaultLabelFor(field: string): string {
  return field;
}

/**
 * Build a field-label function from a rename map. Lookup order:
 *
 *   1. `renames[field]` — exact rename (columnCount → "columns").
 *   2. otherwise the raw field name.
 *
 * Unknown fields get a pass-through so future additions don't crash.
 */
export function makeLabelFor(renames: Record<string, string> = {}): (field: string) => string {
  return (field) => renames[field] ?? field;
}