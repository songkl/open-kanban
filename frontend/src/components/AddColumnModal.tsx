import { useTranslation } from 'react-i18next';
import type { Agent } from '@/types/kanban';

interface AddColumnModalProps {
  isOpen: boolean;
  newColumnName: string;
  newColumnColor: string;
  status: string;
  description: string;
  ownerAgent: string;
  agents: Agent[];
  onClose: () => void;
  onAdd: () => void;
  onNameChange: (name: string) => void;
  onColorChange: (color: string) => void;
  onStatusChange: (status: string) => void;
  onDescriptionChange: (description: string) => void;
  onOwnerAgentChange: (ownerAgent: string) => void;
}

export function AddColumnModal({
  isOpen,
  newColumnName,
  newColumnColor,
  status,
  description,
  ownerAgent,
  agents,
  onClose,
  onAdd,
  onNameChange,
  onColorChange,
  onStatusChange,
  onDescriptionChange,
  onOwnerAgentChange,
}: AddColumnModalProps) {
  const { t } = useTranslation();

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl border border-zinc-100"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-blue-600 text-white">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14M5 12h14"/>
            </svg>
          </div>
          <h2 className="text-xl font-bold text-zinc-800">{t('modal.addColumn')}</h2>
        </div>

        <div className="space-y-5">
          <div>
            <label className="mb-2 block text-sm font-semibold text-zinc-700">
              {t('column.columnName')}
            </label>
            <input
              type="text"
              value={newColumnName}
              onChange={(e) => onNameChange(e.target.value)}
              placeholder={t('column.namePlaceholder')}
              className="w-full rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-zinc-800 placeholder-zinc-400 transition-all focus:border-blue-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              autoFocus
            />
          </div>

          <div>
            <label className="mb-2 block text-sm font-semibold text-zinc-700">
              {t('column.statusCode')}
            </label>
            <input
              type="text"
              value={status}
              onChange={(e) => onStatusChange(e.target.value)}
              placeholder={t('column.statusPlaceholder')}
              className="w-full rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-zinc-800 placeholder-zinc-400 transition-all focus:border-blue-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            />
            <p className="mt-1.5 text-xs text-zinc-400">{t('column.statusCodeHint')}</p>
          </div>

          <div>
            <label className="mb-2 block text-sm font-semibold text-zinc-700">
              {t('column.color')}
            </label>
            <div className="flex gap-3">
              {[
                { color: '#ef4444', name: t('column.colorRed') },
                { color: '#f59e0b', name: t('column.colorOrange') },
                { color: '#3b82f6', name: t('column.colorBlue') },
                { color: '#22c55e', name: t('column.colorGreen') },
                { color: '#8b5cf6', name: t('column.colorPurple') },
                { color: '#6b7280', name: t('column.colorGray') },
              ].map(({ color, name }) => (
                <button
                  key={color}
                  type="button"
                  onClick={() => onColorChange(color)}
                  className={`group relative h-10 w-10 rounded-xl transition-all hover:scale-110 ${
                    newColumnColor === color
                      ? 'ring-2 ring-offset-2 ring-blue-500 scale-110'
                      : 'hover:ring-2 hover:ring-zinc-300 hover:ring-offset-1'
                  }`}
                  style={{ backgroundColor: color }}
                  title={name}
                />
              ))}
            </div>
          </div>

          <div>
            <label className="mb-2 block text-sm font-semibold text-zinc-700">
              {t('column.description')}
            </label>
            <textarea
              value={description}
              onChange={(e) => onDescriptionChange(e.target.value)}
              placeholder={t('column.descriptionPlaceholder')}
              rows={3}
              className="w-full rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-zinc-800 placeholder-zinc-400 transition-all focus:border-blue-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 resize-none"
            />
            <p className="mt-1.5 text-xs text-zinc-400">{t('column.descriptionHint')}</p>
          </div>

          <div>
            <label className="mb-2 block text-sm font-semibold text-zinc-700">
              {t('column.ownerAgent')}
            </label>
            <select
              value={ownerAgent}
              onChange={(e) => onOwnerAgentChange(e.target.value)}
              className="w-full rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-zinc-800 transition-all focus:border-blue-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            >
              <option value="">{t('column.noOwnerAgent')}</option>
              {agents.filter(a => a.type === 'AGENT').map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.nickname}
                </option>
              ))}
            </select>
            <p className="mt-1.5 text-xs text-zinc-400">{t('column.ownerAgentHint')}</p>
          </div>
        </div>

        <div className="mt-8 flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 rounded-xl bg-zinc-100 px-4 py-3 font-medium text-zinc-600 hover:bg-zinc-200 transition-colors"
          >
            {t('column.cancel')}
          </button>
          <button
            onClick={onAdd}
            disabled={!newColumnName.trim()}
            className="flex-1 rounded-xl bg-gradient-to-r from-blue-500 to-blue-600 px-4 py-3 font-medium text-white hover:from-blue-600 hover:to-blue-700 disabled:from-zinc-300 disabled:to-zinc-300 transition-all shadow-sm hover:shadow"
          >
            {t('column.addColumn')}
          </button>
        </div>
      </div>
    </div>
  );
}