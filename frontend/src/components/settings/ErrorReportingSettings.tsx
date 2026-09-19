import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { frontendEventsApi } from '../../services/api';
import { readPersistedEnabled } from '../../services/errorReporter';

interface ToggleProps {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}

function SwitchRow({ id, label, description, checked, disabled, onChange }: ToggleProps) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3">
      <div className="flex-1">
        <label htmlFor={id} className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
          {label}
        </label>
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{description}</p>
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        data-testid={id}
        className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
          checked ? 'bg-blue-600' : 'bg-zinc-300 dark:bg-zinc-600'
        } ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white dark:bg-zinc-700 transition-transform ${
            checked ? 'translate-x-6' : 'translate-x-1'
          }`}
        />
      </button>
    </div>
  );
}

/**
 * ErrorReportingSettings — backs the new "Error Reporting"
 * tab in Settings (s-1210, PM_REVIEW_2026-09-17 §7).
 *
 * Two surfaces are exposed here:
 *
 *   1. The server-side admin toggle (frontendEventsEnabled).
 *      Flipping this off stops the backend from persisting any
 *      captured exception. The ingest endpoint returns 204, which
 *      the global handler treats as "all good, nothing to do".
 *      A self-hosted admin disables this when running a fully
 *      air-gapped deployment.
 *
 *   2. The client-side per-session toggle. Persisted in
 *      localStorage so the next page reload still honors the
 *      choice. Useful when an individual user wants to opt
 *      out without affecting the rest of the deployment.
 *
 * Both are independent. The DoD ("no secret is leaked") is
 * preserved even when both are off — the redaction pass is
 * always applied on the wire payload, regardless of whether
 * the row is actually persisted.
 */
export function ErrorReportingSettings({ isAdmin = false }: { isAdmin?: boolean }) {
  const { t } = useTranslation();
  const [adminEnabled, setAdminEnabled] = useState<boolean | null>(null);
  const [clientEnabled, setClientEnabled] = useState<boolean>(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    // The client toggle can be hydrated synchronously from
    // localStorage; no network call required.
    const persisted = readPersistedEnabled();
    setClientEnabled(persisted === undefined ? true : persisted);

    if (!isAdmin) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const cfg = await frontendEventsApi.getConfig();
        if (!cancelled) setAdminEnabled(cfg.enabled);
      } catch (err) {
        if (!cancelled) {
          setError((err as Error).message || t('settings.errorReporting.loadFailed'));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAdmin, t]);

  const flashSuccess = useCallback((message: string) => {
    setSuccess(message);
    window.setTimeout(() => setSuccess(null), 2000);
  }, []);

  const persistClient = useCallback(
    (next: boolean) => {
      // The shared reporter is created lazily by the
      // ErrorBoundary. Reading localStorage here keeps the
      // toggle persisted across reloads, and the reporter
      // re-reads the same key on next install().
      try {
        localStorage.setItem('kanban.frontendEventsEnabled', next ? '1' : '0');
      } catch {
        // localStorage may be unavailable (private mode).
        // The in-memory state is enough for the current
        // session; reload behavior is best-effort.
      }
      setClientEnabled(next);
      flashSuccess(t('settings.errorReporting.saved'));
    },
    [flashSuccess, t]
  );

  const persistAdmin = useCallback(
    async (next: boolean) => {
      setSaving(true);
      setError(null);
      try {
        const cfg = await frontendEventsApi.setConfig(next);
        setAdminEnabled(cfg.enabled);
        flashSuccess(t('settings.errorReporting.saved'));
      } catch (err) {
        setError((err as Error).message || t('settings.errorReporting.saveFailed'));
      } finally {
        setSaving(false);
      }
    },
    [flashSuccess, t]
  );

  if (loading) {
    return (
      <div className="space-y-4">
        <h2 className="text-lg font-semibold text-zinc-800 dark:text-zinc-100">
          {t('settings.errorReporting.title')}
        </h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">{t('settings.loading')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-zinc-800 dark:text-zinc-100">
          {t('settings.errorReporting.title')}
        </h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          {t('settings.errorReporting.description')}
        </p>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
        >
          {error}
        </div>
      )}
      {success && (
        <div
          role="status"
          className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300"
        >
          {success}
        </div>
      )}

      <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 divide-y divide-zinc-100 dark:divide-zinc-700">
        <SwitchRow
          id="error-reporting-client"
          label={t('settings.errorReporting.clientLabel')}
          description={t('settings.errorReporting.clientDescription')}
          checked={clientEnabled}
          onChange={(next) => persistClient(next)}
        />
        {isAdmin && (
          <SwitchRow
            id="error-reporting-server"
            label={t('settings.errorReporting.serverLabel')}
            description={t('settings.errorReporting.serverDescription')}
            checked={adminEnabled ?? true}
            disabled={saving}
            onChange={(next) => void persistAdmin(next)}
          />
        )}
      </div>

      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        {t('settings.errorReporting.redactionHint')}
      </p>
    </div>
  );
}