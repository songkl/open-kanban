import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authApi, attachmentsApi } from '../../services/api';
import { showErrorToast } from '../ErrorToast';
import { UserAvatar } from '../UserAvatar';
import type { User } from '../../types/kanban';

interface ProfileSettingsProps {
  currentUser: User;
  onUserUpdate: (user: User) => void;
}

export function ProfileSettings({ currentUser, onUserUpdate }: ProfileSettingsProps) {
  const { t } = useTranslation();
  const [nickname, setNickname] = useState(currentUser.nickname);
  const [avatar, setAvatar] = useState(currentUser.avatar || '');
  const [updateSuccess, setUpdateSuccess] = useState(false);

  const handleUpdateProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentUser.id) return;

    try {
      await authApi.updateUser(currentUser.id, { nickname, avatar: avatar || '' });
      onUserUpdate({ ...currentUser, nickname, avatar });
      setUpdateSuccess(true);
      setTimeout(() => setUpdateSuccess(false), 2000);
    } catch (err) {
      console.error('Failed to update profile:', err);
    }
  };

  return (
    <form onSubmit={handleUpdateProfile} className="space-y-6">
      <h2 className="text-lg font-semibold text-zinc-800">{t('settings.profile')}</h2>

      <div>
        <label className="mb-2 block text-sm font-medium text-zinc-700">{t('settings.avatar')}</label>
        <div className="space-y-4">
          <div className="flex items-center gap-4">
            <UserAvatar
              username={nickname}
              avatar={avatar}
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
                        setAvatar(attachment.url);
                      } catch {
                        showErrorToast(t('settings.avatarUploadFailed'));
                      }
                    }}
                  />
                  {t('settings.uploadAvatar')}
                </label>
                {avatar && (
                  <button
                    type="button"
                    onClick={() => setAvatar('')}
                    className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
                  >
                    {t('settings.useLetterAvatar')}
                  </button>
                )}
              </div>
              <p className="text-xs text-zinc-500">{t('settings.avatarHint')}</p>
            </div>
          </div>
        </div>
      </div>

      <div>
        <label htmlFor="nickname" className="mb-2 block text-sm font-medium text-zinc-700">{t('settings.nickname')}</label>
        <input
          id="nickname"
          type="text"
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          className="w-full rounded-md border border-zinc-300 px-4 py-2 focus:border-blue-500 focus:outline-none"
          maxLength={20}
        />
      </div>

      <div className="flex items-center gap-4">
        <button
          type="submit"
          className="rounded-md bg-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600"
        >
          {t('settings.saveChanges')}
        </button>
        {updateSuccess && <span className="text-sm text-green-600">{t('settings.saveSuccess')}</span>}
      </div>
    </form>
  );
}
