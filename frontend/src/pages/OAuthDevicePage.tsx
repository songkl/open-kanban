import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { authApi, boardsApi } from '../services/api';
import type { Board, PermissionAccess } from '../types/kanban';

interface AvailableAgent {
  id: string;
  nickname?: string;
  role?: string;
  avatar?: string;
}

interface DeviceLookupAgent {
  id: string;
  nickname?: string;
  username?: string;
  role?: string;
}

interface DeviceLookup {
  clientId: string;
  clientName: string;
  scope: string;
  expiresAt: string;
  status: string;
  // agentSelectionRequired mirrors the `agent_selection_required`
  // field returned by GET /oauth/device/lookup (s-1112.3 / plan
  // §4.1.2). The backend emits snake_case here so the page stays in
  // lockstep with the wire format; we keep the camelCase alias below
  // so any older / mocked payload still resolves.
  agentSelectionRequired?: boolean;
  agent_selection_required?: boolean;
  // availableAgents mirrors the `available_agents` field returned by
  // GET /oauth/device/lookup (s-1112.3 / plan §4.1.2). It is the
  // role-filtered list of Agent identities the caller is allowed to
  // delegate the device code to — ADMIN sees every enabled Agent,
  // MEMBER / VIEWER see only non-ADMIN Agents, anonymous sees [].
  // The backend emits snake_case; the camelCase alias is kept so
  // older / mocked payloads still resolve without crashing.
  availableAgents?: DeviceLookupAgent[];
  available_agents?: DeviceLookupAgent[];
  defaultAgentId?: string;
}

