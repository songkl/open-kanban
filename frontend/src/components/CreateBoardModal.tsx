import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Board } from '../types/kanban';

interface Template {
  id: string;
  name: string;
  boardId?: string;
  columnsConfig: string;
  includeTasks: boolean;
  createdAt: string;
}

interface CreateBoardModalProps {
  isOpen: boolean;
  editingBoard: Board | null;
  templates: Template[];
  onClose: () => void;
  onSubmit: (data: {
    name: string;
    description?: string;
    boardId?: string;
    templateId?: string;
  }) => Promise<void>;
}

interface BoardFormProps {
  editingBoard: Board | null;
  templates: Template[];
  onClose: () => void;
  onSubmit: (data: {
    name: string;
    description?: string;
    boardId?: string;
    templateId?: string;
  }) => Promise<void>;
  t: (key: string) => string;
}

function BoardForm({ editingBoard, templates, onClose, onSubmit, t }: BoardFormProps) {
  const [boardName, setBoardName] = useState(editingBoard?.name ?? '');
  const [boardDescription, setBoardDescription] = useState(editingBoard?.description ?? '');
  const [boardId, setBoardId] = useState(editingBoard?.id ?? '');
  const [selectedTemplate, setSelectedTemplate] = useState('');

  const isEditing = !!editingBoard;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!boardName.trim()) return;

    await onSubmit({
      name: boardName.trim(),
      description: isEditing ? boardDescription : undefined,
      boardId: isEditing ? boardId : boardId || undefined,
      templateId: !isEditing && selectedTemplate ? selectedTemplate : undefined,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div>
        <label className="mb-2 block text-sm font-semibold text-zinc-700">
          {t('modal.boardName')}
        </label>
        <input
          type="text"
          value={boardName}
          onChange={(e) => setBoardName(e.target.value)}
          placeholder={t('modal.enterBoardName')}
          className="w-full rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-zinc-800 placeholder-zinc-400 transition-all focus:border-blue-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20"
          autoFocus
        />
      </div>

      {isEditing && (
        <div>
          <label className="mb-2 block text-sm font-semibold text-zinc-700">
            {t('board.description') || 'Description'}
          </label>
          <textarea
            value={boardDescription}
            onChange={(e) => setBoardDescription(e.target.value)}
            placeholder={t('board.descriptionPlaceholder')}
            rows={4}
            className="w-full rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-zinc-800 placeholder-zinc-400 transition-all focus:border-blue-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 resize-none"
          />
        </div>
      )}

      {!isEditing && (
        <div>
          <label className="mb-2 block text-sm font-semibold text-zinc-700">
            {t('modal.boardId')}
          </label>
          <input
            type="text"
            value={boardId}
            onChange={(e) => setBoardId(e.target.value.replace(/\//g, ''))}
            placeholder={t('modal.autoGenerate')}
            className="w-full rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-zinc-800 placeholder-zinc-400 transition-all focus:border-blue-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20"
          />
          <p className="mt-1.5 text-xs text-zinc-400">
            {t('modal.boardIdHint')}
          </p>
        </div>
      )}

      {!isEditing && templates.length > 0 && (
        <div>
          <label className="mb-2 block text-sm font-semibold text-zinc-700">
            {t('modal.useTemplate')}
          </label>
          <select
            value={selectedTemplate}
            onChange={(e) => setSelectedTemplate(e.target.value)}
            className="w-full rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-zinc-800 transition-all focus:border-blue-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20"
          >
            <option value="">{t('modal.noTemplate')}</option>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="flex gap-3 pt-2">
        <button
          type="button"
          onClick={onClose}
          className="flex-1 rounded-xl bg-zinc-100 px-4 py-3 font-medium text-zinc-600 hover:bg-zinc-200 transition-colors"
        >
          {t('task.cancel')}
        </button>
        <button
          type="submit"
          disabled={!boardName.trim()}
          className={`flex-1 rounded-xl px-4 py-3 font-medium transition-all shadow-sm hover:shadow ${!boardName.trim() ? 'bg-gradient-to-r from-zinc-300 to-zinc-300 text-zinc-400' : isEditing ? 'bg-gradient-to-r from-amber-500 to-orange-500 text-white hover:from-amber-600 hover:to-orange-600' : 'bg-gradient-to-r from-blue-500 to-blue-600 text-white hover:from-blue-600 hover:to-blue-700'}`}
        >
          {isEditing ? t('task.save') : t('task.create')}
        </button>
      </div>
    </form>
  );
}

export function CreateBoardModal({
  isOpen,
  editingBoard,
  templates,
  onClose,
  onSubmit,
}: CreateBoardModalProps) {
  const { t } = useTranslation();

  const isEditing = !!editingBoard;

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div className="absolute inset-0" />
      <div
        className="relative z-10 w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl border border-zinc-100"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-center gap-3">
          <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${isEditing ? 'bg-gradient-to-br from-amber-500 to-orange-500' : 'bg-gradient-to-br from-blue-500 to-blue-600'} text-white shadow-lg`}>
            {isEditing ? (
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
              </svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14M5 12h14"/>
              </svg>
            )}
          </div>
          <h2 className="text-xl font-bold text-zinc-800">
            {isEditing ? t('modal.editBoard') : t('modal.newBoard')}
          </h2>
        </div>

        <BoardForm
          key={isEditing ? editingBoard.id : 'new-board'}
          editingBoard={editingBoard}
          templates={templates}
          onClose={onClose}
          onSubmit={onSubmit}
          t={t}
        />
      </div>
    </div>
  );
}