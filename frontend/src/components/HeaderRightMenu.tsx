import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { UserAvatar } from './UserAvatar';
import type { User } from '../types/kanban';

interface HeaderRightMenuProps {
  showUserMenu: boolean;
  currentUser: User | null;
  wsStatus: 'connected' | 'disconnected' | 'failed';
  reconnectAttemptRef: React.MutableRefObject<number>;
  onSetShowUserMenu: (show: boolean) => void;
  onConnectWebSocket: () => void;
  userMenuRef: React.RefObject<HTMLDivElement | null>;
  navigate: (path: string) => void;
  darkMode: boolean;
  onSetDarkMode: (dark: boolean) => void;
  i18n: { language: string; changeLanguage: (lang: string) => void };
}

export function HeaderRightMenu({
  showUserMenu,
  currentUser,
  wsStatus,
  reconnectAttemptRef,
  onSetShowUserMenu,
  onConnectWebSocket,
  userMenuRef,
  navigate,
  darkMode,
  onSetDarkMode,
  i18n,
}: HeaderRightMenuProps) {
  const { t } = useTranslation();

  return (
    <div className="relative">
      {currentUser && (
        <div className="relative">
          <button
            onClick={() => {
              onSetShowUserMenu(!showUserMenu);
            }}
            className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-zinc-100"
          >
            <UserAvatar username={currentUser.nickname} avatar={currentUser.avatar} size="sm" />
            <span className={`text-xs ${wsStatus === 'connected' ? 'text-green-600' : wsStatus === 'failed' ? 'text-red-500' : 'text-red-400'}`}>
              {wsStatus === 'connected' ? '●' : '○'}
            </span>
          </button>
          {showUserMenu && (
            <div ref={userMenuRef} className="absolute right-0 top-full mt-1 w-48 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg z-50">
              <div className="px-4 py-2 border-b border-zinc-100">
                <p className="text-sm font-medium text-zinc-800">{currentUser.nickname}</p>
                <p className="text-xs text-zinc-500 capitalize">{currentUser.role.toLowerCase()}</p>
              </div>
              <button
                onClick={() => {
                  if (wsStatus === 'failed') {
                    reconnectAttemptRef.current = 0;
                    onConnectWebSocket();
                  }
                  onSetShowUserMenu(false);
                }}
                className="w-full flex items-center gap-2 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
              >
                <span className={wsStatus === 'connected' ? 'text-green-600' : wsStatus === 'failed' ? 'text-red-500' : 'text-red-400'}>
                  {wsStatus === 'connected' ? '●' : '○'}
                </span>
                <span>{t('status.connection')}</span>
                <span className="text-xs text-zinc-400 ml-auto">
                  {wsStatus === 'connected' ? t('status.connected') : wsStatus === 'failed' ? t('status.reconnect') : t('status.connecting')}
                </span>
              </button>
              <Link to="/settings" onClick={() => onSetShowUserMenu(false)} className="block px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100">
                {t('settings.title')}
              </Link>
              <button
                onClick={() => {
                  const newLang = i18n.language === 'zh' ? 'en' : 'zh';
                  i18n.changeLanguage(newLang);
                  localStorage.setItem('language', newLang);
                }}
                className="w-full flex items-center justify-between px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
              >
                <span>{t('nav.language')}</span>
                <span className="text-xs text-zinc-500">{i18n.language === 'zh' ? t('language.en') : t('language.zh')}</span>
              </button>
              {false && (
              <button
                onClick={() => onSetDarkMode(!darkMode)}
                className="w-full flex items-center justify-between px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
              >
                <span>{t('nav.theme')}</span>
                {darkMode ? (
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-orange-400">
                    <circle cx="12" cy="12" r="5"/>
                    <line x1="12" y1="1" x2="12" y2="3"/>
                    <line x1="12" y1="21" x2="12" y2="23"/>
                    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
                    <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
                    <line x1="1" y1="12" x2="3" y2="12"/>
                    <line x1="21" y1="12" x2="23" y2="12"/>
                    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
                    <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
                  </svg>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-400">
                    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
                  </svg>
                )}
              </button>
              )}
              <button
                onClick={() => {
                  localStorage.removeItem('token');
                  navigate('/login');
                }}
                className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-zinc-100"
              >
                {t('auth.logout')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}