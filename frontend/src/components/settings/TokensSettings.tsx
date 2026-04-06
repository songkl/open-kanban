import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { authApi } from '../../services/api';
import { showErrorToast } from '../ErrorToast';
import type { Token } from '../../types/kanban';

interface TokensSettingsProps {
  onLoadTokens: () => Promise<Token[]>;
}

export function TokensSettings({ onLoadTokens }: TokensSettingsProps) {
  const { t } = useTranslation();
  const [tokens, setTokens] = useState<Token[]>([]);
  const [newTokenName, setNewTokenName] = useState('');
  const [creatingToken, setCreatingToken] = useState(false);
  const [editingTokenId, setEditingTokenId] = useState<string | null>(null);
  const [editingTokenName, setEditingTokenName] = useState('');
  const [loading, setLoading] = useState(false);

  const loadTokens = useCallback(async () => {
    setLoading(true);
    try {
      const data = await onLoadTokens();
      setTokens(data);
    } catch (err) {
      console.error('Failed to load tokens:', err);
    } finally {
      setLoading(false);
    }
  }, [onLoadTokens]);

  useEffect(() => {
    loadTokens();
  }, [loadTokens]);

  const handleCreateToken = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTokenName.trim()) return;

    setCreatingToken(true);
    try {
      await authApi.createToken(newTokenName.trim());
      await loadTokens();
      setNewTokenName('');
      showErrorToast(t('settings.tokenCreated'), 'info');
    } catch (err) {
      console.error('Failed to create token:', err);
      showErrorToast(t('settings.tokenCreateFailed'), 'error');
    } finally {
      setCreatingToken(false);
    }
  };

  const handleUpdateToken = async (id: string) => {
    if (!editingTokenName.trim()) return;

    try {
      await authApi.updateToken(id, editingTokenName.trim());
      await loadTokens();
      setEditingTokenId(null);
      setEditingTokenName('');
    } catch (err) {
      console.error('Failed to update token:', err);
    }
  };

  const handleDeleteToken = async (id: string) => {
    try {
      await authApi.deleteToken(id);
      await loadTokens();
    } catch (err) {
      console.error('Failed to delete token:', err);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <h2 className="text-lg font-semibold text-zinc-800">{t('settings.tokens')}</h2>
        <div className="py-8 text-center text-zinc-500">{t('common.loading')}</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-zinc-800">{t('settings.tokens')}</h2>
      <p className="text-sm text-zinc-500">{t('settings.tokenDescription')}</p>

      <form onSubmit={handleCreateToken} className="flex gap-3">
        <input
          type="text"
          value={newTokenName}
          onChange={(e) => setNewTokenName(e.target.value)}
          placeholder={t('settings.tokenNamePlaceholder')}
          className="flex-1 rounded-md border border-zinc-300 px-4 py-2 focus:border-blue-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={creatingToken || !newTokenName.trim()}
          className="rounded-md bg-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600 disabled:bg-zinc-300"
        >
          {creatingToken ? t('settings.creating') : t('settings.createToken')}
        </button>
      </form>

      <div className="space-y-3">
        {tokens.map((token) => (
          <div key={token.id} className="flex items-center justify-between rounded-lg border border-zinc-200 p-4">
            <div className="flex-1">
              {editingTokenId === token.id ? (
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={editingTokenName}
                    onChange={(e) => setEditingTokenName(e.target.value)}
                    className="rounded-md border border-zinc-300 px-3 py-1 text-sm focus:border-blue-500 focus:outline-none"
                    autoFocus
                  />
                  <button
                    onClick={() => handleUpdateToken(token.id)}
                    className="rounded bg-green-500 px-2 py-1 text-xs text-white hover:bg-green-600"
                  >
                    {t('settings.save')}
                  </button>
                  <button
                    onClick={() => setEditingTokenId(null)}
                    className="rounded bg-zinc-200 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-300"
                  >
                    {t('settings.cancel')}
                  </button>
                </div>
              ) : (
                <div>
                  <div className="font-medium text-zinc-800">{token.name}</div>
                  <div className="font-mono text-sm text-zinc-500">{token.key}</div>
                  <div className="mt-1 text-xs text-zinc-400">
                    {t('settings.createdAt', { date: new Date(token.createdAt).toLocaleDateString() })}
                  </div>
                </div>
              )}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  setEditingTokenId(token.id);
                  setEditingTokenName(token.name);
                }}
                className="rounded bg-zinc-100 px-3 py-1 text-sm text-zinc-600 hover:bg-zinc-200"
              >
                {t('settings.rename')}
              </button>
              <button
                onClick={() => handleDeleteToken(token.id)}
                className="rounded bg-red-50 px-3 py-1 text-sm text-red-600 hover:bg-red-100"
              >
                {t('settings.delete')}
              </button>
            </div>
          </div>
        ))}
        {tokens.length === 0 && (
          <div className="py-8 text-center text-zinc-500">{t('settings.noTokens')}</div>
        )}
      </div>
    </div>
  );
}
