import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';

import type { Board } from '../types/kanban';

interface BoardCardProps {
  board: Board;
  onEdit: (board: Board) => void;
  onCopy: (boardId: string, boardName: string) => void;
  onSaveAsTemplate: (boardId: string, boardName: string) => void;
  onExport: (boardId: string, boardName: string, format: 'json' | 'csv') => void;
  onImport: () => void;
  onDelete: (id: string, name: string) => void;
}

export function BoardCard({
  board,
  onEdit,
  onCopy,
  onSaveAsTemplate,
  onExport,
  onImport,
  onDelete,
}: BoardCardProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <div className="group rounded-2xl bg-white p-5 shadow-sm border border-zinc-100 hover:shadow-xl hover:border-zinc-200 transition-all duration-300">
      <div className="mb-4 flex items-center gap-3">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500/10 to-blue-600/10 text-blue-600">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-bold text-zinc-800 truncate">{board.name}</h3>
          <p className="text-xs text-zinc-400 font-mono">ID: {board.id}</p>
        </div>
      </div>
      <p className="text-xs text-zinc-400 mb-5">
        {t('board.createdAt')}: {new Date(board.createdAt).toLocaleDateString()}
      </p>
      {board.description && (
        <p className="text-xs text-zinc-500 mb-4 line-clamp-2">{board.description}</p>
      )}
      <div className="grid grid-cols-2 gap-2 mb-4">
        <button
          onClick={() => navigate(`/board/${board.id}`)}
          className="col-span-2 rounded-xl bg-gradient-to-r from-blue-500 to-blue-600 px-3 py-2.5 text-sm font-medium text-white hover:from-blue-600 hover:to-blue-700 transition-all shadow-sm hover:shadow-md"
        >
          {t('task.enter')}
        </button>
        <Link
          to={`/columns?boardId=${board.id}`}
          className="flex items-center justify-center gap-1.5 rounded-xl bg-zinc-50 px-3 py-2 text-xs font-medium text-zinc-600 border border-zinc-100 hover:bg-zinc-100 hover:border-zinc-200 transition-all"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="5" height="18"/><rect x="10" y="3" width="5" height="18"/><rect x="17" y="3" width="5" height="18"/>
          </svg>
          {t('nav.columnManagement')}
        </Link>
        <button
          onClick={() => onEdit(board)}
          className="flex items-center justify-center gap-1.5 rounded-xl bg-amber-50 px-3 py-2 text-xs font-medium text-amber-600 border border-amber-100 hover:bg-amber-100 hover:border-amber-200 transition-all"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
          </svg>
          {t('task.edit')}
        </button>
        <button
          onClick={() => onCopy(board.id, board.name)}
          className="flex items-center justify-center gap-1.5 rounded-xl bg-purple-50 px-3 py-2 text-xs font-medium text-purple-600 border border-purple-100 hover:bg-purple-100 hover:border-purple-200 transition-all"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
          </svg>
          {t('task.copy')}
        </button>
        <button
          onClick={() => onSaveAsTemplate(board.id, board.name)}
          className="flex items-center justify-center gap-1.5 rounded-xl bg-orange-50 px-3 py-2 text-xs font-medium text-orange-600 border border-orange-100 hover:bg-orange-100 hover:border-orange-200 transition-all"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>
          </svg>
          {t('task.saveAsTemplate')}
        </button>
      </div>
      <div className="flex items-center gap-2 pt-4 border-t border-zinc-100">
        <button
          onClick={() => onExport(board.id, board.name, 'csv')}
          className="flex-1 flex items-center justify-center gap-1.5 rounded-xl bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-600 border border-emerald-100 hover:bg-emerald-100 hover:border-emerald-200 transition-all"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>
          </svg>
          CSV
        </button>
        <button
          onClick={() => onExport(board.id, board.name, 'json')}
          className="flex-1 flex items-center justify-center gap-1.5 rounded-xl bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-600 border border-emerald-100 hover:bg-emerald-100 hover:border-emerald-200 transition-all"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>
          </svg>
          JSON
        </button>
        <button
          onClick={onImport}
          className="flex-1 flex items-center justify-center gap-1.5 rounded-xl bg-sky-50 px-3 py-2 text-xs font-medium text-sky-600 border border-sky-100 hover:bg-sky-100 hover:border-sky-200 transition-all"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>
          </svg>
          Import
        </button>
        <button
          onClick={() => onDelete(board.id, board.name)}
          className="flex items-center justify-center rounded-xl bg-red-50 px-3 py-2 text-xs font-medium text-red-600 border border-red-100 hover:bg-red-100 hover:border-red-200 transition-all"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
        </button>
      </div>
    </div>
  );
}
