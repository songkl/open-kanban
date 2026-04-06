import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { User } from '../types/kanban';

interface BoardActionsMenuProps {
  showMoreMenu: boolean;
  showExportMenu: boolean;
  currentUser: User | null;
  onSetShowMoreMenu: (show: boolean) => void;
  onSetShowExportMenu: (show: boolean) => void;
  moreMenuRef: React.RefObject<HTMLDivElement | null>;
  exportMenuRef: React.RefObject<HTMLDivElement | null>;
  onExport: (format: 'json' | 'csv') => void;
  onReset: () => void;
}

export function BoardActionsMenu({
  showMoreMenu,
  showExportMenu,
  currentUser,
  onSetShowMoreMenu,
  onSetShowExportMenu,
  moreMenuRef,
  exportMenuRef,
  onExport,
  onReset,
}: BoardActionsMenuProps) {
  const { t } = useTranslation();

  return (
    <div ref={moreMenuRef} className="relative">
      <button
        onClick={() => onSetShowMoreMenu(!showMoreMenu)}
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
        <div className="absolute right-0 top-full mt-1 w-44 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg z-50">
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
              <div ref={exportMenuRef} className="absolute right-full top-0 mr-1 w-36 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg z-50">
                <button onClick={() => onExport('json')} className="w-full px-4 py-2 text-left text-sm text-zinc-700 hover:bg-zinc-100">
                  JSON
                </button>
                <button onClick={() => onExport('csv')} className="w-full px-4 py-2 text-left text-sm text-zinc-700 hover:bg-zinc-100">
                  CSV
                </button>
              </div>
            )}
          </div>
          <div className="border-t border-zinc-100 my-1" />
          <button
            onClick={() => {
              onReset();
              onSetShowMoreMenu(false);
            }}
            className="w-full flex items-center gap-2 px-4 py-2 text-sm text-red-600 hover:bg-zinc-100"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
            {t('nav.resetBoard')}
          </button>
        </div>
      )}
    </div>
  );
}
