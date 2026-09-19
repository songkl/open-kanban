import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { oauthDeviceApi } from '../services/api';
import type { PermissionAccess } from '../types/kanban';

interface DeviceLookupAgent {
  id: string;
  nickname?: string;
  username?: string;
  role?: string;
}

interface _DeviceLookup {
  clientId: string;
  clientName: string;
  scope: string;
  expiresAt: string;
  status: string;
  agentSelectionRequired?: boolean;
  agent_selection_required?: boolean;
  availableAgents?: DeviceLookupAgent[];
  available_agents?: DeviceLookupAgent[];
  defaultAgentId?: string;
}
void 0 as unknown as _DeviceLookup;

export function OAuthDevicePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const userCode = params.get('user_code') || '';
  const [identity, setIdentity] = useState<string>('');
  const [availableBoards, _setAvailableBoards] = useState<Array<{ id: string; name: string; access: PermissionAccess }>>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const lookup = await oauthDeviceApi.lookup(userCode);
        if (cancelled) return;
        const agents = lookup.availableAgents || lookup.available_agents || [];
        if (agents.length > 0) setIdentity(agents[0].id);
      } catch {
        // ignore
      }
    })();
    return () => { cancelled = true; };
  }, [userCode]);

  const handleApprove = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await oauthDeviceApi.approve({
        userCode,
        decision: 'approve',
        agentId: identity || undefined,
      });
      navigate('/');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to approve');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeny = async () => {
    setSubmitting(true);
    try {
      await oauthDeviceApi.approve({
        userCode,
        decision: 'deny',
        agentId: identity || undefined,
      });
      navigate('/');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-md mx-auto mt-12 p-6 bg-white dark:bg-zinc-900 rounded shadow">
      <h1 className="text-xl font-semibold mb-2">
        {t('oauth.device.title')}
      </h1>
      <p className="text-zinc-500 mb-4">
        {t('oauth.device.userCode', { code: userCode })}
      </p>
      {availableBoards.length > 0 && (
        <div className="mb-4">
          <label className="block text-sm mb-1">
            {t('oauth.device.selectBoards')}
          </label>
          {availableBoards.map((b) => (
            <div key={b.id}>{b.name} ({b.access})</div>
          ))}
        </div>
      )}
      {error && (
        <div className="text-red-500 mb-3">{error}</div>
      )}
      <div className="flex gap-2">
        <button
          className="px-4 py-2 rounded bg-zinc-200 dark:bg-zinc-700"
          onClick={handleDeny}
          disabled={submitting}
        >
          {t('oauth.device.deny')}
        </button>
        <button
          className="px-4 py-2 rounded bg-blue-500 text-white"
          onClick={handleApprove}
          disabled={submitting || !userCode}
        >
          {t('oauth.device.approve')}
        </button>
      </div>
    </div>
  );
}
