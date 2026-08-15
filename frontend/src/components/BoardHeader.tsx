import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { Board } from '../types/kanban';

interface BoardHeaderProps {
  boards: Board[];
  currentBoard: Board | null;
  boardIdFromUrl: string;
}

export function BoardHeader({ boards, currentBoard, boardIdFromUrl }: BoardHeaderProps) {
  const { t } = useTranslation();

  return (
    <div className="flex items-center gap-3">
      <div className="relative">
        <button className="flex items-center gap-1 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-1 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-600 max-w-36">
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
      </div>
      <Link
        to={`/columns?boardId=${boardIdFromUrl}`}
        className="flex items-center rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 p-1.5 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-600 dark:bg-zinc-700 dark:hover:bg-zinc-700"
        title={t('column.manageColumns')}
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
          <circle cx="12" cy="12" r="3" />
          <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" />
        </svg>
      </Link>
    </div>
  );
}