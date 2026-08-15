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
    <div className="space-y-4" data-testid="oauth-settings">
      <h2 className="text-xl font-semibold dark:text-slate-100">
        {t('oauth.admin.title')}
      </h2>
      <p className="text-sm text-slate-600 dark:text-slate-400">
        {t('oauth.admin.subtitle')}
      </p>

      {error && (
        <div className="p-3 rounded-md bg-red-50 text-red-700 text-sm" role="alert">
          {error}
        </div>
      )}
      {success && (
        <div className="p-3 rounded-md bg-green-50 text-green-700 text-sm">
          {success}
        </div>
      )}

      <div className="flex gap-2 border-b border-slate-200 dark:border-slate-700">
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

      {loading && <p className="text-sm text-slate-500">{t('oauth.admin.loading')}</p>}

      {tab === 'clients' && isAdmin && (
        <div className="space-y-2" data-testid="oauth-clients-list">
          <p className="text-xs text-slate-500">
            {t('oauth.admin.dynamicRegistration', { enabled: dynamicEnabled })}
          </p>
          {clients.length === 0 && !loading && (
            <p className="text-sm text-slate-500">{t('oauth.admin.noClients')}</p>
          )}
          {clients.map((c) => (
            <div
              key={c.id}
              className="p-3 border border-slate-200 dark:border-slate-700 rounded-md flex justify-between items-start"
              data-testid="oauth-client-row"
            >
              <div className="space-y-1">
                <p className="font-medium dark:text-slate-100">{c.name}</p>
                <p className="text-xs text-slate-500 font-mono">{c.clientId}</p>
                <p className="text-xs text-slate-600 dark:text-slate-400">
                  {c.grantTypes.join(', ') || '—'}
                </p>
                <p className="text-xs text-slate-600 dark:text-slate-400">
                  {c.scopes.join(' ') || '—'}
                </p>
              </div>
              <button
                type="button"
                className="text-xs text-red-600 hover:underline"
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
        <div className="space-y-2" data-testid="oauth-consents-list">
          {consents.length === 0 && !loading && (
            <p className="text-sm text-slate-500">{t('oauth.admin.noConsents')}</p>
          )}
          {consents.map((c) => (
            <div
              key={c.clientId}
              className="p-3 border border-slate-200 dark:border-slate-700 rounded-md flex justify-between items-start"
              data-testid="oauth-consent-row"
            >
              <div>
                <p className="font-medium dark:text-slate-100">
                  {c.clientName || c.clientId}
                </p>
                <p className="text-xs text-slate-500 font-mono">{c.clientId}</p>
                <p className="text-xs text-slate-600 dark:text-slate-400">{c.scope}</p>
              </div>
              <button
                type="button"
                className="text-xs text-red-600 hover:underline"
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
              className="p-3 border border-slate-200 dark:border-slate-700 rounded-md"
            >
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                {row.key}
              </label>
              <p className="text-xs text-slate-500 mb-1">{row.description}</p>
              <input
                type="text"
                value={row.value}
                onChange={(e) =>
                  setConfig((prev) =>
                    prev.map((p) => (p.key === row.key ? { ...p, value: e.target.value } : p))
                  )
                }
                className="w-full px-2 py-1 text-sm border rounded dark:bg-slate-900 dark:border-slate-700 dark:text-slate-100"
                data-testid={`oauth-config-${row.key}`}
              />
              <p className="text-xs text-slate-400 mt-1">default: {row.default}</p>
            </div>
          ))}
          <button
            type="button"
            className="px-4 py-2 rounded-md bg-purple-600 hover:bg-purple-700 text-white"
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
      className={`px-4 py-2 text-sm font-medium border-b-2 ${
        active
          ? 'border-purple-600 text-purple-700 dark:text-purple-300'
          : 'border-transparent text-slate-600 hover:text-slate-900 dark:text-slate-400'
      }`}
    >
      {children}
    </button>
  );
}