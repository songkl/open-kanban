import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { UserAvatar } from './UserAvatar';
import type { User } from '../types/kanban';

interface HeaderRightMenuProps {
  showMoreMenu: boolean;
  showUserMenu: boolean;
  showExportMenu: boolean;
  showPreferencesMenu: boolean;
  currentUser: User | null;
  wsStatus: 'connected' | 'disconnected' | 'failed';
  reconnectCount: number;
  reconnectAttemptRef: React.MutableRefObject<number>;
  onSetShowMoreMenu: (show: boolean) => void;
  onSetShowUserMenu: (show: boolean) => void;
  onSetShowExportMenu: (show: boolean) => void;
  onSetShowPreferencesMenu: (show: boolean) => void;
  onConnectWebSocket: () => void;
  moreMenuRef: React.RefObject<HTMLDivElement | null>;
  userMenuRef: React.RefObject<HTMLDivElement | null>;
  exportMenuRef: React.RefObject<HTMLDivElement | null>;
  preferencesMenuRef: React.RefObject<HTMLDivElement | null>;
  onExport: (format: 'json' | 'csv') => void;
  onSetDarkMode: (dark: boolean) => void;
  darkMode: boolean;
  i18n: { language: string; changeLanguage: (lang: string) => void };
  navigate: (path: string) => void;
}

export function HeaderRightMenu({
  showMoreMenu,
  showUserMenu,
  showExportMenu,
  showPreferencesMenu,
  currentUser,
  wsStatus,
  reconnectAttemptRef,
  onSetShowMoreMenu,
  onSetShowUserMenu,
  onSetShowExportMenu,
  onSetShowPreferencesMenu,
  onConnectWebSocket,
  moreMenuRef,
  userMenuRef,
  exportMenuRef,
  preferencesMenuRef,
  onExport,
  onSetDarkMode,
  darkMode,
  i18n,
  navigate,
}: HeaderRightMenuProps) {
  const { t } = useTranslation();

  return (
    <div className="relative">
      <button
        onClick={() => {
          if (showUserMenu) onSetShowUserMenu(false);
          onSetShowMoreMenu(!showMoreMenu);
        }}
        className="flex items-center gap-1 rounded-md bg-zinc-100 px-2.5 py-1.5 text-sm hover:bg-zinc-200"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="18" x2="21" y2="18" />
        </svg>
      </button>
      {showMoreMenu && (
        <div ref={moreMenuRef} className="absolute right-0 top-full mt-1 w-44 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg z-50">
          <Link to="/boards" onClick={() => onSetShowMoreMenu(false)} className="block px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100">
            {t('nav.manageBoards')}
          </Link>
          <Link to="/drafts" onClick={() => onSetShowMoreMenu(false)} className="block px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100">
            {t('nav.drafts')}
          </Link>
          <Link to="/history" onClick={() => onSetShowMoreMenu(false)} className="block px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100">
            {t('nav.history')}
          </Link>
          <Link to="/completed" onClick={() => onSetShowMoreMenu(false)} className="block px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100">
            {t('nav.completed')}
          </Link>
          {currentUser?.role === 'ADMIN' && (
            <>
              <Link to="/settings?tab=users" onClick={() => onSetShowMoreMenu(false)} className="block px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100">
                {t('nav.admin')}
              </Link>
              <Link to="/activities" onClick={() => onSetShowMoreMenu(false)} className="block px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100">
                {t('nav.activityLog')}
              </Link>
              <Link to="/agent-activity" onClick={() => onSetShowMoreMenu(false)} className="block px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100">
                {t('nav.agentActivity')}
              </Link>
            </>
          )}
          <div className="border-t border-zinc-100 my-1" />
          <div className="relative">
            <button
              onClick={() => onSetShowExportMenu(!showExportMenu)}
              className="w-full flex items-center justify-between px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
            >
              <span>{t('nav.export')}</span>
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
            {showExportMenu && (
              <div ref={exportMenuRef} className="absolute left-full top-0 ml-1 w-36 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg z-50">
                <button onClick={() => onExport('json')} className="w-full px-4 py-2 text-left text-sm text-zinc-700 hover:bg-zinc-100">
                  JSON
                </button>
                <button onClick={() => onExport('csv')} className="w-full px-4 py-2 text-left text-sm text-zinc-700 hover:bg-zinc-100">
                  CSV
                </button>
              </div>
            )}
          </div>
          <div className="relative">
            <button
              onClick={() => onSetShowPreferencesMenu(!showPreferencesMenu)}
              className="w-full flex items-center justify-between px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
            >
              <span>{t('nav.preferences')}</span>
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
            {showPreferencesMenu && (
              <div ref={preferencesMenuRef} className="absolute left-full top-0 ml-1 w-40 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg z-50">
                <button
                  onClick={() => {
                    const newLang = i18n.language === 'zh' ? 'en' : 'zh';
                    i18n.changeLanguage(newLang);
                    localStorage.setItem('language', newLang);
                    onSetShowPreferencesMenu(false);
                    onSetShowMoreMenu(false);
                  }}
                  className="w-full flex items-center justify-between px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
                >
                  <span>{t('nav.language')}</span>
                  <span className="text-xs text-zinc-500">{i18n.language === 'zh' ? t('language.en') : t('language.zh')}</span>
                </button>
                <button
                  onClick={() => {
                    onSetDarkMode(!darkMode);
                    onSetShowPreferencesMenu(false);
                    onSetShowMoreMenu(false);
                  }}
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
                <div className="border-t border-zinc-100 my-1" />
                <Link to="/settings" onClick={() => onSetShowMoreMenu(false)} className="block px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100">
                  {t('settings.title')}
                </Link>
              </div>
            )}
          </div>
        </div>
      )}
      {currentUser && (
        <div className="relative">
          <button
            onClick={() => {
              if (showMoreMenu) onSetShowMoreMenu(false);
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