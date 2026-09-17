import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { boardsApi, authApi } from '../services/api';

export function LoginPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [requirePassword, setRequirePassword] = useState(false);

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

  const handleLanguageToggle = () => {
    const newLang = i18n.language === 'zh' ? 'en' : 'zh';
    i18n.changeLanguage(newLang);
    localStorage.setItem('language', newLang);
  };

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
        boardsApi.getAll().then((boards) => {
          if (boards && boards.length > 0) {
            navigate(`/board/${boards[0].id}`);
          }
        });
      }
    } catch {
      setLoginError(t('login.failed'));
    } finally {
      setLoginLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-100 dark:bg-zinc-900">
      <div
        className="w-full max-w-md rounded-xl bg-white dark:bg-zinc-800 p-8 shadow-lg"
        role="main"
      >
        <div className="mb-6 flex items-start justify-between">
          <div className="flex-1 text-center">
            <h1 className="text-2xl font-bold text-zinc-800 dark:text-zinc-100">{t('login.title')}</h1>
            <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-500">{t('login.welcome')}</p>
          </div>
          <button
            type="button"
            onClick={handleLanguageToggle}
            aria-label={t('nav.language')}
            className="rounded-md border border-zinc-300 dark:border-zinc-600 px-2 py-1 text-xs text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700"
          >
            {i18n.language === 'zh' ? t('language.en') : t('language.zh')}
          </button>
        </div>

        <form onSubmit={handleLogin} className="space-y-6" noValidate>
          <div>
            <label
              htmlFor="login-username"
              className="mb-2 block text-sm font-medium text-zinc-700 dark:text-zinc-400"
            >
              {t('login.username')}
            </label>
            <input
              id="login-username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={t('login.enterNickname')}
              autoComplete="username"
              aria-required="true"
              aria-invalid={loginError ? 'true' : 'false'}
              aria-describedby={loginError ? 'login-error' : undefined}
              maxLength={20}
              className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-4 py-3 focus:border-blue-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100"
            />
          </div>

          {requirePassword && (
            <div>
              <label
                htmlFor="login-password"
                className="mb-2 block text-sm font-medium text-zinc-700 dark:text-zinc-400"
              >
                {t('login.password')}
              </label>
              <input
                id="login-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t('login.enterPassword')}
                autoComplete="current-password"
                aria-describedby={loginError ? 'login-error' : undefined}
                className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 px-4 py-3 focus:border-blue-500 focus:outline-none dark:bg-zinc-700 dark:text-zinc-100"
              />
            </div>
          )}

          {loginError && (
            <div
              id="login-error"
              role="alert"
              className="rounded-md bg-red-50 dark:bg-red-900/30 p-3 text-sm text-red-600 dark:text-red-400"
            >
              {loginError}
            </div>
          )}

          <button
            type="submit"
            disabled={loginLoading || !username.trim()}
            aria-busy={loginLoading}
            className="w-full rounded-md bg-blue-500 py-3 font-medium text-white transition-colors hover:bg-blue-600 disabled:cursor-not-allowed disabled:bg-zinc-300 dark:disabled:bg-zinc-600"
          >
            {loginLoading ? t('login.loggingIn') : t('login.start')}
          </button>
        </form>
      </div>
    </div>
  );
}