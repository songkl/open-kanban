import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { authApi, type AdvancedConfig } from '@/services/api';

type DbType = 'sqlite' | 'mysql';

interface AdvancedFormConfig extends AdvancedConfig {
  dbType: DbType;
  dbPath: string;
  dbHost: string;
  dbPort: string;
  dbUser: string;
  dbPassword: string;
  dbName: string;
  serverPort: string;
  allowedOrigins: string;
}

// currentOrigin() returns the browser's current origin (e.g.
// "http://localhost:8080") for use as the default CORS allowed
// origin. In jsdom (tests) the URL is "http://localhost:3000" by
// default, which is what the SetupPage tests rely on. We guard
// against SSR / non-browser environments by falling back to ''.
function currentOrigin(): string {
  if (typeof window === 'undefined' || !window.location) return '';
  return window.location.origin;
}

const DEFAULT_ADVANCED: AdvancedFormConfig = {
  dbType: 'sqlite',
  dbPath: 'kanban.db',
  dbHost: 'localhost',
  dbPort: '3306',
  dbUser: 'root',
  dbPassword: '',
  dbName: 'kanban',
  serverPort: '8080',
  // Pre-fill with the browser's current origin so a user setting up
  // the server from its own UI is allowed by CORS out of the box. The
  // user can append more origins (comma-separated) if they also need
  // to access the API from a different host.
  allowedOrigins: currentOrigin(),
};

const ALREADY_INITIALIZED_PATTERN = /already\s*initialized|system\s+already/i;

// How long to keep polling /auth/me after init before giving up. The
// server triggers a self-restart on init, which can take a few seconds
// to bring the new process up; this budget is generous enough to cover
// slow MySQL handshakes, schema migrations, and embedding extraction.
const RESTART_POLL_TIMEOUT_MS = 60_000;
const RESTART_POLL_INITIAL_DELAY_MS = 300;
const RESTART_POLL_MAX_DELAY_MS = 2_000;

function pickDbType(raw: AdvancedConfig['dbType']): DbType {
  return raw === 'mysql' ? 'mysql' : 'sqlite';
}

// All DB types the setup wizard knows how to render. The dropdown is
// filtered against the server's `supportedDbTypes` so users on a
// MySQL-only build can't pick SQLite (and vice versa).
const ALL_DB_TYPES: DbType[] = ['sqlite', 'mysql'];

// pickSupportedDbType returns the first type that is both in
// `supported` and in `ALL_DB_TYPES`. Falls back to `fallback` when the
// server didn't send a supported list (legacy / unversioned).
export function pickSupportedDbType(
  raw: AdvancedConfig['dbType'] | undefined,
  supported: AdvancedConfig['supportedDbTypes'] | undefined,
  fallback: DbType
): DbType {
  const allowed = supported && supported.length > 0 ? supported : ALL_DB_TYPES;
  const requested = pickDbType(raw);
  if (allowed.includes(requested)) return requested;
  return allowed[0] ?? fallback;
}

