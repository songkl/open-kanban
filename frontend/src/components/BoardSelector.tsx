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
          className="flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 py-1 text-sm hover:bg-zinc-50 max-w-36"
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
          <div className="absolute left-0 top-full mt-1 w-48 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg z-50">
            {boards.map((board) => (
              <button
                key={board.id}
                onClick={() => onSelectBoard(board.id)}
                className={`w-full px-3 py-2 text-left text-sm hover:bg-zinc-100 ${
                  board.id === boardIdFromUrl ? 'bg-blue-50 text-blue-700 font-medium' : 'text-zinc-700'
                }`}
              >
                {board.name}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }
);

BoardSelector.displayName = 'BoardSelector';
