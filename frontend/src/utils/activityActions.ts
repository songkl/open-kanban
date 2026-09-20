// Shared helpers for rendering `activities.action` values.
//
// Background (s-1257 PM review P0-1): the activity feed stores a
// stable machine-readable enum (`DEVICE_APPROVE`, `WEBHOOK_TEST`,
// `BULK_PERMISSION_GRANT`, …) but the i18n tables in
// `frontend/src/i18n/locales/*.json` only cover a subset of those
// actions. The previous fallback
//
//   typeof t(`settings.activities.${action}`) === 'string'
//
// was a no-op (`typeof string === 'string'` is always true), so
// any untranslated action leaked the literal key
// (`settings.activities.DEVICE_APPROVE`) into the UI.
//
// `humanizeAction` is the canonical human-readable fallback. It is
// deliberately small and dependency-free so both the Settings tab
// (`ActivitiesSettings`) and the bottom-of-screen marquee
// (`ActivityTicker`) can share it.

const UNDERSCORE_OR_HYPHEN = /[_-]+/g;

/**
 * Convert `DEVICE_APPROVE` / `WEBHOOK_TEST` / `OAUTH_CLIENT_DELETE`
 * into a friendly English label (`Device approve`, `Webhook tested`,
 * `OAuth client deleted`).
 *
 * The output is intentionally Title Case rather than the SCREAMING_CASE
 * the enum stores, because every consumer renders this label inside a
 * sentence and `Last user action was: DEVICE_APPROVE` reads as a bug.
 */
export function humanizeAction(action: string): string {
  if (!action) return '';
  const tokens = action.replace(UNDERSCORE_OR_HYPHEN, ' ').trim().split(/\s+/);
  if (tokens.length === 0) return '';

  // The verb often sits at the end (`DEVICE_APPROVE` → approve,
  // `BULK_PERMISSION_GRANT` → grant) and a few common ones have
  // nicer past-tense forms the feed prefers. Keep the table
  // minimal — anything not listed falls back to the literal token.
  const PAST_TENSE_OVERRIDES: Record<string, string> = {
    CREATE: 'created',
    UPDATE: 'updated',
    DELETE: 'deleted',
    APPROVE: 'approved',
    REGISTER: 'registered',
    REVOKE: 'revoked',
    GRANT: 'granted',
    ROTATE: 'rotated',
    TEST: 'tested',
    ISSUE: 'issued',
  };
  const lower = tokens.map((t) => t.toLowerCase());
  if (lower.length > 1) {
    const last = lower[lower.length - 1];
    if (PAST_TENSE_OVERRIDES[last.toUpperCase()]) {
      lower[lower.length - 1] = PAST_TENSE_OVERRIDES[last.toUpperCase()].toLowerCase();
    }
  }

  return lower
    .map((t) => t.charAt(0).toUpperCase() + t.slice(1))
    .join(' ');
}

/**
 * Resolve a user-facing label for an `activity.action` value using
 * the i18n table + the `humanizeAction` fallback.
 *
 * - `t(key)` returns the translated string when the key exists.
 * - `i18n.exists(key)` is the official i18next signal for "key
 *   missing", and crucially it returns `false` when the key is
 *   present but maps to an empty string — which is what we want so
 *   an empty translation doesn't leak.
 */
export function resolveActivityActionLabel(
  action: string,
  t: (key: string) => string,
  i18n: { exists: (key: string) => boolean },
): string {
  const key = `settings.activities.${action}`;
  if (i18n.exists(key)) {
    const translated = t(key);
    if (translated) return translated;
  }
  return humanizeAction(action);
}
