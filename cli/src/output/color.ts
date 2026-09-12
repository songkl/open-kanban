// Color helpers for the CLI.
//
// We respect two ways of asking for plain output:
//   * `NO_COLOR` environment variable (any non-empty value disables color)
//   * `--no-color` / `--color=false` command-line flag
//   * non-TTY stdout (piped output should never emit ANSI escapes)
//
// All color is centralized here so a future refactor can swap palettes
// (e.g. force-256-color) or strip more aggressively without touching every
// command file. Today the helpers are tiny wrappers around `chalk`; they
// exist primarily to give us a single seam to override and to make the
// "should we colorize?" decision explicit and testable.

import chalk, { Chalk } from "chalk";

// Re-export the `Chalk` constructor type so callers can stamp out
// forced-level instances without reaching into chalk internals.
export type { Chalk };

export type ColorLevel = "on" | "off";

export interface ColorOptions {
  /** Override: explicit user preference via CLI flag (highest priority). */
  forced?: ColorLevel;
  /** Stream we are about to write to. Non-TTY streams disable color. */
  stream?: NodeJS.WritableStream;
  /** Environment snapshot (defaults to `process.env`). Tests pass an empty object. */
  env?: Record<string, string | undefined>;
}

const FORCE_OFF_VALUES = new Set(["0", "false", "no", "off"]);
const FORCE_ON_VALUES = new Set(["1", "true", "yes", "on"]);

/**
 * Decide whether ANSI color escapes should be emitted.
 *
 * Resolution order:
 *   1. `forced` option wins (--no-color / --color).
 *   2. `FORCE_COLOR` / `NO_COLOR` environment variables (any non-empty value).
 *   3. `stream.isTTY` — when false, color is off (piped output is unreadable with escapes).
 */
export function resolveColorLevel(opts: ColorOptions = {}): ColorLevel {
  const forced = opts.forced;
  if (forced) return forced;
  const env = opts.env ?? process.env;
  const forceColor = env.FORCE_COLOR;
  if (forceColor !== undefined && forceColor !== "") {
    return FORCE_OFF_VALUES.has(forceColor.toLowerCase()) ? "off" : "on";
  }
  const noColor = env.NO_COLOR;
  if (noColor !== undefined && noColor !== "") return "off";
  const stream = opts.stream ?? process.stdout;
  // chalk exposes an isTTY flag on its internal supportsColor; we approximate
  // it by checking the stream directly so tests can stub it.
  const tty = (stream as NodeJS.WriteStream).isTTY;
  return tty ? "on" : "off";
}

export interface ColorPalette {
  level: ColorLevel;
  bold: (s: string) => string;
  cyan: (s: string) => string;
  gray: (s: string) => string;
  red: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  dim: (s: string) => string;
}

/**
 * Build a frozen palette. When `level === "off"` every entry returns the
 * input string verbatim so the rest of the codebase can call `palette.bold(...)`
 * without conditionals. When `level === "on"` and the caller is writing to
 * a non-TTY stream (piped output), we use a fresh `Chalk` instance with
 * a forced level so ANSI escapes are still emitted — without that, `chalk`
 * silently degrades to plain text whenever stdout isn't a terminal.
 */
export function createPalette(opts: ColorOptions = {}): ColorPalette {
  const level = resolveColorLevel(opts);
  if (level === "off") {
    const passthrough = (s: string): string => s;
    return {
      level,
      bold: passthrough,
      cyan: passthrough,
      gray: passthrough,
      red: passthrough,
      green: passthrough,
      yellow: passthrough,
      dim: passthrough,
    };
  }
  // When the caller explicitly asks for color (forced=on) but chalk
  // auto-detected no support (e.g. piped stdout), build a fresh instance
  // with level=1 to override. Otherwise reuse the default `chalk`.
  type ChalkLike = {
    bold: (s: string) => string;
    cyan: (s: string) => string;
    gray: (s: string) => string;
    red: (s: string) => string;
    green: (s: string) => string;
    yellow: (s: string) => string;
    dim: (s: string) => string;
  };
  const c: ChalkLike =
    opts.forced === "on" && !chalk.level
      ? (new Chalk({ level: 1 }) as unknown as ChalkLike)
      : (chalk as unknown as ChalkLike);
  return {
    level,
    bold: (s) => c.bold(s),
    cyan: (s) => c.cyan(s),
    gray: (s) => c.gray(s),
    red: (s) => c.red(s),
    green: (s) => c.green(s),
    yellow: (s) => c.yellow(s),
    dim: (s) => c.dim(s),
  };
}

/**
 * Parse the raw `--color` flag value. Commander surfaces `false` for
 * `--no-color` (the flag becomes the negation `color`, which defaults to
 * `true` when omitted and flips to `false` when `--no-color` is set) and
 * the raw string for `--color <mode>`.
 */
export function parseColorFlag(value: unknown): ColorLevel | undefined {
  if (value === true) return "on";
  if (value === false) return "off";
  if (typeof value !== "string") return undefined;
  const lower = value.trim().toLowerCase();
  if (FORCE_OFF_VALUES.has(lower)) return "off";
  if (FORCE_ON_VALUES.has(lower)) return "on";
  if (lower === "auto") return undefined;
  return undefined;
}