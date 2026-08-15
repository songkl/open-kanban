import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authApi } from '../services/api';
import type { OAuthClient, OAuthConsent, OAuthConfigEntry } from '@/types/kanban';

interface Props {
  currentUser: { id: string; role: 'ADMIN' | 'MEMBER' | 'VIEWER' } | null;
}

export function OAuthSettings({ currentUser }: Props) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'clients' | 'consents' | 'config'>('clients');
  const [clients, setClients] = useState<OAuthClient[]>([]);
  const [consents, setConsents] = useState<OAuthConsent[]>([]);
  const [config, setConfig] = useState<OAuthConfigEntry[]>([]);
  const [dynamicEnabled, setDynamicEnabled] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>('');
  const [success, setSuccess] = useState<string>('');

  const isAdmin = currentUser?.role === 'ADMIN';

  const refresh = async () => {
    setLoading(true);
    setError('');
    try {
      if (isAdmin) {
        const [cs, cfg] = await Promise.all([
          authApi.getOAuthClients(),
          authApi.getOAuthConfig()
        ]);
        setClients(cs);
        setConfig(cfg.config);
        setDynamicEnabled(cfg.dynamicRegistrationEnabled);
      }
      const myConsents = await authApi.getOAuthConsents();
      setConsents(myConsents);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDeleteClient = async (clientId: string) => {
    if (!window.confirm(t('oauth.admin.confirmDeleteClient'))) return;
    try {
      await authApi.deleteOAuthClient(clientId);
      setSuccess(t('oauth.admin.clientDeleted'));
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleRevokeConsent = async (clientId: string) => {
    if (!window.confirm(t('oauth.admin.confirmRevoke'))) return;
    try {
      await authApi.revokeOAuthConsent(clientId);
      setSuccess(t('oauth.admin.consentRevoked'));
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleSaveConfig = async () => {
    const updates: Record<string, string> = {};
    config.forEach((row) => {
      if (row.value !== row.default) {
        updates[row.key] = row.value;
      }
    });
    try {
      await authApi.updateOAuthConfig(updates);
      setSuccess(t('oauth.admin.configSaved'));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="space-y-6" data-testid="oauth-settings">
      <h2 className="text-lg font-semibold text-zinc-800 dark:text-zinc-100">
        {t('oauth.admin.title')}
      </h2>
      <p className="text-sm text-zinc-500 dark:text-zinc-500">
        {t('oauth.admin.subtitle')}
      </p>

      {error && (
        <div
          className="rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/30 dark:text-red-400"
          role="alert"
        >
          {error}
        </div>
      )}
      {success && (
        <div className="rounded-md bg-green-50 p-3 text-sm text-green-700 dark:bg-green-900/30 dark:text-green-300">
          {success}
        </div>
      )}

      <div className="flex gap-2 border-b border-zinc-200 dark:border-zinc-700">
        <TabButton active={tab === 'clients'} onClick={() => setTab('clients')}>
          {t('oauth.admin.tabClients')}
        </TabButton>
        <TabButton active={tab === 'consents'} onClick={() => setTab('consents')}>
          {t('oauth.admin.tabConsents')}
        </TabButton>
        {isAdmin && (
          <TabButton active={tab === 'config'} onClick={() => setTab('config')}>
            {t('oauth.admin.tabConfig')}
          </TabButton>
        )}
      </div>

      {loading && <p className="py-8 text-center text-sm text-zinc-500 dark:text-zinc-500">{t('oauth.admin.loading')}</p>}

      {tab === 'clients' && isAdmin && (
        <div className="space-y-3" data-testid="oauth-clients-list">
          <p className="text-xs text-zinc-500 dark:text-zinc-500">
            {t('oauth.admin.dynamicRegistration', { enabled: dynamicEnabled })}
          </p>
          {clients.length === 0 && !loading && (
            <div className="rounded-md border border-zinc-200 dark:border-zinc-700 p-6 text-center text-sm text-zinc-500 dark:text-zinc-500">
              {t('oauth.admin.noClients')}
            </div>
          )}
          {clients.map((c) => (
            <div
              key={c.id}
              className="flex items-start justify-between rounded-lg border border-zinc-200 dark:border-zinc-700 p-4"
              data-testid="oauth-client-row"
            >
              <div className="space-y-1">
                <div className="font-medium text-zinc-800 dark:text-zinc-100">{c.name}</div>
                <div className="font-mono text-xs text-zinc-500 dark:text-zinc-500">{c.clientId}</div>
                <div className="text-xs text-zinc-500 dark:text-zinc-500">
                  {c.grantTypes.join(', ') || '—'}
                </div>
                <div className="text-xs text-zinc-500 dark:text-zinc-500">
                  {c.scopes.join(' ') || '—'}
                </div>
              </div>
              <button
                type="button"
                className="rounded bg-red-50 px-3 py-1 text-sm text-red-600 hover:bg-red-100 dark:bg-red-900/30 dark:text-red-300 dark:hover:bg-red-900/50"
                onClick={() => handleDeleteClient(c.clientId)}
                data-testid="oauth-delete-client"
              >
                {t('common.delete')}
              </button>
            </div>
          ))}
        </div>
      )}

      {tab === 'consents' && (
        <div className="space-y-3" data-testid="oauth-consents-list">
          {consents.length === 0 && !loading && (
            <div className="rounded-md border border-zinc-200 dark:border-zinc-700 p-6 text-center text-sm text-zinc-500 dark:text-zinc-500">
              {t('oauth.admin.noConsents')}
            </div>
          )}
          {consents.map((c) => (
            <div
              key={c.clientId}
              className="flex items-start justify-between rounded-lg border border-zinc-200 dark:border-zinc-700 p-4"
              data-testid="oauth-consent-row"
            >
              <div className="space-y-1">
                <div className="font-medium text-zinc-800 dark:text-zinc-100">
                  {c.clientName || c.clientId}
                </div>
                <div className="font-mono text-xs text-zinc-500 dark:text-zinc-500">{c.clientId}</div>
                <div className="text-xs text-zinc-500 dark:text-zinc-500">{c.scope}</div>
              </div>
              <button
                type="button"
                className="rounded bg-red-50 px-3 py-1 text-sm text-red-600 hover:bg-red-100 dark:bg-red-900/30 dark:text-red-300 dark:hover:bg-red-900/50"
                onClick={() => handleRevokeConsent(c.clientId)}
                data-testid="oauth-revoke-consent"
              >
                {t('oauth.admin.revoke')}
              </button>
            </div>
          ))}
        </div>
      )}

      {tab === 'config' && isAdmin && (
        <div className="space-y-3" data-testid="oauth-config-list">
          {config.map((row) => (
            <div
              key={row.key}
              className="space-y-1 rounded-lg border border-zinc-200 dark:border-zinc-700 p-4"
            >
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-400">
                {row.key}
              </label>
              <p className="text-xs text-zinc-500 dark:text-zinc-500">{row.description}</p>
              <input
                type="text"
                value={row.value}
                onChange={(e) =>
                  setConfig((prev) =>
                    prev.map((p) => (p.key === row.key ? { ...p, value: e.target.value } : p))
                  )
                }
                className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-4 py-2 text-sm focus:border-blue-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100"
                data-testid={`oauth-config-${row.key}`}
              />
              <p className="text-xs text-zinc-400 dark:text-zinc-400">default: {row.default}</p>
            </div>
          ))}
          <button
            type="button"
            className="rounded-md bg-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600"
            onClick={handleSaveConfig}
            data-testid="oauth-save-config"
          >
            {t('common.save')}
          </button>
        </div>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
        active
          ? 'border-blue-500 text-blue-600 dark:text-blue-400'
          : 'border-transparent text-zinc-500 dark:text-zinc-500 dark:hover:text-zinc-200'
      }`}
    >
      {children}
    </button>
  );
}