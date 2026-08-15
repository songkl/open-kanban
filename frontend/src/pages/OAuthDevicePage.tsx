import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { authApi } from '../services/api';

interface DeviceLookup {
  clientId: string;
  clientName: string;
  scope: string;
  expiresAt: string;
  status: string;
}

export function OAuthDevicePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const initialCode = (params.get('user_code') || '').trim();
  const [code, setCode] = useState(initialCode);
  const [lookup, setLookup] = useState<DeviceLookup | null>(null);
  const [error, setError] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [decided, setDecided] = useState<'approved' | 'denied' | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);

  useEffect(() => {
    authApi
      .me()
      .then((data) => {
        if (data.needsSetup) {
          navigate('/setup');
          return;
        }
        if (!data.user) {
          setNeedsLogin(true);
        }
      })
      .catch(() => setNeedsLogin(true));
  }, [navigate]);

  useEffect(() => {
    if (!code) {
      setLookup(null);
      setError('');
      return;
    }
    let cancelled = false;
    setError('');
    setLookup(null);
    fetch(`/oauth/device/lookup?user_code=${encodeURIComponent(code)}`)
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 404) {
          setError(t('oauth.device.unknownCode'));
          return;
        }
        if (res.status === 410) {
          setError(t('oauth.device.expired'));
          return;
        }
        if (!res.ok) {
          setError(t('oauth.device.lookupFailed'));
          return;
        }
        const data = (await res.json()) as DeviceLookup;
        if (!cancelled) setLookup(data);
      })
      .catch(() => {
        if (!cancelled) setError(t('oauth.device.lookupFailed'));
      });
    return () => {
      cancelled = true;
    };
  }, [code, t]);

  const decide = async (decision: 'approve' | 'deny') => {
    if (!code) return;
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch('/oauth/device/approve', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_code: code, decision }),
      });
      if (res.status === 401) {
        setNeedsLogin(true);
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error_description || t('oauth.device.failed'));
        return;
      }
      setDecided(decision === 'approve' ? 'approved' : 'denied');
    } catch {
      setError(t('oauth.device.failed'));
    } finally {
      setSubmitting(false);
    }
  };

  if (needsLogin) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-100 px-4 dark:bg-zinc-900">
        <div className="w-full max-w-md rounded-xl bg-white p-6 text-center shadow-lg dark:bg-zinc-800">
          <h1 className="mb-2 text-xl font-semibold text-zinc-800 dark:text-zinc-100">
            {t('oauth.device.title')}
          </h1>
          <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">
            {t('oauth.device.loginRequired')}
          </p>
          <button
            type="button"
            className="w-full rounded-md bg-blue-500 px-4 py-2 font-medium text-white transition-colors hover:bg-blue-600"
            onClick={() => navigate('/login?return=/oauth/device?user_code=' + encodeURIComponent(code))}
          >
            {t('oauth.device.goLogin')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-100 px-4 dark:bg-zinc-900">
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-lg dark:bg-zinc-800">
        <h1 className="mb-2 text-xl font-semibold text-zinc-800 dark:text-zinc-100">
          {t('oauth.device.title')}
        </h1>
        <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">
          {t('oauth.device.subtitle')}
        </p>

        <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-200" htmlFor="user-code">
          {t('oauth.device.codeLabel')}
        </label>
        <input
          id="user-code"
          type="text"
          autoComplete="off"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase().trim())}
          className="w-full rounded-md border border-zinc-300 px-4 py-2 font-mono text-lg tracking-widest focus:border-blue-500 focus:outline-none dark:border-zinc-600 dark:bg-zinc-700 dark:text-zinc-100"
          placeholder="XXXX-XXXX"
          maxLength={9}
          data-testid="user-code-input"
        />

        {error && (
          <p className="mt-3 rounded-md bg-red-50 p-2 text-sm text-red-600 dark:bg-red-900/30 dark:text-red-400" role="alert">
            {error}
          </p>
        )}

        {lookup && !decided && (
          <div className="mt-5 rounded-md border border-zinc-200 p-3 dark:border-zinc-700">
            <p className="text-sm text-zinc-700 dark:text-zinc-300">
              <span className="font-medium">{t('oauth.device.clientLabel')}</span>{' '}
              {lookup.clientName || lookup.clientId}
            </p>
            <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">
              <span className="font-medium">{t('oauth.device.scopeLabel')}</span>{' '}
              {lookup.scope || '(none)'}
            </p>
          </div>
        )}

        {decided && (
          <div
            className={`mt-5 rounded-md p-3 text-sm ${
              decided === 'approved'
                ? 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300'
                : 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300'
            }`}
            data-testid="decision-banner"
          >
            {decided === 'approved'
              ? t('oauth.device.approvedBanner')
              : t('oauth.device.deniedBanner')}
          </div>
        )}

        <div className="mt-6 flex gap-3">
          <button
            type="button"
            disabled={!lookup || submitting || decided !== null}
            onClick={() => decide('approve')}
            className="flex-1 rounded-md bg-blue-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-600 disabled:cursor-not-allowed disabled:bg-zinc-300 dark:disabled:bg-zinc-600"
            data-testid="approve-btn"
          >
            {t('oauth.device.approve')}
          </button>
          <button
            type="button"
            disabled={!lookup || submitting || decided !== null}
            onClick={() => decide('deny')}
            className="flex-1 rounded-md bg-zinc-200 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-300 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-600"
            data-testid="deny-btn"
          >
            {t('oauth.device.deny')}
          </button>
        </div>
      </div>
    </div>
  );
}