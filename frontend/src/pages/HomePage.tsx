import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { boardsApi } from '../services/api';
import { LoadingScreen } from '../components/LoadingScreen';

export function HomePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasBoards, setHasBoards] = useState(false);
  const [showInitModal, setShowInitModal] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);

  useEffect(() => {
    boardsApi.getAll()
      .then((data) => {
        const boards = data || [];
        setHasBoards(boards.length > 0);
        if (boards.length > 0) {
          navigate(`/board/${boards[0].id}`);
        } else {
          setShowInitModal(true);
        }
      })
      .catch((err) => {
        console.error('Failed to fetch boards:', err);
        setError(t('app.error.connectionFailed'));
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [navigate, t]);

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
        setLoginError(data.error || t('login.failed'));
        return;
      }

      setShowInitModal(false);
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

  if (isLoading) {
    return <LoadingScreen />;
  }

  if (error && !showInitModal) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4">
        <div className="text-red-500">{t('app.error.connectionFailed')}</div>
        <div className="text-sm text-zinc-400">{error}</div>
        <button
          onClick={() => window.location.reload()}
          className="rounded-md bg-blue-500 px-4 py-2 text-sm text-white hover:bg-blue-600"
        >
          {t('app.error.retry')}
        </button>
        <button
          onClick={() => {
            localStorage.removeItem('token');
            navigate('/login');
          }}
          className="rounded-md bg-red-500 px-4 py-2 text-sm text-white hover:bg-red-600"
        >
          {t('auth.logout')}
        </button>
      </div>
    );
  }

  if (showInitModal) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-100">
        <div className="w-full max-w-md rounded-xl bg-white p-8 shadow-lg">
          <div className="mb-6 text-center">
            <h1 className="text-2xl font-bold text-zinc-800">{t('app.title')}</h1>
            <p className="mt-2 text-sm text-zinc-500">{t('login.welcome')}</p>
            <p className="mt-1 text-xs text-blue-500">{t('login.firstUserAdmin')}</p>
          </div>

          <form onSubmit={handleLogin} className="space-y-6">
            <div>
              <label className="mb-2 block text-sm font-medium text-zinc-700">
                {t('login.username')}
              </label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={t('login.enterNickname')}
                className="w-full rounded-md border border-zinc-300 px-4 py-3 focus:border-blue-500 focus:outline-none"
                maxLength={20}
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-zinc-700">
                {t('login.password')}
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t('login.enterPassword')}
                className="w-full rounded-md border border-zinc-300 px-4 py-3 focus:border-blue-500 focus:outline-none"
              />
              <p className="mt-1 text-xs text-zinc-400">{t('login.passwordHint')}</p>
            </div>

            {loginError && (
              <div className="rounded-md bg-red-50 p-3 text-sm text-red-600">
                {loginError}
              </div>
            )}

            <button
              type="submit"
              disabled={loginLoading || !username.trim()}
              className="w-full rounded-md bg-blue-500 py-3 font-medium text-white transition-colors hover:bg-blue-600 disabled:cursor-not-allowed disabled:bg-zinc-300"
            >
              {loginLoading ? t('login.loggingIn') : t('login.start')}
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (!hasBoards) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4">
        <div className="text-zinc-500">{t('board.noBoards')}</div>
        <button
          onClick={() => navigate('/boards')}
          className="rounded-md bg-blue-500 px-4 py-2 text-sm text-white hover:bg-blue-600"
        >
          {t('board.createFirst')}
        </button>
        <button
          onClick={() => {
            localStorage.removeItem('token');
            navigate('/login');
          }}
          className="rounded-md bg-red-500 px-4 py-2 text-sm text-white hover:bg-red-600"
        >
          {t('auth.logout')}
        </button>
      </div>
    );
  }

  return <LoadingScreen />;
}
