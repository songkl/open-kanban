import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { authApi, attachmentsApi } from '../../services/api';
import { showErrorToast } from '../ErrorToast';
import { UserAvatar } from '../UserAvatar';
import { ConfirmDialog } from '../ConfirmDialog';
import type { Agent } from '../../types/kanban';

interface ConfirmDialogState {
  isOpen: boolean;
  title: string;
  message: string;
  onConfirm: () => void;
  variant?: 'danger' | 'warning' | 'default';
}

export function AgentsSettings() {
  const { t } = useTranslation();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [newAgentName, setNewAgentName] = useState('');
  const [newAgentRole, setNewAgentRole] = useState<'ADMIN' | 'MEMBER' | 'VIEWER'>('MEMBER');
  const [creatingAgent, setCreatingAgent] = useState(false);
  const [showTokenModal, setShowTokenModal] = useState(false);
  const [newAgentToken, setNewAgentToken] = useState('');
  const [agentTokenCopied, setAgentTokenCopied] = useState(false);
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [editingAgentNickname, setEditingAgentNickname] = useState('');
  const [editingAgentAvatar, setEditingAgentAvatar] = useState('');
  const [editingAgentSaving, setEditingAgentSaving] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState>({ isOpen: false, title: '', message: '', onConfirm: () => {} });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadAgents();
  }, []);

  const loadAgents = async () => {
    setLoading(true);
    try {
      const data = await authApi.getAgents();
      setAgents(data || []);
    } catch (err) {
      console.error('Failed to load agents:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newAgentName.trim()) return;
    setCreatingAgent(true);
    try {
      const data = await authApi.createAgent(newAgentName.trim(), undefined, newAgentRole);
      await loadAgents();
      setNewAgentName('');
      setNewAgentRole('MEMBER');
      setNewAgentToken(data.agent.token);
      setShowTokenModal(true);
    } catch (err) {
      console.error('Failed to create agent:', err);
    } finally {
      setCreatingAgent(false);
    }
  };

  const handleUpdateAgent = async () => {
    if (!editingAgentNickname.trim()) return;
    setEditingAgentSaving(true);
    try {
      await authApi.updateUser(editingAgent!.id, {
        nickname: editingAgentNickname.trim(),
        avatar: editingAgentAvatar || '',
      });
      await loadAgents();
      setEditingAgent(null);
    } catch (err) {
      console.error('Failed to update agent:', err);
      showErrorToast(t('settings.updateAgentFailed'));
    } finally {
      setEditingAgentSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <h2 className="text-lg font-semibold text-zinc-800">{t('settings.agentManagement')}</h2>
        <div className="py-8 text-center text-zinc-500">{t('common.loading')}</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-zinc-800">{t('settings.agentManagement')}</h2>
      <p className="text-sm text-zinc-500">{t('settings.agentDescription')}</p>

      <form onSubmit={handleCreateAgent} className="flex gap-3">
        <input
          type="text"
          value={newAgentName}
          onChange={(e) => setNewAgentName(e.target.value)}
          placeholder={t('settings.agentNamePlaceholder')}
          className="flex-1 rounded-md border border-zinc-300 px-4 py-2 focus:border-blue-500 focus:outline-none"
        />
        <select
          value={newAgentRole}
          onChange={(e) => setNewAgentRole(e.target.value as 'ADMIN' | 'MEMBER' | 'VIEWER')}
          className="rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
        >
          <option value="ADMIN">{t('settings.admin')}</option>
          <option value="MEMBER">{t('settings.member')}</option>
          <option value="VIEWER">{t('settings.viewer')}</option>
        </select>
        <button
          type="submit"
          disabled={creatingAgent || !newAgentName.trim()}
          className="rounded-md bg-green-500 px-4 py-2 text-sm font-medium text-white hover:bg-green-600 disabled:bg-zinc-300"
        >
          {creatingAgent ? t('settings.creating') : t('settings.createAgent')}
        </button>
      </form>

      <div className="space-y-3">
        {agents.map((agent) => (
          <div key={agent.id} className="flex items-center justify-between rounded-lg border border-zinc-200 p-4">
            <div className="flex items-center gap-3">
              <UserAvatar
                username={agent.nickname}
                avatar={agent.avatar}
                size="md"
              />
              <div>
                <div className="font-medium text-zinc-800">{agent.nickname}</div>
                <div className="flex gap-2 text-xs text-zinc-500">
                  <span className={`rounded px-1.5 py-0.5 text-xs ${agent.role === 'ADMIN' ? 'bg-blue-200 text-blue-800' : agent.role === 'MEMBER' ? 'bg-green-200 text-green-800' : 'bg-zinc-200 text-zinc-600'}`}>
                    {agent.role === 'ADMIN' ? t('settings.admin') : agent.role === 'MEMBER' ? t('settings.member') : t('settings.viewer')}
                  </span>
                  {agent.lastActiveAt && (
                    <span>{t('settings.lastActive', { time: new Date(agent.lastActiveAt).toLocaleString() })}</span>
                  )}
                  {!agent.lastActiveAt && <span>{t('settings.neverActive')}</span>}
                </div>
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  setConfirmDialog({
                    isOpen: true,
                    title: t('settings.toggleEnabledTitle') || t('modal.confirmTitle'),
                    message: t('settings.toggleEnabledConfirm', { name: agent.nickname, action: agent.enabled ? t('settings.disable') : t('settings.enable') }),
                    variant: 'warning',
                    onConfirm: async () => {
                      try {
                        await authApi.setUserEnabled(agent.id, !agent.enabled);
                        await loadAgents();
                      } catch (err) {
                        console.error('Failed to toggle agent enabled:', err);
                      }
                      setConfirmDialog(prev => ({ ...prev, isOpen: false }));
                    },
                  });
                }}
                className={`rounded px-3 py-1 text-sm ${agent.enabled ? 'bg-orange-50 text-orange-600 hover:bg-orange-100' : 'bg-green-50 text-green-600 hover:bg-green-100'}`}
              >
                {agent.enabled ? t('settings.disable') : t('settings.enable')}
              </button>
              <button
                onClick={() => {
                  setEditingAgent(agent);
                  setEditingAgentNickname(agent.nickname);
                  setEditingAgentAvatar(agent.avatar || '');
                }}
                className="rounded bg-zinc-100 px-3 py-1 text-sm text-zinc-700 hover:bg-zinc-200"
              >
                {t('settings.edit')}
              </button>
              <button
                onClick={() => {
                  setConfirmDialog({
                    isOpen: true,
                    title: t('settings.resetTokenTitle') || t('modal.confirmTitle'),
                    message: t('settings.resetTokenConfirm', { name: agent.nickname }),
                    variant: 'warning',
                    onConfirm: async () => {
                      try {
                        const data = await authApi.resetAgentToken(agent.id);
                        setNewAgentToken(data.token);
                        setShowTokenModal(true);
                      } catch (err) {
                        console.error('Failed to reset token:', err);
                      }
                      setConfirmDialog(prev => ({ ...prev, isOpen: false }));
                    },
                  });
                }}
                className="rounded bg-blue-50 px-3 py-1 text-sm text-blue-600 hover:bg-blue-100"
              >
                {t('settings.resetToken')}
              </button>
              <button
                onClick={() => {
                  setConfirmDialog({
                    isOpen: true,
                    title: t('settings.deleteAgentTitle') || t('modal.deleteConfirmTitle'),
                    message: t('settings.deleteAgentConfirm', { name: agent.nickname }),
                    variant: 'danger',
                    onConfirm: async () => {
                      try {
                        await authApi.deleteAgent(agent.id);
                        await loadAgents();
                      } catch (err) {
                        console.error('Failed to delete agent:', err);
                      }
                      setConfirmDialog(prev => ({ ...prev, isOpen: false }));
                    },
                  });
                }}
                className="rounded bg-red-50 px-3 py-1 text-sm text-red-600 hover:bg-red-100"
              >
                {t('settings.delete')}
              </button>
            </div>
          </div>
        ))}
        {agents.length === 0 && (
          <div className="py-8 text-center text-zinc-500">{t('settings.noAgents')}</div>
        )}
      </div>

      {showTokenModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" />
          <div className="relative z-10 w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
            <h2 className="mb-4 text-lg font-semibold text-zinc-800">{t('settings.tokenGenerated')}</h2>
            <p className="mb-4 text-sm text-zinc-500">{t('settings.tokenGeneratedHint')}</p>
            <div className="mb-4 flex items-center gap-2 rounded-lg bg-zinc-100 p-3">
              <code className="flex-1 break-all font-mono text-sm">{newAgentToken}</code>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(newAgentToken).then(() => {
                    setAgentTokenCopied(true);
                    setTimeout(() => setAgentTokenCopied(false), 2000);
                  }).catch(() => {
                    showErrorToast(t('settings.copyFailed'), 'error');
                  });
                }}
                className={`rounded px-3 py-1 text-sm text-white transition-colors ${
                  agentTokenCopied ? 'bg-green-500' : 'bg-blue-500 hover:bg-blue-600'
                }`}
              >
                {agentTokenCopied ? t('settings.copied') : t('settings.copy')}
              </button>
            </div>
            <button
              onClick={() => setShowTokenModal(false)}
              className="w-full rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-200"
            >
              {t('settings.close')}
            </button>
          </div>
        </div>
      )}

      {editingAgent && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => setEditingAgent(null)} />
          <div className="relative z-10 w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
            <h2 className="mb-4 text-lg font-semibold text-zinc-800">{t('settings.editAgent')}</h2>
            <form onSubmit={(e) => { e.preventDefault(); handleUpdateAgent(); }} className="space-y-4">
              <div>
                <label className="mb-2 block text-sm font-medium text-zinc-700">{t('settings.avatar')}</label>
                <div className="space-y-3">
                  <div className="flex items-center gap-4">
                    <UserAvatar
                      username={editingAgentNickname}
                      avatar={editingAgentAvatar}
                      size="lg"
                    />
                    <div className="flex flex-col gap-2">
                      <div className="flex gap-2">
                        <label className="cursor-pointer rounded-md bg-blue-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-600">
                          <input
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={async (e) => {
                              const file = e.target.files?.[0];
                              if (!file) return;
                              try {
                                const { promise } = attachmentsApi.upload(file);
                                const attachment = await promise;
                                setEditingAgentAvatar(attachment.url);
                              } catch (err) {
                                showErrorToast(t('settings.avatarUploadFailed'));
                              }
                            }}
                          />
                          {t('settings.uploadAvatar')}
                        </label>
                        {editingAgentAvatar && (
                          <button
                            type="button"
                            onClick={() => setEditingAgentAvatar('')}
                            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
                          >
                            {t('settings.useLetterAvatar')}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div>
                <label className="mb-2 block text-sm font-medium text-zinc-700">{t('settings.nickname')}</label>
                <input
                  type="text"
                  value={editingAgentNickname}
                  onChange={(e) => setEditingAgentNickname(e.target.value)}
                  className="w-full rounded-md border border-zinc-300 px-4 py-2 focus:border-blue-500 focus:outline-none"
                  maxLength={20}
                />
              </div>
              <div className="flex gap-2 pt-2">
                <button
                  type="submit"
                  disabled={editingAgentSaving || !editingAgentNickname.trim()}
                  className="flex-1 rounded-md bg-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600 disabled:bg-zinc-300"
                >
                  {editingAgentSaving ? t('settings.saving') : t('settings.save')}
                </button>
                <button
                  type="button"
                  onClick={() => setEditingAgent(null)}
                  className="flex-1 rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-200"
                >
                  {t('settings.cancel')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <ConfirmDialog
        isOpen={confirmDialog.isOpen}
        title={confirmDialog.title}
        message={confirmDialog.message}
        variant={confirmDialog.variant}
        onConfirm={confirmDialog.onConfirm}
        onCancel={() => setConfirmDialog(prev => ({ ...prev, isOpen: false }))}
      />
    </div>
  );
}
