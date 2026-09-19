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

interface CurrentUser {
  id: string;
  role?: string;
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
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  // Inline "create new agent" form state. Only rendered for ADMIN
  // approvers — non-admins hit a single-line hint that points them to an
  // administrator (s-1248).
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newAgentNickname, setNewAgentNickname] = useState('');
  const [newAgentRole, setNewAgentRole] = useState<'ADMIN' | 'MEMBER' | 'VIEWER'>('MEMBER');
  const [creatingAgent, setCreatingAgent] = useState(false);
  const [createAgentError, setCreateAgentError] = useState<string>('');

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
          return;
        }
        setCurrentUser({ id: data.user.id, role: data.user.role });
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

  const createInlineAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    const nickname = newAgentNickname.trim();
    if (!nickname || !code || creatingAgent) return;
    setCreatingAgent(true);
    setCreateAgentError('');
    try {
      const res = await fetch('/oauth/device/create-agent', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname, role: newAgentRole })
      });
      if (res.status === 401) {
        setNeedsLogin(true);
        return;
      }
      if (res.status === 403) {
        setCreateAgentError(t('oauth.device.createAgentForbidden'));
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setCreateAgentError(
          body.error_description || t('oauth.device.createAgentError')
        );
        return;
      }
      const data = (await res.json()) as { agent: { id: string; nickname: string; role: string } };
      const newId = data.agent.id;
      // Optimistically merge the new agent into the picker list so the
      // user sees it immediately, then re-fetch the lookup to pull the
      // canonical row (avatar, last_active_at, etc.).
      setLookup((prev) => {
        if (!prev) return prev;
        const existing = prev.availableAgents ?? [];
        const filtered = existing.filter((a) => a.id !== newId);
        return {
          ...prev,
          availableAgents: [
            ...filtered,
            { id: newId, nickname: data.agent.nickname, role: data.agent.role }
          ],
          defaultAgentId: newId
        };
      });
      setIdentity(newId);
      setShowCreateForm(false);
      setNewAgentNickname('');
      setNewAgentRole('MEMBER');
      // Re-pull the canonical row so the picker matches what the server
      // will return on the next approve.
      try {
        const refresh = await fetch(`/oauth/device/lookup?user_code=${encodeURIComponent(code)}`, {
          credentials: 'include'
        });
        if (refresh.ok) {
          const refreshed = (await refresh.json()) as DeviceLookup;
          setLookup(refreshed);
        }
      } catch {
        // The optimistic update above is enough to keep the UX going;
        // failing the refresh should not surface as an error to the
        // approver (they can still pick the agent and approve).
      }
    } catch {
      setCreateAgentError(t('oauth.device.createAgentError'));
    } finally {
      setCreatingAgent(false);
    }
  };

  if (needsLogin) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-100 dark:bg-zinc-900 px-4">
        <div className="w-full max-w-md rounded-xl bg-white dark:bg-zinc-800 p-6 text-center shadow-lg">
          <h1 className="mb-2 text-xl font-semibold text-zinc-800 dark:text-zinc-100">
            {t('oauth.device.title')}
          </h1>
          <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-500">
            {t('oauth.device.loginRequired')}
          </p>
          <button
            type="button"
            className="w-full rounded-md bg-blue-500 px-4 py-2 font-medium text-white transition-colors hover:bg-blue-600"
            onClick={() => {
              const params = new URLSearchParams({
                return: `/oauth/device?user_code=${encodeURIComponent(code)}`,
              });
              navigate(`/login?${params.toString()}`);
            }}
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
<div className="flex min-h-screen items-center justify-center bg-zinc-100 dark:bg-zinc-900 px-4">
        <div className="w-full max-w-md rounded-xl bg-white dark:bg-zinc-800 p-6 shadow">
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

                {/* s-1248: inline "create new agent" affordance so ADMIN
                    approvers don't have to bounce through the admin
                    settings page just to finish a CLI / MCP runner
                    binding. Non-admins see a one-line hint instead. */}
                <div
                  className="mt-3 border-t border-zinc-200 dark:border-zinc-700 pt-3"
                  data-testid="create-agent-block"
                >
                  {currentUser?.role === 'ADMIN' ? (
                    showCreateForm ? (
                      <form
                        onSubmit={createInlineAgent}
                        className="space-y-2"
                        data-testid="create-agent-form"
                      >
                        <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                          {t('oauth.device.createAgentHeading')}
                        </p>
                        <p className="text-xs text-zinc-500 dark:text-zinc-400">
                          {t('oauth.device.createAgentPrompt')}
                        </p>
                        <label
                          htmlFor="inline-agent-nickname"
                          className="block text-xs font-medium text-zinc-600 dark:text-zinc-400"
                        >
                          {t('oauth.device.createAgentNicknameLabel')}
                        </label>
                        <input
                          id="inline-agent-nickname"
                          type="text"
                          autoComplete="off"
                          value={newAgentNickname}
                          onChange={(e) => setNewAgentNickname(e.target.value)}
                          placeholder={t('oauth.device.createAgentNicknamePlaceholder')}
                          maxLength={64}
                          className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100"
                          data-testid="inline-agent-nickname"
                        />
                        <label
                          htmlFor="inline-agent-role"
                          className="block text-xs font-medium text-zinc-600 dark:text-zinc-400"
                        >
                          {t('oauth.device.createAgentRoleLabel')}
                        </label>
                        <select
                          id="inline-agent-role"
                          value={newAgentRole}
                          onChange={(e) =>
                            setNewAgentRole(e.target.value as 'ADMIN' | 'MEMBER' | 'VIEWER')
                          }
                          className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100"
                          data-testid="inline-agent-role"
                        >
                          <option value="MEMBER">MEMBER</option>
                          <option value="ADMIN">ADMIN</option>
                          <option value="VIEWER">VIEWER</option>
                        </select>
                        {createAgentError && (
                          <p
                            className="rounded-md bg-red-50 p-2 text-xs text-red-600 dark:bg-red-900/30 dark:text-red-400"
                            data-testid="create-agent-error"
                            role="alert"
                          >
                            {createAgentError}
                          </p>
                        )}
                        <div className="flex gap-2">
                          <button
                            type="submit"
                            disabled={creatingAgent || !newAgentNickname.trim()}
                            className="flex-1 rounded-md bg-green-500 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-green-600 disabled:cursor-not-allowed disabled:bg-zinc-300 dark:disabled:bg-zinc-600"
                            data-testid="create-agent-submit"
                          >
                            {creatingAgent
                              ? t('oauth.device.createAgentSubmitting')
                              : t('oauth.device.createAgentSubmit')}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setShowCreateForm(false);
                              setCreateAgentError('');
                              setNewAgentNickname('');
                            }}
                            disabled={creatingAgent}
                            className="rounded-md bg-zinc-200 dark:bg-zinc-700 px-3 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-400 hover:bg-zinc-300 dark:hover:bg-zinc-600 disabled:opacity-50"
                            data-testid="create-agent-cancel"
                          >
                            {t('oauth.device.createAgentCancel')}
                          </button>
                        </div>
                      </form>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setShowCreateForm(true);
                          setCreateAgentError('');
                        }}
                        className="w-full rounded-md border border-dashed border-zinc-300 dark:border-zinc-600 px-3 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 transition-colors hover:border-blue-500 hover:text-blue-600 dark:hover:text-blue-300"
                        data-testid="create-agent-toggle"
                      >
                        {t('oauth.device.createAgentButton')}
                      </button>
                    )
                  ) : (
                    <p
                      className="text-xs text-zinc-500 dark:text-zinc-400"
                      data-testid="create-agent-hint"
                    >
                      {t('oauth.device.createAgentForbidden')}
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