// Shared helpers for rendering the `activities.details` field.
//
// Background (s-1260 PM review s-1258 P1-2): the backend persists a
// pre-formatted English (or Chinese) sentence into `details` whenever
// a task changes status / position / assignee / owner. The frontend
// used to render the raw string verbatim, so the activity log mixed
// English (`Status: 'in_progress' → 'review'`) and Chinese (`状态:
// 'todo' → 'in_progress'`) sentences on a single page, with the
// language depending on which handler wrote the row.
//
// `localizeActivityDetails` parses the handful of well-known shapes
// the backend emits and rewrites them through i18next. Anything we
// don't recognise falls back to the raw string so we never lose
// information; a future handler that introduces a new shape just
// needs to add a regex + translation key here.

interface Translator {
  (key: string, opts?: Record<string, unknown>): string;
}

const STATUS_VALUES = new Set(['todo', 'in_progress', 'testing', 'review', 'done']);

/**
 * Parse the legacy `Status: 'X' → 'Y'` / `状态: 'X' → 'Y'` format the
 * status-change handler writes, and return the translated version with
 * each enum mapped through `settings.activities.details.statusLabel`.
 *
 * Returns `null` when the string does not match or when the i18n
 * table is missing the entry — callers fall back to rendering the
 * raw value so the UI never leaks a dotted translation key.
 */
function tryParseStatusFromTo(text: string, t: Translator): string | null {
  const match = text.match(/^[\s]*(?:Status|状态)\s*[:：]\s*'([^']+)'\s*→\s*'([^']+)'/);
  if (!match) return null;
  const [, fromRaw, toRaw] = match;
  const fromLabel = STATUS_VALUES.has(fromRaw)
    ? t('settings.activities.details.statusLabel.' + fromRaw)
    : fromRaw;
  const toLabel = STATUS_VALUES.has(toRaw)
    ? t('settings.activities.details.statusLabel.' + toRaw)
    : toRaw;
  const template = t('settings.activities.details.statusFromTo', { from: fromLabel, to: toLabel });
  // Bail out when the i18n bundle has none of the keys we need —
  // t returns the dotted key as-is in that case, and surfacing a
  // "settings.activities.…" string would be the exact bug the PM
  // review flagged (P0-1). Returning null lets the raw value
  // win so the row stays readable.
  if (template.startsWith('settings.activities.details.')) return null;
  return template;
}

/**
 * Parse the legacy `位置: 'X' → 'Y'` / `Position: 'X' → 'Y'` shape and
 * return the translated version. Same fallback rules as the status
 * parser: if the position template key is missing, return null so
 * the raw sentence wins.
 */
function tryParsePositionFromTo(text: string, t: Translator): string | null {
  const match = text.match(/^[\s]*(?:Position|位置)\s*[:：]\s*'([^']+)'\s*→\s*'([^']+)'/);
  if (!match) return null;
  const [, fromRaw, toRaw] = match;
  const template = t('settings.activities.details.positionFromTo', { from: fromRaw, to: toRaw });
  if (template.startsWith('settings.activities.details.')) return null;
  return template;
}

/**
 * Parse the `Reordered N tasks` / `已重排 N 个任务` shape that the
 * bulk reorder handler writes.
 */
function tryParseReordered(text: string, t: Translator): string | null {
  const match = text.match(/^(?:Reordered|已重排)\s+(\d+)\s+(?:tasks|个任务)$/);
  if (!match) return null;
  const template = t('settings.activities.details.reordered', { count: Number(match[1]) });
  if (template.startsWith('settings.activities.details.')) return null;
  return template;
}

/**
 * Best-effort translation for an activity row's `details` field.
 * Returns the original `details` value when nothing in the sentence
 * matches a known shape so unknown formats stay readable.
 */
export function localizeActivityDetails(details: string | undefined, t: Translator): string {
  if (!details) return '';
  const parsed =
    tryParseStatusFromTo(details, t) ??
    tryParsePositionFromTo(details, t) ??
    tryParseReordered(details, t);
  return parsed ?? details;
}