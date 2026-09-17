import { useTranslation } from 'react-i18next';
import type { Agent, Column } from '@/types/kanban';

export type ColumnTransitionTrigger = 'none' | 'on_enter' | 'on_exit' | 'both';

interface EditColumnModalProps {
  isOpen: boolean;
  column: Column | null;
  name: string;
  color: string;
  status: string;
  description: string;
  ownerAgent: string;
  agents: Agent[];
  boundAgentTypes: string[];
  transitionTrigger: ColumnTransitionTrigger;
  onClose: () => void;
  onSave: () => void;
  onNameChange: (name: string) => void;
  onColorChange: (color: string) => void;
  onStatusChange: (status: string) => void;
  onDescriptionChange: (description: string) => void;
  onOwnerAgentChange: (ownerAgent: string) => void;
  onBoundAgentTypesChange: (ids: string[]) => void;
  onTransitionTriggerChange: (trigger: ColumnTransitionTrigger) => void;
}

export function EditColumnModal({
  isOpen,
  column,
  name,
  color,
  status,
  description,
  ownerAgent,
  agents,
  boundAgentTypes,
  transitionTrigger,
  onClose,
  onSave,
  onNameChange,
  onColorChange,
  onStatusChange,
  onDescriptionChange,
  onOwnerAgentChange,
  onBoundAgentTypesChange,
  onTransitionTriggerChange,
}: EditColumnModalProps) {
  const { t } = useTranslation();

  if (!isOpen || !column) return null;

  const agentList = agents.filter(a => a.type === 'AGENT');
  const toggleAgentBinding = (id: string) => {
    if (boundAgentTypes.includes(id)) {
      onBoundAgentTypesChange(boundAgentTypes.filter(x => x !== id));
    } else {
      onBoundAgentTypesChange([...boundAgentTypes, id]);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-white dark:bg-zinc-700 p-6 shadow dark:bg-zinc-800 border border-zinc-100"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-amber-500 to-orange-500 text-white">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
            </svg>
          </div>
          <h2 className="text-xl font-bold text-zinc-800 dark:text-zinc-100">{t('modal.editColumn')}</h2>
        </div>

        <div className="space-y-5">
          <div>
            <label className="mb-2 block text-sm font-semibold text-zinc-700 dark:text-zinc-400">
              {t('column.columnName')}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => onNameChange(e.target.value)}
              className="w-full rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-700 px-4 py-3 text-zinc-800 dark:text-zinc-100 placeholder-zinc-400 transition-all focus:border-blue-500 focus:bg-white dark:bg-zinc-700 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              autoFocus
            />
          </div>

          <div>
            <label className="mb-2 block text-sm font-semibold text-zinc-700 dark:text-zinc-400">
              {t('column.statusCode')}
            </label>
            <input
              type="text"
              value={status}
              onChange={(e) => onStatusChange(e.target.value)}
              placeholder={t('column.statusPlaceholder')}
              className="w-full rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-700 px-4 py-3 text-zinc-800 dark:text-zinc-100 placeholder-zinc-400 transition-all focus:border-blue-500 focus:bg-white dark:bg-zinc-700 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            />
            <p className="mt-1.5 text-xs text-zinc-400 dark:text-zinc-500">{t('column.statusCodeHint')}</p>
          </div>

          <div>
            <label className="mb-2 block text-sm font-semibold text-zinc-700 dark:text-zinc-400">
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
              ].map(({ color: c, name: colorName }) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => onColorChange(c)}
                  className={`group relative h-10 w-10 rounded-xl transition-all hover:scale-110 ${
                    color === c
                      ? 'ring-2 ring-offset-2 ring-blue-500 scale-110'
                      : 'hover:ring-2 hover:ring-zinc-300 hover:ring-offset-1'
                  }`}
                  style={{ backgroundColor: c }}
                  title={colorName}
                />
              ))}
            </div>
          </div>

          <div>
            <label className="mb-2 block text-sm font-semibold text-zinc-700 dark:text-zinc-400">
              {t('column.description')}
            </label>
            <textarea
              value={description}
              onChange={(e) => onDescriptionChange(e.target.value)}
              placeholder={t('column.descriptionPlaceholder')}
              rows={3}
              className="w-full rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-700 px-4 py-3 text-zinc-800 dark:text-zinc-100 placeholder-zinc-400 transition-all focus:border-blue-500 focus:bg-white dark:bg-zinc-700 focus:outline-none focus:ring-2 focus:ring-blue-500/20 resize-none"
            />
            <p className="mt-1.5 text-xs text-zinc-400 dark:text-zinc-500">{t('column.descriptionHint')}</p>
          </div>

          <div>
            <label className="mb-2 block text-sm font-semibold text-zinc-700 dark:text-zinc-400">
              {t('column.ownerAgent')}
            </label>
            <select
              value={ownerAgent}
              onChange={(e) => onOwnerAgentChange(e.target.value)}
              className="w-full rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-700 px-4 py-3 text-zinc-800 dark:text-zinc-100 transition-all focus:border-blue-500 focus:bg-white dark:bg-zinc-700 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            >
              <option value="">{t('column.noOwnerAgent')}</option>
              {agentList.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.nickname}
                </option>
              ))}
            </select>
            <p className="mt-1.5 text-xs text-zinc-400 dark:text-zinc-500">{t('column.ownerAgentHint')}</p>
          </div>

          {/*
            s-1214: column workflow trigger. Binds one or more Agents
            to the column edge and toggles whether the Agent run fires
            when a task enters / exits / either.
          */}
          <div>
            <label className="mb-2 block text-sm font-semibold text-zinc-700 dark:text-zinc-400">
              {t('column.boundAgents')}
            </label>
            {agentList.length === 0 ? (
              <p className="text-xs text-zinc-400 dark:text-zinc-500">{t('column.noAgentsAvailable')}</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {agentList.map((agent) => {
                  const active = boundAgentTypes.includes(agent.id);
                  return (
                    <button
                      key={agent.id}
                      type="button"
                      onClick={() => toggleAgentBinding(agent.id)}
                      data-testid={`edit-column-agent-${agent.id}`}
                      aria-pressed={active}
                      className={`rounded-full px-3 py-1.5 text-xs font-medium transition-all ${
                        active
                          ? 'bg-blue-500 text-white shadow-sm hover:bg-blue-600'
                          : 'bg-zinc-100 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-600'
                      }`}
                    >
                      {active ? '✓ ' : ''}{agent.nickname}
                    </button>
                  );
                })}
              </div>
            )}
            <p className="mt-1.5 text-xs text-zinc-400 dark:text-zinc-500">{t('column.boundAgentsHint')}</p>
          </div>

          <div>
            <label className="mb-2 block text-sm font-semibold text-zinc-700 dark:text-zinc-400">
              {t('column.transitionTrigger')}
            </label>
            <div className="flex items-center gap-3">
              <button
                type="button"
                role="switch"
                aria-checked={transitionTrigger !== 'none'}
                data-testid="edit-column-trigger-toggle"
                onClick={() =>
                  onTransitionTriggerChange(transitionTrigger === 'none' ? 'on_enter' : 'none')
                }
                disabled={boundAgentTypes.length === 0}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  transitionTrigger !== 'none' ? 'bg-blue-500' : 'bg-zinc-300 dark:bg-zinc-600'
                } ${boundAgentTypes.length === 0 ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    transitionTrigger !== 'none' ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
              <span className="text-sm text-zinc-600 dark:text-zinc-300">
                {transitionTrigger !== 'none'
                  ? t('column.transitionEnabled')
                  : t('column.transitionDisabled')}
              </span>
            </div>
            {boundAgentTypes.length === 0 && (
              <p className="mt-1.5 text-xs text-amber-600 dark:text-amber-400">
                {t('column.transitionRequiresAgents')}
              </p>
            )}
            {boundAgentTypes.length > 0 && transitionTrigger !== 'none' && (
              <div className="mt-3 grid grid-cols-2 gap-2">
                  {([
                    { value: 'on_enter' as ColumnTransitionTrigger, label: t('column.triggerOnEnter') },
                    { value: 'on_exit' as ColumnTransitionTrigger, label: t('column.triggerOnExit') },
                  ]).map((opt) => {
                    const other = opt.value === 'on_enter' ? 'on_exit' : 'on_enter';
                    const wasChecked = transitionTrigger === opt.value || transitionTrigger === 'both';
                    const handleToggle = () => {
                      if (wasChecked) {
                        // Toggle off this edge
                        if (transitionTrigger === 'both') {
                          onTransitionTriggerChange(other);
                        } else {
                          onTransitionTriggerChange('none');
                        }
                      } else {
                        // Toggle on this edge
                        if (transitionTrigger === other) {
                          onTransitionTriggerChange('both');
                        } else {
                          onTransitionTriggerChange(opt.value);
                        }
                      }
                    };
                    return (
                      <label
                        key={opt.value}
                        className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-colors ${
                          wasChecked
                            ? 'border-blue-500 bg-blue-50 dark:bg-blue-500/10 text-blue-700 dark:text-blue-300'
                            : 'border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:border-blue-300'
                        }`}
                      >
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 rounded border-zinc-300 text-blue-500 focus:ring-blue-500"
                          checked={wasChecked}
                          onChange={handleToggle}
                          data-testid={`edit-column-trigger-${opt.value}`}
                        />
                        {opt.label}
                      </label>
                    );
                  })}
              </div>
            )}
            <p className="mt-1.5 text-xs text-zinc-400 dark:text-zinc-500">{t('column.transitionTriggerHint')}</p>
          </div>
        </div>

        <div className="mt-8 flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 rounded-xl bg-zinc-100 dark:bg-zinc-700 px-4 py-3 font-medium text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-600 transition-colors"
          >
            {t('column.cancel')}
          </button>
          <button
            onClick={onSave}
            disabled={!name.trim()}
            className="flex-1 rounded-xl bg-gradient-to-r from-blue-500 to-blue-600 px-4 py-3 font-medium text-white hover:from-blue-600 hover:to-blue-700 disabled:from-zinc-300 disabled:to-zinc-300 transition-all shadow-sm hover:shadow"
          >
            {t('column.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
