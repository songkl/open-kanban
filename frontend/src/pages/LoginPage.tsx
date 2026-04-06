import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { boardsApi, authApi } from '../services/api';

export function LoginPage() {
  const { t } = useTranslation();
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
      <div className="w-full max-w-md rounded-xl bg-white dark:bg-zinc-800 p-8 shadow-lg">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-bold text-zinc-800 dark:text-zinc-100">Open kanban</h1>
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">{t('login.welcome')}</p>
        </div>

        <form onSubmit={handleLogin} className="space-y-6">
          <div>
            <label className="mb-2 block text-sm font-medium text-zinc-700 dark:text-zinc-200">
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
