import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { boardsApi, type ViewerToken } from '../services/api';
import { ConfirmDialog } from './ConfirmDialog';

interface ShareBoardModalProps {
  open: boolean;
  onClose: () => void;
  boardId: string;
}

interface JustMinted {
  token: string;
  label: string;
  expiresAt: string | null;
}

function formatExpiry(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function ShareBoardModal({ open, onClose, boardId }: ShareBoardModalProps) {
  const { t } = useTranslation();
  const [tokens, setTokens] = useState<ViewerToken[]>([]);
  const [loading, setLoading] = useState(false);
  const [minting, setMinting] = useState(false);
  const [label, setLabel] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [justMinted, setJustMinted] = useState<JustMinted | null>(null);
  const [snippet, setSnippet] = useState<string>('');
  const [snippetSrc, setSnippetSrc] = useState<string>('');
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');

  useEffect(() => {
    if (!open) {
      setJustMinted(null);
      setSnippet('');
      setSnippetSrc('');
      setError(null);
      setLabel('');
      setExpiresAt('');
      setCopyState('idle');
      return;
    }
    let cancelled = false;
    setLoading(true);
    boardsApi
      .listViewerTokens(boardId)
      .then((data) => {
        if (cancelled) return;
        setTokens(data.tokens ?? []);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, boardId]);

  const handleMint = async () => {
    setError(null);
    setMinting(true);
    try {
      const expiresAtIso = expiresAt ? new Date(expiresAt).toISOString() : null;
      const minted = await boardsApi.mintViewerToken(boardId, {
        label: label.trim(),
        expiresAt: expiresAtIso,
      });
      setJustMinted({
        token: minted.token ?? '',
        label: minted.label,
        expiresAt: minted.expiresAt ?? null,
      });
      setLabel('');
      setExpiresAt('');
      // Refresh the list now that we know the token exists.
      const refreshed = await boardsApi.listViewerTokens(boardId);
      setTokens(refreshed.tokens ?? []);
      try {
        const snippetResp = await boardsApi.getViewerEmbedSnippet(boardId, minted.token ?? '');
        setSnippet(snippetResp.snippet);
        setSnippetSrc(snippetResp.src);
      } catch {
        setSnippet('');
        setSnippetSrc('');
      }
    } catch (err) {
      setError((err as Error).message || t('share.failed', 'Could not mint share link'));
    } finally {
      setMinting(false);
    }
  };

  const handleCopy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 1500);
    } catch {
      // Clipboard denied: leave the value in the input so the user
      // can copy manually.
    }
  };

  const handleRevoke = async (tokenId: string) => {
    setConfirmRevokeId(null);
    try {
      await boardsApi.revokeViewerToken(boardId, tokenId);
      const refreshed = await boardsApi.listViewerTokens(boardId);
      setTokens(refreshed.tokens ?? []);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      data-testid="share-board-modal"
    >
      <div className="w-full max-w-2xl rounded-xl bg-white dark:bg-zinc-900 shadow-xl">
        <header className="flex items-center justify-between border-b border-zinc-200 dark:border-zinc-700 px-5 py-3">
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
            {t('share.modalTitle', 'Share board')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            aria-label={t('common.close', 'Close')}
          >
            ✕
          </button>
        </header>

        <div className="space-y-4 px-5 py-4 max-h-[70vh] overflow-y-auto">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {t(
              'share.modalDescription',
              'Mint a public, read-only link for stakeholders. The token is shown exactly once — copy it before closing this dialog.'
            )}
          </p>

          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <div className="space-y-2">
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder={t('share.labelPlaceholder', 'Label (e.g. Stakeholder demo)')}
                maxLength={200}
                className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100"
                data-testid="share-label-input"
              />
              <input
                type="datetime-local"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100"
                title={t('share.setExpiry', 'Set expiry (optional)')}
                data-testid="share-expiry-input"
              />
            </div>
            <button
              type="button"
              onClick={handleMint}
              disabled={minting}
              className="self-end rounded-md bg-blue-600 hover:bg-blue-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              data-testid="share-mint-button"
            >
              {minting
                ? t('share.minting', 'Mint…')
                : t('share.mint', 'Mint share link')}
            </button>
          </div>

          {error && (
            <div className="rounded-md border border-red-300 bg-red-50 dark:bg-red-900/30 dark:border-red-700 px-3 py-2 text-sm text-red-700 dark:text-red-200">
              {error}
            </div>
          )}

          {justMinted && (
            <div
              className="space-y-2 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/30 p-3"
              data-testid="share-just-minted"
            >
              <div className="text-sm font-medium text-amber-800 dark:text-amber-200">
                {t('share.created', 'Share link ready. Copy it now — it will not be shown again.')}
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  readOnly
                  value={justMinted.token}
                  className="flex-1 rounded-md border border-amber-300 dark:border-amber-700 bg-white dark:bg-zinc-800 px-2 py-1 font-mono text-xs text-zinc-900 dark:text-zinc-100"
                  data-testid="share-plaintext-input"
                />
                <button
                  type="button"
                  onClick={() => handleCopy(justMinted.token)}
                  className="rounded-md border border-amber-400 dark:border-amber-600 px-3 py-1 text-xs font-medium text-amber-800 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-800/40"
                >
                  {copyState === 'copied' ? t('share.copied', 'Copied') : t('share.copy', 'Copy')}
                </button>
              </div>
              {snippetSrc && (
                <div className="space-y-1 pt-2">
                  <div className="text-xs font-medium text-amber-800 dark:text-amber-200">
                    {t('share.publicUrl', 'Public URL')}
                  </div>
                  <code className="block break-all rounded bg-white/60 dark:bg-zinc-800/60 px-2 py-1 text-xs">
                    {snippetSrc}
                  </code>
                </div>
              )}
            </div>
          )}

          {snippet && (
            <div className="space-y-2 rounded-md border border-zinc-200 dark:border-zinc-700 p-3">
              <div className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                {t('share.embed', 'Embed in another site')}
              </div>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                {t('share.embedDescription', 'Paste this iframe snippet into your site to embed a read-only view of this board.')}
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  readOnly
                  value={snippet}
                  className="flex-1 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-1 font-mono text-xs"
                />
                <button
                  type="button"
                  onClick={() => handleCopy(snippet)}
                  className="rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-1 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  {copyState === 'copied' ? t('share.copied', 'Copied') : t('share.copy', 'Copy')}
                </button>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
              {t('share.modalTitle', 'Share board')}
            </h3>
            {loading ? (
              <div className="text-xs text-zinc-500 dark:text-zinc-400">…</div>
            ) : tokens.length === 0 ? (
              <div className="text-xs text-zinc-500 dark:text-zinc-400">
                {t('share.noTokensYet', 'No share links yet.')}
              </div>
            ) : (
              <ul className="space-y-2" data-testid="share-token-list">
                {tokens.map((tok) => (
                  <li
                    key={tok.id}
                    className="flex items-center justify-between rounded-md border border-zinc-200 dark:border-zinc-700 px-3 py-2 text-sm"
                  >
                    <div>
                      <div className="font-medium text-zinc-900 dark:text-zinc-100">
                        {tok.label || tok.id}
                      </div>
                      <div className="text-xs text-zinc-500 dark:text-zinc-400">
                        {tok.expiresAt
                          ? `${t('share.expiresAt', 'Expires at')}: ${formatExpiry(tok.expiresAt)}`
                          : t('share.neverExpires', 'Never expires')}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setConfirmRevokeId(tok.id)}
                      className="rounded-md border border-red-300 dark:border-red-700 px-3 py-1 text-xs font-medium text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/30"
                      data-testid="share-revoke-button"
                    >
                      {t('common.delete', 'Revoke')}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      <ConfirmDialog
        isOpen={confirmRevokeId !== null}
        title={t('share.modalTitle', 'Share board')}
        message={t(
          'share.revokeConfirm',
          'Revoke this share link? Anyone holding the URL will lose access immediately.'
        )}
        variant="danger"
        onConfirm={() => confirmRevokeId && handleRevoke(confirmRevokeId)}
        onCancel={() => setConfirmRevokeId(null)}
        confirmText={t('common.delete', 'Revoke')}
        cancelText={t('common.cancel', 'Cancel')}
      />
    </div>
  );
}