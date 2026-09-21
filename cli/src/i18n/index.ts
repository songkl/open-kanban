// Internationalisation (i18n) for the Open Kanban CLI.
//
// The CLI ships with two locales today: English (default) and Simplified
// Chinese. The active locale is resolved in this priority order:
//
//   1. `setLocale(...)` — explicit override set by the bootstrap layer
//      when the user passes `--lang` on the command line. Tests use this
//      to flip between locales deterministically.
//   2. `KANBAN_LANG` environment variable — the operator-friendly
//      override that mirrors the other `KANBAN_*` config env vars
//      (KANBAN_API_URL, KANBAN_CLI_PROFILE, …).
//   3. `LC_ALL` then `LANG` — the standard POSIX variables that describe
//      the user's bash / login environment. We honour them so a Chinese
//      shell session (`LANG=zh_CN.UTF-8`) automatically sees Chinese CLI
//      output without any extra configuration.
//   4. `"en"` — built-in fallback.
//
// Translation lookups go through `t(key, vars?)`. Missing keys fall back
// to the English table so the CLI never silently prints the raw key, then
// to the literal key text as a last resort. Variable interpolation uses
// `{{name}}` placeholders. Unknown variables stay verbatim so a missing
// translation or typo is easy to spot in the output.
//
// Keeping the dictionaries in sibling files (`./messages/en.ts` and
// `./messages/zh.ts`) means future locales (`ja`, `ko`, …) can be added
// by dropping one file plus a `SUPPORTED_LOCALES` entry — no edits to
// the translation engine itself.

import { en } from "./messages/en.js";
import { zh } from "./messages/zh.js";

export type SupportedLocale = "en" | "zh";

export const SUPPORTED_LOCALES: readonly SupportedLocale[] = ["en", "zh"] as const;
export const DEFAULT_LOCALE: SupportedLocale = "en";

export type MessageKey = keyof typeof en;
export type MessageDictionary = Partial<Record<MessageKey, string>> &
  Record<string, string | undefined>;

/**
 * Configure an explicit locale. Pass `undefined` to clear the override
 * and re-derive the locale from the environment (useful in tests).
 */
let explicitLocale: SupportedLocale | undefined;

/**
 * The last locale we resolved through environment detection. Kept around
 * so `getLocale()` can return a sensible value when `setLocale()` was
 * never called — without re-running detection (and re-reading
 * `process.env`) on every translation call.
 */
let resolvedFromEnv: SupportedLocale = detectLocaleFromEnv();

export function setLocale(locale: SupportedLocale | undefined): void {
  if (locale === undefined) {
    explicitLocale = undefined;
    return;
  }
  if (!SUPPORTED_LOCALES.includes(locale)) {
    throw new InvalidLocaleError(locale);
  }
  explicitLocale = locale;
}

export function getLocale(): SupportedLocale {
  return explicitLocale ?? resolvedFromEnv;
}

/**
 * Resolve the locale from a snapshot of environment variables. `env`
 * defaults to `process.env`; tests pass an explicit object so the
 * resolution is deterministic.
 */
export function detectLocaleFromEnv(env: Record<string, string | undefined> = process.env): SupportedLocale {
  const sources = [env.KANBAN_LANG, env.LC_ALL, env.LANG];
  for (const raw of sources) {
    const found = matchLocale(raw);
    if (found) return found;
  }
  return DEFAULT_LOCALE;
}

/**
 * Re-derive the environment-driven locale and discard any stale cached
 * value. Useful for tests that mutate `process.env` and want `getLocale`
 * to reflect the change without going through `setLocale`.
 */
export function resetLocaleCache(): void {
  resolvedFromEnv = detectLocaleFromEnv();
  explicitLocale = undefined;
}

/**
 * Translate `key` using the active locale. `vars` is an optional object
 * whose entries replace `{{name}}` placeholders in the resolved string.
 * Falls back to English, then to the key itself, so a missing
 * translation never crashes the CLI.
 */
export function t(key: MessageKey | string, vars?: Record<string, string | number>): string {
  const dict = activeDictionary();
  const raw = (dict[key] ?? en[key as MessageKey] ?? key) as string;
  return interpolate(raw, vars);
}

/**
 * Plural-form helper. Currently fixed to one form per locale (Chinese
 * has no plural distinction, English uses the supplied `other`) but
 * exposed so future locales (e.g. Russian) can plug in `Intl.PluralRules`
 * without rewriting every call site.
 */
export function tn(key: MessageKey | string, vars?: Record<string, string | number>): string {
  return t(key, vars);
}

function activeDictionary(): MessageDictionary {
  const locale = getLocale();
  switch (locale) {
    case "zh":
      return zh as MessageDictionary;
    case "en":
    default:
      return en as MessageDictionary;
  }
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, name: string) => {
    const v = vars[name];
    return v === undefined || v === null ? "" : String(v);
  });
}

/**
 * Normalise a POSIX locale tag (`zh_CN.UTF-8`, `en-US`, `c`, ...) to one
 * of our `SupportedLocale` values. Returns `null` for empty / unknown
 * tags so callers can keep probing the next source.
 */
function matchLocale(raw: string | undefined): SupportedLocale | null {
  if (!raw) return null;
  const tag = raw.trim();
  if (!tag || tag === "C" || tag === "POSIX") return null;
  const lower = tag.toLowerCase();
  if (lower.startsWith("zh")) return "zh";
  if (lower.startsWith("en")) return "en";
  return null;
}

/**
 * Thrown when a caller hands `setLocale` a tag we don't ship support for.
 * Surfacing this as a typed error (rather than silently coercing) keeps
 * `kanban auth login --lang=fr` from printing a partial-French UI when
 * French translations don't exist.
 */
export class InvalidLocaleError extends Error {
  constructor(public readonly locale: string) {
    super(`unsupported locale: ${locale} (supported: ${SUPPORTED_LOCALES.join(", ")})`);
    this.name = "InvalidLocaleError";
  }
}

/**
 * `parseLangFlag` converts the raw `--lang` value (or the value of the
 * `KANBAN_LANG` env var) into a `SupportedLocale`. Accepts both the full
 * tag (`zh-CN`, `en_US.UTF-8`) and the short form (`zh`, `en`). Empty /
 * unrecognised values fall back to `undefined`, which the bootstrap
 * layer treats as "let env detection win".
 */
export function parseLangFlag(value: string | undefined): SupportedLocale | undefined {
  if (!value) return undefined;
  const tag = value.trim();
  if (!tag) return undefined;
  const lower = tag.toLowerCase();
  if (lower === "zh" || lower.startsWith("zh-") || lower.startsWith("zh_")) return "zh";
  if (lower === "en" || lower.startsWith("en-") || lower.startsWith("en_")) return "en";
  return undefined;
}
