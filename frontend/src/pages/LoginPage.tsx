import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { boardsApi, authApi } from '../services/api';
import type { PublicOAuthProvider } from '../types/kanban';

// buildAuthorizeURL assembles the standard OAuth 2.0 authorization-
// code URL the /login page redirects the user to. The plan (§4.1)
// defers PKCE and the server-minted `state` to s-1145; for the
// s-1144 milestone the client-side `state` is a transient nonce
// that the post-callback POST forwards verbatim — the server
// accepts it but does not validate it yet, mirroring the
// ExternalCallbackHandler seam at external_callback.go:589-591.
function buildAuthorizeURL(
  provider: PublicOAuthProvider,
  redirectURI: string,
  state: string
): string {
  const base = provider.authEndpoint.trim();
  if (!base) return '';
  const params = new URLSearchParams();
  params.set('client_id', provider.clientId);
  params.set('redirect_uri', redirectURI);
  params.set('response_type', 'code');
  params.set('state', state);
  if (provider.scopes.trim()) {
    params.set('scope', provider.scopes.trim());
  }
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}${params.toString()}`;
}

// generateStateNonce is a 32-byte random nonce rendered as
// base64url. We keep it short-lived (memory only — not stored in
// localStorage) because the server does not validate it yet; the
// real state cookie ships with s-1145.
function generateStateNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  bytes.forEach(b => {
    binary += String.fromCharCode(b);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [requirePassword, setRequirePassword] = useState(false);
  const [providers, setProviders] = useState<PublicOAuthProvider[]>([]);
  const [providersError, setProvidersError] = useState('');

  const redirectAfterLogin = useCallback(() => {
    boardsApi.getAll().then((boards) => {
      if (boards && boards.length > 0) {
        navigate(`/board/${boards[0].id}`);
      } else {
        navigate('/boards');
      }
    }).catch(() => navigate('/boards'));
  }, [navigate]);

  useEffect(() => {
    authApi.me().then((data) => {
      if (data.needsSetup) {
        navigate('/setup');
        return;
      }
      if (data.requirePassword !== undefined) {
        setRequirePassword(data.requirePassword);
      }
    }).catch(console.error);
  }, [navigate]);

  // Fetch the enabled external providers so the buttons can
  // render above the password form (plan §4.3). Failure is
  // non-fatal: a misconfigured server (or a deployment that
  // disables the feature) just hides the section.
  useEffect(() => {
    let cancelled = false;
    authApi
      .getEnabledExternalProviders()
      .then(list => {
        if (cancelled) return;
        const sorted = [...list].sort((a, b) => a.position - b.position);
        setProviders(sorted);
      })
      .catch(() => {
        if (!cancelled) setProvidersError(t('login.external.loadError'));
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  // Post-callback handling: when the IdP redirects back to
  // /login?code=xxx&state=yyy&provider=zzz, exchange the code
  // for a kanban session via the existing POST
  // /oauth/external/:slug/callback endpoint, then navigate to a
  // board. Errors are surfaced inline; on success we drop the
  // ?code / ?state / ?provider params so a refresh does not
  // re-submit.
  //
  // We dedupe on (code, provider) via a ref so the effect does
  // not fire a second POST when the searchParams reference is
  // refreshed (useSearchParams returns a fresh tuple on every
  // render and including it in deps would loop). The ref also
  // guards against double-invocation in React 19 strict mode.
  const processedCallbackRef = useRef<string | null>(null);
  useEffect(() => {
    const code = searchParams.get('code');
    const providerSlug = searchParams.get('provider');
    const state = searchParams.get('state') || '';
    if (!code || !providerSlug) return;

    const dedupeKey = `${providerSlug}::${code}`;
    if (processedCallbackRef.current === dedupeKey) return;
    processedCallbackRef.current = dedupeKey;

    let cancelled = false;
    setLoginLoading(true);
    setLoginError('');
    authApi
      .completeExternalLogin(providerSlug, { code, state })
      .then(() => {
        if (cancelled) return;
        const next = new URLSearchParams(searchParams);
        next.delete('code');
        next.delete('state');
        next.delete('provider');
        setSearchParams(next, { replace: true });
        redirectAfterLogin();
      })
      .catch(err => {
        if (cancelled) return;
        setLoginError(
          (err instanceof Error && err.message) || t('login.external.callbackError')
        );
      })
      .finally(() => {
        if (!cancelled) setLoginLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // setSearchParams returns a new function each render in
    // react-router-dom v7; deliberately listing only the stable
    // inputs and using a ref for the dedupe key avoids the
    // infinite-update loop that the array-style deps would
    // produce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim()) {
      setLoginError(t('login.enterNickname'));
      return;
    }

    setLoginLoading(true);
    setLoginError('');

    try {
      const res = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: username.trim(),
          password: password,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        if (data.requirePassword) {
          setRequirePassword(true);
        }
        setLoginError(data.error || t('login.failed'));
        return;
      }

      if (data.board) {
        navigate(`/board/${data.board.id}`);
      } else {
        redirectAfterLogin();
      }
    } catch {
      setLoginError(t('login.failed'));
    } finally {
      setLoginLoading(false);
    }
  };

  const handleProviderClick = (provider: PublicOAuthProvider) => {
    // The redirect_uri is the current /login URL so the IdP
    // bounce-back lands on the post-callback effect above.
    // providerSlug is forwarded via the `state` field for now
    // (a back-channel would carry it more cleanly, but until
    // s-1145 the server does not validate state and accepts
    // ?provider= directly on /login).
    const redirectURI = `${window.location.origin}/login?provider=${encodeURIComponent(provider.providerId)}`;
    const state = generateStateNonce();
    const url = buildAuthorizeURL(provider, redirectURI, state);
    if (!url) {
      setLoginError(t('login.external.missingEndpoint'));
      return;
    }
    window.location.href = url;
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-100 dark:bg-zinc-900">
      <div className="w-full max-w-md rounded-xl bg-white dark:bg-zinc-800 p-8 shadow-lg">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-bold text-zinc-800 dark:text-zinc-100">Open kanban</h1>
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-500">{t('login.welcome')}</p>
        </div>

        {providers.length > 0 && (
          <div className="mb-6 space-y-3" data-testid="external-providers">
            {providers.map((provider) => (
              <button
                key={provider.providerId}
                type="button"
                onClick={() => handleProviderClick(provider)}
                disabled={loginLoading}
                data-testid={`external-provider-${provider.providerId}`}
                className="flex w-full items-center justify-center gap-2 rounded-md border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-700 py-3 font-medium text-zinc-700 dark:text-zinc-100 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t('login.external.signInWith', { provider: provider.name })}
              </button>
            ))}
            {providers.length > 0 && (
              <div className="flex items-center gap-3 text-xs text-zinc-400 dark:text-zinc-500">
                <div className="h-px flex-1 bg-zinc-200 dark:bg-zinc-600" />
                <span>{t('login.external.or')}</span>
                <div className="h-px flex-1 bg-zinc-200 dark:bg-zinc-600" />
              </div>
            )}
          </div>
        )}

        {providersError && (
          <div className="mb-4 rounded-md bg-red-50 dark:bg-red-900/30 p-3 text-sm text-red-600 dark:text-red-400">
            {providersError}
          </div>
        )}

        <form onSubmit={handleLogin} className="space-y-6">
          <div>
            <label className="mb-2 block text-sm font-medium text-zinc-700 dark:text-zinc-400">
              {t('login.username')}
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={t('login.enterNickname')}
              className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-4 py-3 focus:border-blue-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100"
              maxLength={20}
            />
          </div>

          {requirePassword && (
            <div>
              <label className="mb-2 block text-sm font-medium text-zinc-700 dark:text-zinc-400">
                {t('login.password')}
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t('login.enterPassword')}
                className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-4 py-3 focus:border-blue-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100"
              />
            </div>
          )}

          {loginError && (
            <div className="rounded-md bg-red-50 dark:bg-red-900/30 p-3 text-sm text-red-600 dark:text-red-400">
              {loginError}
            </div>
          )}

          <button
            type="submit"
            disabled={loginLoading || !username.trim()}
            className="w-full rounded-md bg-blue-500 py-3 font-medium text-white transition-colors hover:bg-blue-600 disabled:cursor-not-allowed disabled:bg-zinc-300 dark:disabled:bg-zinc-600"
          >
            {loginLoading ? t('login.loggingIn') : t('login.start')}
          </button>
        </form>
      </div>
    </div>
  );
}
