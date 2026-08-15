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
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-900 p-4">
        <div className="max-w-md w-full bg-white dark:bg-slate-800 rounded-xl shadow p-6 text-center">
          <h1 className="text-xl font-semibold mb-2 dark:text-slate-100">
            {t('oauth.device.title')}
          </h1>
          <p className="text-slate-600 dark:text-slate-400 mb-4">
            {t('oauth.device.loginRequired')}
          </p>
          <button
            type="button"
            className="w-full px-4 py-2 rounded-md bg-purple-600 hover:bg-purple-700 text-white"
            onClick={() => navigate('/login?return=/oauth/device?user_code=' + encodeURIComponent(code))}
          >
            {t('oauth.device.goLogin')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-900 p-4">
      <div className="max-w-md w-full bg-white dark:bg-slate-800 rounded-xl shadow p-6">
        <h1 className="text-xl font-semibold mb-4 dark:text-slate-100">
          {t('oauth.device.title')}
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-400 mb-4">
          {t('oauth.device.subtitle')}
        </p>

        <label className="block text-sm font-medium mb-1 dark:text-slate-300" htmlFor="user-code">
          {t('oauth.device.codeLabel')}
        </label>
        <input
          id="user-code"
          type="text"
          autoComplete="off"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase().trim())}
          className="w-full px-3 py-2 border rounded-md font-mono text-lg tracking-widest dark:bg-slate-900 dark:border-slate-700 dark:text-slate-100"
          placeholder="XXXX-XXXX"
          maxLength={9}
          data-testid="user-code-input"
        />

        {error && (
          <p className="mt-3 text-sm text-red-600 dark:text-red-400" role="alert">
            {error}
          </p>
        )}

        {lookup && !decided && (
          <div className="mt-5 p-3 rounded-md border border-slate-200 dark:border-slate-700">
            <p className="text-sm text-slate-700 dark:text-slate-300">
              <span className="font-medium">{t('oauth.device.clientLabel')}</span>{' '}
              {lookup.clientName || lookup.clientId}
            </p>
            <p className="text-sm text-slate-700 dark:text-slate-300 mt-1">
              <span className="font-medium">{t('oauth.device.scopeLabel')}</span>{' '}
              {lookup.scope || '(none)'}
            </p>
          </div>
        )}

        {decided && (
          <div
            className={`mt-5 p-3 rounded-md text-sm ${
              decided === 'approved'
                ? 'bg-green-100 text-green-900 dark:bg-green-900/30 dark:text-green-200'
                : 'bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200'
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
            className="flex-1 px-4 py-2 rounded-md bg-purple-600 hover:bg-purple-700 text-white disabled:bg-slate-300 disabled:cursor-not-allowed"
            data-testid="approve-btn"
          >
            {t('oauth.device.approve')}
          </button>
          <button
            type="button"
            disabled={!lookup || submitting || decided !== null}
            onClick={() => decide('deny')}
            className="flex-1 px-4 py-2 rounded-md bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="deny-btn"
          >
            {t('oauth.device.deny')}
          </button>
        </div>
      </div>
    </div>
  );
}