interface ApproveResponse {
  approved?: boolean;
  denied?: boolean;
  boundTo?: string;
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
  // Prefer the modern `code` parameter (e.g. `/oauth/device?code=ABCD-1234`)
  // that matches the verification_uri_complete emitted by the device-code
  // endpoint, but keep `user_code` as a fallback so existing deep links
  // still resolve.
  const initialCode = (
    params.get('code') ||
    params.get('user_code') ||
    ''
  ).trim();
  const [code, setCode] = useState(initialCode);
  const [lookup, setLookup] = useState<DeviceLookup | null>(null);
  const [error, setError] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [decided, setDecided] = useState<'approved' | 'denied' | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [disabled, setDisabled] = useState(false);
  // selectedAgentId is the empty string when the human approver picks
  // "Authorize as myself" and an Agent id otherwise. Defaults to the
  // server-suggested defaultAgentId (set by oauth_device_agent_id) so
  // a pre-pinned kiosk deployment does not need extra clicks.
  const [selectedAgentId, setSelectedAgentId] = useState<string>('');
  const [approvedAs, setApprovedAs] = useState<string>('');
  // confirmingIdentity is the explicit "are you sure?" gate added by
  // s-1131: the human approver must acknowledge which identity the
  // device code will be bound to before the approve request leaves
  // the browser. We separate it from `submitting` so the spinner
  // only spins during the network round-trip; the gate itself is
  // synchronous and can be cancelled by editing the selection.
  const [confirmingIdentity, setConfirmingIdentity] = useState(false);

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
    boardsApi
      .getAll()
      .then((boards) => setAvailableBoards(boards || []))
      .catch(() => setAvailableBoards([]));
  }, []);

  useEffect(() => {
    if (!code) {
      setLookup(null);
      setError('');
      setDisabled(false);
      return;
    }
    let cancelled = false;
    setError('');
    setLookup(null);
    setDisabled(false);
    setSelectedAgentId('');
    setApprovedAs('');
    fetch(`/oauth/device/lookup?code=${encodeURIComponent(code)}`, {
      credentials: 'include',
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
        if (res.status === 503) {
          let body: { error?: string } = {};
          try {
            body = (await res.json()) as { error?: string };
          } catch {
            // ignore parse failures and fall back to the generic message
          }
          if (body?.error === 'oauth_device_disabled') {
            setDisabled(true);
            return;
          }
          setError(t('oauth.device.lookupFailed'));
          return;
        }
        if (!res.ok) {
          setError(t('oauth.device.lookupFailed'));
          return;
        }
        const data = (await res.json()) as DeviceLookup;
        if (!cancelled) {
          setLookup(data);
          // Pre-select the configured default when the admin has pinned
          // a global Agent id. Empty string falls through to "myself".
          // Read both the snake_case field the backend emits and the
          // camelCase alias so older / mocked payloads still resolve.
          const availableAgents = data.availableAgents ?? data.available_agents;
          if (data.defaultAgentId && Array.isArray(availableAgents) &&
              availableAgents.some((a) => a.id === data.defaultAgentId)) {
            setSelectedAgentId(data.defaultAgentId);
          }
        }
      })
      .catch(() => {
        if (!cancelled) setError(t('oauth.device.lookupFailed'));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  // approverLabel is the nickname shown next to the "Myself" radio so
  // the human approver can confirm which account they are about to
  // delegate. Falls back to "you" when the API does not return a name
  // (e.g. legacy payloads). Resolving the nickname is planned for a
  // follow-up; today we intentionally render an empty value so the
  // i18n fallback copy is used.
  const approverLabel = '';

  // selectedIdentityLabel returns the human-readable label of the
  // identity the approver is about to authorise. Used by the
  // confirmation banner so the approver can verify they picked the
  // right one before the request leaves the page. Returns the empty
  // string for the legacy "Myself" path.
  const selectedIdentityLabel = (): string => {
    if (!selectedAgentId) {
      return t('oauth.device.identitySelf', { name: approverLabel || t('oauth.device.identityYouFallback') });
    }
    const found = agents?.find((a) => a.id === selectedAgentId);
    if (!found) return selectedAgentId;
    return t('oauth.device.identityAgent', { name: found.nickname || found.username || found.id });
  };
  const selectedIdentityKind = (): 'agent' | 'self' =>
    selectedAgentId ? 'agent' : 'self';

  const decide = async (decision: 'approve' | 'deny') => {
    if (!code) return;
    setSubmitting(true);
    setError('');
    try {
      const body: Record<string, string> = {
        user_code: code,
        decision,
      };
      // Only attach agentId when a real Agent is selected — the empty
      // string keeps the legacy "approve as myself" path.
      if (selectedAgentId) {
        body.agentId = selectedAgentId;
      }
      const res = await fetch('/oauth/device/approve', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.status === 401) {
        setNeedsLogin(true);
        return;
      }
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        setError(errBody.error_description || t('oauth.device.failed'));
        return;
      }
      const okBody = (await res.json().catch(() => ({}))) as ApproveResponse;
      if (decision === 'approve' && okBody.boundTo) {
        setApprovedAs(okBody.boundTo);
      }
      setDecided(decision === 'approve' ? 'approved' : 'denied');
    } catch {
      setError(t('oauth.device.failed'));
    } finally {
      setSubmitting(false);
      setConfirmingIdentity(false);
    }
  };

  // requestApproval arms the confirmation gate; the actual approve
  // request goes out only after the approver clicks "Confirm" in the
  // banner. Lets the approver back out without round-tripping if
  // they picked the wrong identity.
  const requestApproval = () => {
    if (!lookup || !hasValidSelection) return;
    setConfirmingIdentity(true);
  };
  const cancelApproval = () => {
    setConfirmingIdentity(false);
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
            onClick={() => navigate('/login?return=/oauth/device?code=' + encodeURIComponent(code))}
          >
            {t('oauth.device.goLogin')}
          </button>
        </div>
      </div>
    );
  }

  if (disabled) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-100 dark:bg-zinc-700 px-4 dark:bg-zinc-900">
        <div
          className="w-full max-w-md rounded-xl bg-white dark:bg-zinc-700 p-6 text-center shadow-lg dark:bg-zinc-800"
          data-testid="device-disabled-card"
        >
          <h1 className="mb-2 text-xl font-semibold text-zinc-800 dark:text-zinc-100">
            {t('oauth.device.disabledTitle')}
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-500">
            {t('oauth.device.disabledBody')}
          </p>
        </div>
      </div>
    );
  }

  // agents is the array of selectable Agent identities returned by the
  // lookup. It defaults to an empty array when the lookup did not
  // include either wire field (legacy / anonymous lookups, or a
  // malformed response that sets agent_selection_required=true while
  // omitting available_agents) so the renderer's `.map` cannot throw.
  // Read both the snake_case wire field and the camelCase alias so
  // older / mocked payloads still resolve without crashing.
  const agents: DeviceLookupAgent[] =
    lookup?.availableAgents ?? lookup?.available_agents ?? [];
  const hasAgents = agents.length > 0;
  const pickerRequired =
    lookup?.agentSelectionRequired === true ||
    lookup?.agent_selection_required === true;
  // Render the picker whenever the server asked for one, even if it
  // returned zero Agents. The "Myself" radio is always valid in that
  // case, so the human approver can still bind the device code to
  // their own account. The legacy "skip the picker entirely" path
  // applies when the lookup didn't ask for an identity at all (the
  // OAuth client isn't flagged as a CLI / MCP consumer) — that path
  // binds to the logged-in user by default, matching the pre-s-1120
  // behaviour.
  const showIdentityPicker = pickerRequired;
  // The "no Agent available" hint is a soft warning rather than a
  // hard gate: s-1186 surfaced a UX dead-end where the Approve button
  // was disabled in this state, leaving the admin with no way to log
  // in to the device flow before they had created any Agents. The
  // server still enforces oauth_device_require_agent_selection at
  // approval time (see backend/internal/oauth/approve.go), so when an
  // admin has flipped the strict-mode toggle the empty state surfaces
  // a 400 from the API and the user is told to ask the operator to
  // create an Agent. Until then the human approver can pick "Myself"
  // and proceed.
  const showIdentityEmptyState = pickerRequired && !hasAgents;
  // A valid selection exists whenever the picker is shown (the
  // "Myself" radio is pre-selected, so a non-empty value is present)
  // or the legacy path is in effect (the human approver is implicitly
  // the bound user). We previously blocked Approve in the empty state,
  // but the picker always offers a "Myself" option so the selection
  // is genuinely valid — see s-1186.
  const hasValidSelection = showIdentityPicker || !pickerRequired;

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
                        {availableBoards.length > 0 && (
                          <div
                            className="rounded-md border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900/40 p-2 space-y-1"
                            data-testid="inline-agent-board-grants"
                          >
                            <p className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                              {t('oauth.device.createAgentBoardAccessHeading', 'Initial board access')}
                            </p>
                            <p className="text-[11px] text-zinc-500 dark:text-zinc-500">
                              {t('oauth.device.createAgentBoardAccessHelp', 'Optional. Pick zero or more boards; omitted boards mean no access.')}
                            </p>
                            <div className="max-h-32 space-y-1 overflow-y-auto">
                              {availableBoards.map((board) => {
                                const value = newAgentBoardAccess[board.id] ?? '';
                                return (
                                  <div
                                    key={board.id}
                                    className="flex items-center gap-2 rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-1"
                                  >
                                    <span className="flex-1 truncate text-xs text-zinc-800 dark:text-zinc-100" title={board.name}>
                                      {board.name}
                                    </span>
                                    <select
                                      aria-label={t('oauth.device.createAgentBoardAccessFor', { name: board.name })}
                                      value={value}
                                      onChange={(e) =>
                                        setBoardAccess(board.id, e.target.value as PermissionAccess | '')
                                      }
                                      className="rounded-md border border-zinc-300 dark:border-zinc-600 px-1 py-0.5 text-xs focus:border-blue-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100"
                                      data-testid={`inline-agent-board-access-${board.id}`}
                                    >
                                      <option value="">{t('oauth.device.createAgentBoardAccessNone', 'No access')}</option>
                                      <option value="READ">READ</option>
                                      <option value="WRITE">WRITE</option>
                                      <option value="ADMIN">ADMIN</option>
                                    </select>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}
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
                              setNewAgentBoardAccess({});
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

        {lookup && !decided && showIdentityPicker && (
          <div className="mt-3 rounded-md border border-zinc-200 dark:border-zinc-700 p-3" data-testid="identity-picker">
            <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              {t('oauth.device.identitySectionTitle')}
            </p>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">
              {t('oauth.device.identityHelper')}
            </p>
            <label className="mt-2 flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-700">
              <input
                type="radio"
                name="identity"
                value=""
                checked={selectedAgentId === ''}
                onChange={() => setSelectedAgentId('')}
                className="mt-0.5"
                data-testid="identity-self"
              />
              <span>{t('oauth.device.identitySelf', { name: approverLabel || t('oauth.device.identityYouFallback') })}</span>
            </label>
            {agents.map((a) => {
              const isServerDefault = lookup.defaultAgentId === a.id;
              return (
                <label
                  key={a.id}
                  className="mt-1 flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-700"
                >
                  <input
                    type="radio"
                    name="identity"
                    value={a.id}
                    checked={selectedAgentId === a.id}
                    onChange={() => setSelectedAgentId(a.id)}
                    className="mt-0.5"
                    data-testid={`identity-agent-${a.id}`}
                  />
                  <span>
                    {t('oauth.device.identityAgent', { name: a.nickname || a.username || a.id })}
                    {isServerDefault ? (
                      <span
                        className="ml-1 inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
                        data-testid={`identity-agent-${a.id}-default-badge`}
                      >
                        {t('oauth.device.identityServerDefault')}
                      </span>
                    ) : null}
                    {a.role ? (
                      <span className="ml-1 text-xs text-zinc-500">({a.role})</span>
                    ) : null}
                  </span>
                </label>
              );
            })}
          </div>
        )}

        {lookup && !decided && showIdentityEmptyState && (
          <div
            className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200"
            data-testid="identity-empty"
            role="alert"
          >
            {t('oauth.device.identityEmpty')}
          </div>
        )}

        {lookup && !decided && confirmingIdentity && (
          <div
            className="mt-3 rounded-md border border-blue-300 bg-blue-50 p-3 text-sm text-blue-900 dark:border-blue-700 dark:bg-blue-900/30 dark:text-blue-200"
            data-testid="identity-confirm-banner"
            role="alertdialog"
            aria-live="assertive"
          >
            <p className="font-medium">
              {selectedIdentityKind() === 'agent'
                ? t('oauth.device.identityConfirmAgent')
                : t('oauth.device.identityConfirmSelf')}
            </p>
            <p className="mt-1 text-xs text-blue-800 dark:text-blue-300">
              {t('oauth.device.identityConfirmSummary', {
                client: lookup.clientName || lookup.clientId,
                identity: selectedIdentityLabel(),
              })}
            </p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                disabled={submitting}
                onClick={() => decide('approve')}
                className="flex-1 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
                data-testid="identity-confirm-approve"
              >
                {selectedIdentityKind() === 'agent'
                  ? t('oauth.device.identityConfirmAgentCta')
                  : t('oauth.device.identityConfirmSelfCta')}
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={cancelApproval}
                className="flex-1 rounded-md bg-zinc-200 dark:bg-zinc-700 px-4 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-300 dark:hover:bg-zinc-600 disabled:opacity-50"
                data-testid="identity-confirm-cancel"
              >
                {t('oauth.device.identityConfirmCancel')}
              </button>
            </div>
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
            {decided === 'approved' && approvedAs
              ? t('oauth.device.approvedAsBanner', { name: approvedAs })
              : decided === 'approved'
                ? t('oauth.device.approvedBanner')
                : t('oauth.device.deniedBanner')}
          </div>
        )}

        <div className="mt-6 flex gap-3">
          <button
            type="button"
            disabled={!lookup || submitting || decided !== null || confirmingIdentity || !hasValidSelection}
            onClick={requestApproval}
            className="flex-1 rounded-md bg-blue-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-600 disabled:cursor-not-allowed disabled:bg-zinc-300 dark:disabled:bg-zinc-600"
            data-testid="approve-btn"
          >
            {t('oauth.device.approve')}
          </button>
          <button
            type="button"
            disabled={!lookup || submitting || decided !== null || confirmingIdentity}
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