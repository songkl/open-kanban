import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

type DbType = 'sqlite' | 'mysql';

interface AdvancedConfig {
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

export function SetupPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [nickname, setNickname] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [advancedConfig, setAdvancedConfig] = useState<AdvancedConfig>({
    dbType: 'sqlite',
    dbPath: 'kanban.db',
    dbHost: 'localhost',
    dbPort: '3306',
    dbUser: 'root',
    dbPassword: '',
    dbName: 'kanban',
    serverPort: '8080',
    allowedOrigins: '',
  });

  const handleSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nickname.trim()) {
      setLoginError(t('login.enterNickname'));
      return;
    }

    setLoginLoading(true);
    setLoginError('');

    try {
      const res = await fetch('/api/auth/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          nickname: nickname.trim(),
          password: password,
          allowRegistration: true,
          requirePassword: false,
        }),
      });

      if (res.status === 302 || res.status === 301 || res.redirected) {
        window.location.href = '/';
        return;
      }

      const data = await res.json();

      if (!res.ok) {
        setLoginError(data.error || t('login.failed'));
        return;
      }

      navigate('/');
    } catch {
      setLoginError(t('login.failed'));
    } finally {
      setLoginLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-100 dark:bg-zinc-900">
      <div className="w-full max-w-md rounded-xl bg-white dark:bg-zinc-800 p-8 shadow-lg">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-bold text-zinc-800 dark:text-zinc-100">Open kanban</h1>
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">{t('login.welcome')}</p>
          <p className="mt-1 text-xs text-blue-500 dark:text-blue-400">{t('login.firstUserAdmin')}</p>
        </div>

        <form onSubmit={handleSetup} className="space-y-6">
          <div>
            <label className="mb-2 block text-sm font-medium text-zinc-700 dark:text-zinc-200">
              {t('login.nickname')}
            </label>
            <input
              type="text"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder={t('login.enterNickname')}
              className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-4 py-3 focus:border-blue-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100"
              maxLength={20}
            />
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-zinc-700 dark:text-zinc-200">
              {t('login.password')}
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t('login.enterPassword')}
              className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-4 py-3 focus:border-blue-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100"
            />
            <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">{t('login.passwordHint')}</p>
          </div>

          <div className="border-t border-zinc-200 dark:border-zinc-700 pt-4">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex w-full items-center justify-between text-sm font-medium text-zinc-600 dark:text-zinc-300 hover:text-zinc-800 dark:hover:text-zinc-100"
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

            {showAdvanced && (
              <div className="mt-4 space-y-4">
                <div>
                  <label className="mb-2 block text-sm font-medium text-zinc-700 dark:text-zinc-200">
                    {t('setup.dbType')}
                  </label>
                  <select
                    value={advancedConfig.dbType}
                    onChange={(e) => setAdvancedConfig({ ...advancedConfig, dbType: e.target.value as DbType })}
                    className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-4 py-2 focus:border-blue-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100"
                  >
                    <option value="sqlite">SQLite</option>
                    <option value="mysql">MySQL</option>
                  </select>
                </div>

                {advancedConfig.dbType === 'sqlite' ? (
                  <div>
                      <label className="mb-2 block text-sm font-medium text-zinc-700 dark:text-zinc-200">
                        {t('setup.dbPath')}
                      </label>
                      <input
                        type="text"
                        value={advancedConfig.dbPath}
                        onChange={(e) => setAdvancedConfig({ ...advancedConfig, dbPath: e.target.value })}
                        placeholder="kanban.db"
                        className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-4 py-2 focus:border-blue-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100"
                      />
                      <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">{t('setup.dbPathHint')}</p>
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="mb-2 block text-sm font-medium text-zinc-700 dark:text-zinc-200">
                          {t('setup.dbHost')}
                        </label>
                        <input
                          type="text"
                          value={advancedConfig.dbHost}
                          onChange={(e) => setAdvancedConfig({ ...advancedConfig, dbHost: e.target.value })}
                          placeholder="localhost"
                          className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-4 py-2 focus:border-blue-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100"
                        />
                      </div>
                      <div>
                        <label className="mb-2 block text-sm font-medium text-zinc-700 dark:text-zinc-200">
                          {t('setup.dbPort')}
                        </label>
                        <input
                          type="text"
                          value={advancedConfig.dbPort}
                          onChange={(e) => setAdvancedConfig({ ...advancedConfig, dbPort: e.target.value })}
                          placeholder="3306"
                          className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-4 py-2 focus:border-blue-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="mb-2 block text-sm font-medium text-zinc-700 dark:text-zinc-200">
                        {t('setup.dbName')}
                      </label>
                      <input
                        type="text"
                        value={advancedConfig.dbName}
                        onChange={(e) => setAdvancedConfig({ ...advancedConfig, dbName: e.target.value })}
                        placeholder="kanban"
                        className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-4 py-2 focus:border-blue-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="mb-2 block text-sm font-medium text-zinc-700 dark:text-zinc-200">
                          {t('setup.dbUser')}
                        </label>
                        <input
                          type="text"
                          value={advancedConfig.dbUser}
                          onChange={(e) => setAdvancedConfig({ ...advancedConfig, dbUser: e.target.value })}
                          placeholder="root"
                          className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-4 py-2 focus:border-blue-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100"
                        />
                      </div>
                      <div>
                        <label className="mb-2 block text-sm font-medium text-zinc-700 dark:text-zinc-200">
                          {t('setup.dbPassword')}
                        </label>
                        <input
                          type="password"
                          value={advancedConfig.dbPassword}
                          onChange={(e) => setAdvancedConfig({ ...advancedConfig, dbPassword: e.target.value })}
                          placeholder="********"
                          className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-4 py-2 focus:border-blue-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100"
                        />
                      </div>
                    </div>
                  </>
                )}

                <div className="border-t border-zinc-200 dark:border-zinc-700 pt-4">
                  <h3 className="mb-3 text-sm font-medium text-zinc-700 dark:text-zinc-200">{t('setup.serverSettings')}</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="mb-2 block text-sm font-medium text-zinc-700 dark:text-zinc-200">
                          {t('setup.serverPort')}
                      </label>
                      <input
                        type="text"
                        value={advancedConfig.serverPort}
                        onChange={(e) => setAdvancedConfig({ ...advancedConfig, serverPort: e.target.value })}
                        placeholder="8080"
                        className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-4 py-2 focus:border-blue-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100"
                      />
                    </div>
                    <div>
                      <label className="mb-2 block text-sm font-medium text-zinc-700 dark:text-zinc-200">
                          {t('setup.allowedOrigins')}
                      </label>
                      <input
                        type="text"
                        value={advancedConfig.allowedOrigins}
                        onChange={(e) => setAdvancedConfig({ ...advancedConfig, allowedOrigins: e.target.value })}
                        placeholder="http://localhost:5173, http://localhost:3000"
                        className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-4 py-2 focus:border-blue-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100"
                      />
                      <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">{t('setup.allowedOriginsHint')}</p>
                    </div>
                  </div>
                </div>

                <div className="rounded-md bg-blue-50 dark:bg-blue-900/30 p-3 text-xs text-blue-700 dark:text-blue-300">
                  <p>{t('setup.configNote')}</p>
                </div>
              </div>
            )}
          </div>

          {loginError && (
            <div className="rounded-md bg-red-50 dark:bg-red-900/30 p-3 text-sm text-red-600 dark:text-red-400">
              {loginError}
            </div>
          )}

          <button
            type="submit"
            disabled={loginLoading || !nickname.trim()}
            className="w-full rounded-md bg-blue-500 py-3 font-medium text-white transition-colors hover:bg-blue-600 disabled:cursor-not-allowed disabled:bg-zinc-300 dark:disabled:bg-zinc-600"
          >
            {loginLoading ? t('login.loggingIn') : t('login.start')}
          </button>
        </form>
      </div>
    </div>
  );
}
