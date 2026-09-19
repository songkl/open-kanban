import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { notificationPreferencesApi } from '../../services/api';
import type { NotificationPreferences } from '../../types/kanban';

interface ToggleProps {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}

function SwitchRow({ id, label, description, checked, disabled, onChange }: ToggleProps) {
  const testId = id === 'notif-email' ? 'email-switch' : 'webhook-switch';
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
        data-testid={testId}
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
 * NotificationsSettings — backs the "Notifications" tab in Settings
 * (s-1203, PM_REVIEW_2026-09-17 §3.7).
 *
 * Two independent channels can be muted from this surface:
 *
 *   - Email   — outbound email delivery of bell-badge rows.
 *   - Webhook — outbound webhook delivery, with an editable URL.
 *
 * Each channel is toggled independently and PATCHed to the server
 * with a single field. Omitted fields are preserved server-side
 * (`internal/handlers/notification_preferences.go`), so flipping
 * webhookEnabled cannot accidentally re-enable email.
 *
 * The bell badge itself is always on — only the external
 * transports are gated here. That matches the user-visible
 * distinction between "I want the in-app toast" (always on) and
 * "I want my phone to also ping" (this page).
 */
export function NotificationsSettings() {
  const { t } = useTranslation();
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  const [webhookDraft, setWebhookDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await notificationPreferencesApi.get();
        if (cancelled) return;
        setPrefs(data);
        setWebhookDraft(data.webhookUrl);
      } catch (err) {
        if (!cancelled) {
          setError((err as Error).message || t('settings.notifications.loadFailed'));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [t]);

  const flashSuccess = useCallback((message: string) => {
    setSuccess(message);
    window.setTimeout(() => setSuccess(null), 2000);
  }, []);

  const persist = useCallback(
    async (patch: Parameters<typeof notificationPreferencesApi.update>[0]) => {
      setSaving(true);
      setError(null);
      try {
        const next = await notificationPreferencesApi.update(patch);
        setPrefs(next);
        setWebhookDraft(next.webhookUrl);
        flashSuccess(t('settings.notifications.saved'));
      } catch (err) {
        setError((err as Error).message || t('settings.notifications.saveFailed'));
      } finally {
        setSaving(false);
      }
    },
    [flashSuccess, t]
  );

  const handleEmailToggle = (next: boolean) => {
    if (!prefs) return;
    setPrefs({ ...prefs, emailEnabled: next });
    void persist({ emailEnabled: next });
  };

  const handleWebhookToggle = (next: boolean) => {
    if (!prefs) return;
    setPrefs({ ...prefs, webhookEnabled: next });
    void persist({ webhookEnabled: next });
  };

  const handleWebhookUrlBlur = () => {
    if (!prefs) return;
    if (webhookDraft === prefs.webhookUrl) return;
    void persist({ webhookUrl: webhookDraft });
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <h2 className="text-lg font-semibold text-zinc-800 dark:text-zinc-100">
          {t('settings.notifications.title')}
        </h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">{t('settings.loading')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-zinc-800 dark:text-zinc-100">
          {t('settings.notifications.title')}
        </h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          {t('settings.notifications.description')}
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
          id="notif-email"
          label={t('settings.notifications.emailLabel')}
          description={t('settings.notifications.emailDescription')}
          checked={prefs?.emailEnabled ?? false}
          disabled={saving}
          onChange={handleEmailToggle}
        />
        <SwitchRow
          id="notif-webhook"
          label={t('settings.notifications.webhookLabel')}
          description={t('settings.notifications.webhookDescription')}
          checked={prefs?.webhookEnabled ?? false}
          disabled={saving}
          onChange={handleWebhookToggle}
        />
        <div className="px-4 py-3">
          <label
            htmlFor="notif-webhook-url"
            className="text-sm font-medium text-zinc-700 dark:text-zinc-200"
          >
            {t('settings.notifications.webhookUrlLabel')}
          </label>
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
            {t('settings.notifications.webhookUrlDescription')}
          </p>
          <input
            id="notif-webhook-url"
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://hooks.example.com/notify"
            value={webhookDraft}
            onChange={(e) => setWebhookDraft(e.target.value)}
            onBlur={handleWebhookUrlBlur}
            disabled={saving}
            data-testid="webhook-url-input"
            className="mt-2 w-full rounded-md border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-700 px-3 py-2 text-sm text-zinc-800 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          />
        </div>
      </div>

      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        {t('settings.notifications.bellHint')}
      </p>
    </div>
  );
}
