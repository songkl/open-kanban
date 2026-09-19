import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { authApi } from '../services/api';

interface AvailableAgent {
  id: string;
  nickname?: string;
  role?: string;
  avatar?: string;
}

interface DeviceLookup {
  clientId: string;
  clientName: string;
  scope: string;
  expiresAt: string;
  status: string;
  agentSelectionRequired?: boolean;
  availableAgents?: AvailableAgent[];
  defaultAgentId?: string;
}

const SELF_IDENTITY = '';

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
  const [identity, setIdentity] = useState<string>(SELF_IDENTITY);

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
    fetch(`/oauth/device/lookup?user_code=${encodeURIComponent(code)}`, {
      credentials: 'include'
    })
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
        if (!cancelled) {
          setLookup(data);
          // Pre-select the server default agent when the picker is shown;
          // fall back to "Myself" otherwise so the radio state stays valid.
          if (data.agentSelectionRequired) {
            setIdentity(data.defaultAgentId ?? SELF_IDENTITY);
          } else {
            setIdentity(SELF_IDENTITY);
          }
        }
      })
      .catch(() => {
        if (!cancelled) setError(t('oauth.device.lookupFailed'));
      });
    return () => {
      cancelled = true;
    };
    // The effect intentionally depends only on `code` — `t` is a
    // fresh function reference per render under the test mock and
    // would otherwise trigger an infinite re-fetch loop. The strings
    // inside `t()` are stable across renders, so the missing
    // dependency is safe in practice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  const decide = async (decision: 'approve' | 'deny') => {
    if (!code) return;
    setSubmitting(true);
    setError('');
    try {
      const body: Record<string, string> = { user_code: code, decision };
      // Submit the chosen agent_id only when the picker was rendered and
      // the approver picked something other than themselves. Empty string
      // means "bind to me" and we omit the field to preserve the existing
      // server contract for non-CLI flows.
      if (
        lookup?.agentSelectionRequired &&
        identity !== SELF_IDENTITY
      ) {
        body.agent_id = identity;
      }
      const res = await fetch('/oauth/device/approve', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
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
      <div className="flex min-h-screen items-center justify-center bg-zinc-100 dark:bg-zinc-700 px-4 dark:bg-zinc-900">
        <div className="w-full max-w-md rounded-xl bg-white dark:bg-zinc-700 p-6 text-center shadow-lg dark:bg-zinc-800">
          <h1 className="mb-2 text-xl font-semibold text-zinc-800 dark:text-zinc-100">
            {t('oauth.device.title')}
          </h1>
          <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-500">
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

  const showPicker = !!lookup?.agentSelectionRequired;
  const agents = lookup?.availableAgents ?? [];
  const defaultId = lookup?.defaultAgentId ?? '';
  const hasAgentSelection = showPicker && (agents.length > 0 || defaultId);

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-100 dark:bg-zinc-700 px-4 dark:bg-zinc-900">
      <div className="w-full max-w-md rounded-xl bg-white dark:bg-zinc-700 p-6 shadow dark:bg-zinc-800">
        <h1 className="mb-2 text-xl font-semibold text-zinc-800 dark:text-zinc-100">
          {t('oauth.device.title')}
        </h1>
        <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-500">
          {t('oauth.device.subtitle')}
        </p>

        <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-400" htmlFor="user-code">
          {t('oauth.device.codeLabel')}
        </label>
        <input
          id="user-code"
          type="text"
          autoComplete="off"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase().trim())}
          className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-4 py-2 font-mono text-lg tracking-widest focus:border-blue-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100"
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
          <div className="mt-5 rounded-md border border-zinc-200 dark:border-zinc-700 p-3">
            <p className="text-sm text-zinc-700 dark:text-zinc-300">
              <span className="font-medium">{t('oauth.device.clientLabel')}</span>{' '}
              {lookup.clientName || lookup.clientId}
            </p>
            <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">
              <span className="font-medium">{t('oauth.device.scopeLabel')}</span>{' '}
              {lookup.scope || '(none)'}
            </p>

            {showPicker && (
              <div className="mt-3 border-t border-zinc-200 dark:border-zinc-700 pt-3">
                <p className="mb-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  {t('oauth.device.identityLabel')}
                </p>
                <div className="space-y-2" data-testid="identity-picker">
                  <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
                    <input
                      type="radio"
                      name="identity"
                      value={SELF_IDENTITY}
                      checked={identity === SELF_IDENTITY}
                      onChange={() => setIdentity(SELF_IDENTITY)}
                      data-testid="identity-self"
                    />
                    {t('oauth.device.identityAsSelf')}
                  </label>
                  {agents.map((agent) => {
                    const isDefault = agent.id === defaultId;
                    return (
                      <label
                        key={agent.id}
                        className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300"
                        data-testid={`identity-agent-${agent.id}`}
                      >
                        <input
                          type="radio"
                          name="identity"
                          value={agent.id}
                          checked={identity === agent.id}
                          onChange={() => setIdentity(agent.id)}
                          data-testid={`identity-agent-radio-${agent.id}`}
                        />
                        <span className="truncate">{agent.nickname || agent.id}</span>
                        {agent.role && (
                          <span className="rounded bg-zinc-200 dark:bg-zinc-600 px-1.5 py-0.5 text-xs text-zinc-600 dark:text-zinc-300">
                            {agent.role}
                          </span>
                        )}
                        {isDefault && (
                          <span
                            className="rounded bg-blue-100 dark:bg-blue-900/40 px-1.5 py-0.5 text-xs text-blue-700 dark:text-blue-300"
                            data-testid={`identity-agent-default-${agent.id}`}
                          >
                            {t('oauth.device.identityServerDefault')}
                          </span>
                        )}
                      </label>
                    );
                  })}
                  {agents.length === 0 && !defaultId && (
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                      {t('oauth.device.identityEmpty')}
                    </p>
                  )}
                </div>
              </div>
            )}
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
            disabled={
              !lookup ||
              submitting ||
              decided !== null ||
              (showPicker && !hasAgentSelection)
            }
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
            className="flex-1 rounded-md bg-zinc-200 dark:bg-zinc-700 px-4 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-400 hover:bg-zinc-300 dark:hover:bg-zinc-600 disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="deny-btn"
          >
            {t('oauth.device.deny')}
          </button>
        </div>
      </div>
    </div>
  );
}