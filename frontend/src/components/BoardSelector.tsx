import { forwardRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { Board } from '../types/kanban';

interface BoardSelectorProps {
  boards: Board[];
  currentBoard: Board | null;
  boardIdFromUrl: string;
  showDropdown: boolean;
  onToggleDropdown: () => void;
  onSelectBoard: (id: string) => void;
}

export const BoardSelector = forwardRef<HTMLDivElement, BoardSelectorProps>(
  ({ boards, currentBoard, boardIdFromUrl, showDropdown, onToggleDropdown, onSelectBoard }, ref) => {
    const { t } = useTranslation();

    return (
      <div ref={ref} className="relative">
        <button
          onClick={onToggleDropdown}
          className="flex items-center gap-1 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-1 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-600 max-w-36"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="3" width="7" height="7" />
            <rect x="14" y="3" width="7" height="7" />
            <rect x="14" y="14" width="7" height="7" />
            <rect x="3" y="14" width="7" height="7" />
          </svg>
          <span className="truncate max-w-24">
            {currentBoard?.name || boards.find((b) => b.id === boardIdFromUrl)?.name || t('board.selectBoard')}
          </span>
          {(currentBoard?.isPublic === false ||
            (!currentBoard && boards.find((b) => b.id === boardIdFromUrl)?.isPublic === false)) && (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-amber-500"
            >
              <title>{t('board.private')}</title>
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          )}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
        {showDropdown && (
          <div className="absolute left-0 top-full mt-1 w-48 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 py-1 shadow-lg z-50">
            {boards.map((board) => (
              <button
                key={board.id}
                onClick={() => onSelectBoard(board.id)}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-600 dark:bg-zinc-700 ${
                  board.id === boardIdFromUrl ? 'bg-blue-50 text-blue-700 font-medium' : 'text-zinc-700 dark:text-zinc-400'
                }`}
              >
                <span className="flex-1 truncate">{board.name}</span>
                {board.isPublic === false && (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="shrink-0 text-amber-500"
                  >
                    <title>{t('board.private')}</title>
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }
);

BoardSelector.displayName = 'BoardSelector';