export function SetupPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [advancedConfig, setAdvancedConfig] = useState<AdvancedFormConfig>(DEFAULT_ADVANCED);
  const [supportedDbTypes, setSupportedDbTypes] = useState<DbType[]>(ALL_DB_TYPES);
  const [prefilled, setPrefilled] = useState(false);
  const submittingRef = useRef(false);
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);

  // If the system is already initialized, the setup form is the wrong place
  // to be. Bounce to /boards (already signed in) or /login (signed out).
  useEffect(() => {
    let cancelled = false;
    authApi
      .me()
      .then((data) => {
        if (cancelled) return;
        if (!data.needsSetup) {
          navigate(data.user ? '/boards' : '/login', { replace: true });
        }
      })
      .catch(() => {
        /* stay on setup if the server is unreachable */
      });
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  // Pre-fill the advanced form from the server's currently-loaded config so
  // running with `-config kanban.env` (or auto-detected kanban.env) means
  // the setup form starts with those values, not generic defaults.
  useEffect(() => {
    if (prefilled) return;
    authApi
      .getInitDefaults()
      .then((data) => {
        if (prefilled) return;
        const supported =
          data.supportedDbTypes && data.supportedDbTypes.length > 0
            ? (data.supportedDbTypes as DbType[])
            : ALL_DB_TYPES;
        setSupportedDbTypes(supported);
        setAdvancedConfig({
          dbType: pickSupportedDbType(data.dbType, data.supportedDbTypes, DEFAULT_ADVANCED.dbType),
          dbPath: data.dbPath ?? DEFAULT_ADVANCED.dbPath,
          dbHost: data.dbHost ?? DEFAULT_ADVANCED.dbHost,
          dbPort: data.dbPort ?? DEFAULT_ADVANCED.dbPort,
          dbUser: data.dbUser ?? DEFAULT_ADVANCED.dbUser,
          dbPassword: data.dbPassword ?? DEFAULT_ADVANCED.dbPassword,
          dbName: data.dbName ?? DEFAULT_ADVANCED.dbName,
          serverPort: data.serverPort ?? DEFAULT_ADVANCED.serverPort,
          // If the server has no ALLOWED_ORIGINS env var configured,
          // keep the frontend default (the current origin) rather
          // than blanking the field. Operators who set ALLOWED_ORIGINS
          // explicitly get their value, even if it's a single host.
          allowedOrigins: data.allowedOrigins?.trim() || DEFAULT_ADVANCED.allowedOrigins,
        });
        setPrefilled(true);
      })
      .catch(() => {
        setPrefilled(true);
      });
  }, [prefilled]);

  // After a successful init the server self-restarts to pick up the
  // freshly-written kanban.env. We poll /auth/me until the replacement
  // process is accepting connections again, then route the user away
  // from the setup page. Doing a hard `window.location.href = '/'`
  // immediately would race the restart and the browser would hit a
  // dead listener, leaving the user staring at a blank page.
  useEffect(() => {
    if (!restarting) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = Date.now() + RESTART_POLL_TIMEOUT_MS;
    let delay = RESTART_POLL_INITIAL_DELAY_MS;

    const attempt = () => {
      if (cancelled) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        setRestartError(t('setup.restartTimeout'));
        return;
      }
      authApi
        .me()
        .then((data) => {
          if (cancelled) return;
          // The OLD server (SQLite path) still has the user created by init.
          // The NEW server (MySQL/whatever path the user picked) will report
          // `needsSetup=false` only after the first user is migrated. Either
          // way, the fact that we got a structured response means the server
          // is back, so navigate.
          if (!data.needsSetup) {
            navigate(data.user ? '/boards' : '/login', { replace: true });
            return;
          }
          // Server is back but DB is empty (rare race after restart). Wait
          // one more cycle so the user lands on a populated landing page.
          schedule(delay);
        })
        .catch(() => {
          // Server still restarting. Try again with exponential backoff.
          schedule(Math.min(delay * 2, RESTART_POLL_MAX_DELAY_MS, remaining));
        });
    };

    const schedule = (nextDelay: number) => {
      delay = nextDelay;
      timer = setTimeout(attempt, delay);
    };

    // Kick off immediately.
    attempt();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [restarting, navigate, t]);

  const handleSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim()) {
      setLoginError(t('login.enterUsername'));
      return;
    }

    // Guard against double-submit: a previous submit might still be in
    // flight when the user clicks again, which would race a second init
    // call against the just-written kanban.env / first admin user.
    if (submittingRef.current) return;
    submittingRef.current = true;

    setLoginLoading(true);
    setLoginError('');
    setRestartError(null);

    try {
      const data = await authApi.init(username.trim(), password, undefined, true, false, true, advancedConfig);

      if (data.token) {
        // Don't redirect yet: the server is about to fork itself and the
        // listener will be gone for a short window. Hand off to the
        // restart-polling effect so the user sees a friendly progress
        // state instead of a failed page load.
        setRestarting(true);
        setLoginLoading(false);
        return;
      }

      navigate('/');
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      if (ALREADY_INITIALIZED_PATTERN.test(message)) {
        // Race: another request (or a stale session) initialized first, or
        // the DB the server is using already had users. There is no setup
        // to do here anymore, so route to the post-setup landing page.
        navigate('/boards', { replace: true });
        return;
      }
      setLoginError(message || t('login.failed'));
    } finally {
      submittingRef.current = false;
      setLoginLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-100 dark:bg-zinc-900 px-4 py-8">
      <div className="w-full max-w-lg rounded-xl bg-white dark:bg-zinc-800 p-6 shadow-lg">
        {restarting ? (
          <div className="py-12 text-center" data-testid="restart-status">
            <svg
              className="mx-auto h-10 w-10 animate-spin text-blue-500"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
              />
            </svg>
            <h2 className="mt-4 text-lg font-semibold text-zinc-800 dark:text-zinc-100">
              {t('setup.restartingTitle')}
            </h2>
            <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
              {t('setup.restartingBody')}
            </p>
            {restartError && (
              <div className="mt-6 rounded-md bg-amber-50 dark:bg-amber-900/30 p-3 text-sm text-amber-700 dark:text-amber-300">
                {restartError}
                <button
                  type="button"
                  onClick={() => {
                    setRestarting(false);
                    setRestartError(null);
                    navigate('/');
                  }}
                  className="mt-3 block w-full rounded-md bg-amber-500 py-2 text-white hover:bg-amber-600"
                >
                  {t('setup.continueAnyway')}
                </button>
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="mb-6 text-center">
              <h1 className="text-2xl font-bold text-zinc-800 dark:text-zinc-100">{t('app.title')}</h1>
              <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">{t('setup.welcome')}</p>
            </div>

            <form onSubmit={handleSetup} className="space-y-5">
              <div>
                <label
                  htmlFor="setup-username"
                  className="mb-2 block text-sm font-medium text-zinc-700 dark:text-zinc-300"
                >
                  {t('login.username')}
                </label>
                <input
                  id="setup-username"
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder={t('login.enterUsername')}
                  className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-4 py-2.5 focus:border-blue-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100"
                  maxLength={50}
                />
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{t('login.firstUserAdmin')}</p>
              </div>

              <div>
                <label
                  htmlFor="setup-password"
                  className="mb-2 block text-sm font-medium text-zinc-700 dark:text-zinc-300"
                >
                  {t('login.password')}
                </label>
                <input
                  id="setup-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={t('login.enterPassword')}
                  className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-4 py-2.5 focus:border-blue-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100"
                />
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{t('login.passwordHint')}</p>
              </div>

              {supportedDbTypes.length > 1 && (
                <button
                  type="button"
                  onClick={() => setShowAdvanced(!showAdvanced)}
                  className="flex w-full items-center justify-between rounded-md border border-zinc-200 dark:border-zinc-700 px-3 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-700/50"
                >
                  <span>{t('setup.advancedSettings')}</span>
                  <svg
                    className={`h-5 w-5 transform transition-transform ${showAdvanced ? 'rotate-180' : ''}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
              )}

              {(supportedDbTypes.length === 1 || showAdvanced) && (
                <div className="space-y-5 rounded-md border border-zinc-200 dark:border-zinc-700 p-4">
                  <div>
                    <label
                      htmlFor="setup-db-type"
                      className="mb-2 block text-sm font-medium text-zinc-700 dark:text-zinc-300"
                    >
                      {supportedDbTypes.length === 1
                        ? t('setup.dbTypeFixed', { type: supportedDbTypes[0].toUpperCase() })
                        : t('setup.dbType')}
                    </label>
                    <select
                      id="setup-db-type"
                      value={advancedConfig.dbType}
                      onChange={(e) => setAdvancedConfig({ ...advancedConfig, dbType: e.target.value as DbType })}
                      disabled={supportedDbTypes.length === 1}
                      className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-4 py-2.5 focus:border-blue-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {ALL_DB_TYPES.filter((tt) => supportedDbTypes.includes(tt)).map((tt) => (
                        <option key={tt} value={tt}>
                          {tt === 'sqlite' ? 'SQLite' : 'MySQL'}
                        </option>
                      ))}
                    </select>
                  </div>

                  {advancedConfig.dbType === 'sqlite' ? (
                    <div>
                      <label
                        htmlFor="setup-db-path"
                        className="mb-2 block text-sm font-medium text-zinc-700 dark:text-zinc-300"
                      >
                        {t('setup.dbPath')}
                      </label>
                      <input
                        id="setup-db-path"
                        type="text"
                        value={advancedConfig.dbPath}
                        onChange={(e) => setAdvancedConfig({ ...advancedConfig, dbPath: e.target.value })}
                        placeholder="kanban.db"
                        className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-4 py-2.5 focus:border-blue-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100"
                      />
                      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{t('setup.dbPathHint')}</p>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                        <div className="sm:col-span-2">
                          <label
                            htmlFor="setup-db-host"
                            className="mb-2 block text-sm font-medium text-zinc-700 dark:text-zinc-300"
                          >
                            {t('setup.dbHost')}
                          </label>
                          <input
                            id="setup-db-host"
                            type="text"
                            value={advancedConfig.dbHost}
                            onChange={(e) => setAdvancedConfig({ ...advancedConfig, dbHost: e.target.value })}
                            placeholder="localhost"
                            className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-4 py-2.5 focus:border-blue-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100"
                          />
                        </div>
                        <div>
                          <label
                            htmlFor="setup-db-port"
                            className="mb-2 block text-sm font-medium text-zinc-700 dark:text-zinc-300"
                          >
                            {t('setup.dbPort')}
                          </label>
                          <input
                            id="setup-db-port"
                            type="text"
                            value={advancedConfig.dbPort}
                            onChange={(e) => setAdvancedConfig({ ...advancedConfig, dbPort: e.target.value })}
                            placeholder="3306"
                            className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-4 py-2.5 focus:border-blue-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100"
                          />
                        </div>
                      </div>
                      <div>
                        <label
                          htmlFor="setup-db-name"
                          className="mb-2 block text-sm font-medium text-zinc-700 dark:text-zinc-300"
                        >
                          {t('setup.dbName')}
                        </label>
                        <input
                          id="setup-db-name"
                          type="text"
                          value={advancedConfig.dbName}
                          onChange={(e) => setAdvancedConfig({ ...advancedConfig, dbName: e.target.value })}
                          placeholder="kanban"
                          className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-4 py-2.5 focus:border-blue-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100"
                        />
                      </div>
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <div>
                          <label
                            htmlFor="setup-db-user"
                            className="mb-2 block text-sm font-medium text-zinc-700 dark:text-zinc-300"
                          >
                            {t('setup.dbUser')}
                          </label>
                          <input
                            id="setup-db-user"
                            type="text"
                            value={advancedConfig.dbUser}
                            onChange={(e) => setAdvancedConfig({ ...advancedConfig, dbUser: e.target.value })}
                            placeholder="root"
                            className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-4 py-2.5 focus:border-blue-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100"
                          />
                        </div>
                        <div>
                          <label
                            htmlFor="setup-db-password"
                            className="mb-2 block text-sm font-medium text-zinc-700 dark:text-zinc-300"
                          >
                            {t('setup.dbPassword')}
                          </label>
                          <input
                            id="setup-db-password"
                            type="password"
                            value={advancedConfig.dbPassword}
                            onChange={(e) => setAdvancedConfig({ ...advancedConfig, dbPassword: e.target.value })}
                            placeholder="********"
                            className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-4 py-2.5 focus:border-blue-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100"
                          />
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="space-y-4">
                    <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{t('setup.serverSettings')}</h3>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <div>
                        <label
                          htmlFor="setup-server-port"
                          className="mb-2 block text-sm font-medium text-zinc-700 dark:text-zinc-300"
                        >
                          {t('setup.serverPort')}
                        </label>
                        <input
                          id="setup-server-port"
                          type="text"
                          value={advancedConfig.serverPort}
                          onChange={(e) => setAdvancedConfig({ ...advancedConfig, serverPort: e.target.value })}
                          placeholder="8080"
                          className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-4 py-2.5 focus:border-blue-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100"
                        />
                      </div>
                      <div>
                        <label
                          htmlFor="setup-allowed-origins"
                          className="mb-2 block text-sm font-medium text-zinc-700 dark:text-zinc-300"
                        >
                          {t('setup.allowedOrigins')}
                        </label>
                        <input
                          id="setup-allowed-origins"
                          type="text"
                          value={advancedConfig.allowedOrigins}
                          onChange={(e) => setAdvancedConfig({ ...advancedConfig, allowedOrigins: e.target.value })}
                          placeholder="http://localhost:5173, http://localhost:3000"
                          className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-4 py-2.5 focus:border-blue-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100"
                        />
                        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{t('setup.allowedOriginsHint')}</p>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-md bg-blue-50 dark:bg-blue-900/30 p-3 text-xs text-blue-700 dark:text-blue-300">
                    {t('setup.configNote')}
                  </div>
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
          </>
        )}
      </div>
    </div>
  );
}