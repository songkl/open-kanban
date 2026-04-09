import { useTranslation } from 'react-i18next';
import { useUIStore } from '../../store/uiStore';

export function ThemeSettings() {
  const { t } = useTranslation();
  const darkMode = useUIStore((state) => state.darkMode);
  const toggleDarkMode = useUIStore((state) => state.toggleDarkMode);

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-zinc-800">{t('settings.theme')}</h2>
      <p className="text-sm text-zinc-500">{t('settings.themeDescription')}</p>
      <div className="space-y-4">
        <div className="rounded-lg border border-zinc-200 divide-y divide-zinc-100">
          <div className="flex items-center justify-between px-4 py-3">
            <div className="flex items-center gap-3">
              {darkMode ? (
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-orange-400">
                  <circle cx="12" cy="12" r="5"/>
                  <line x1="12" y1="1" x2="12" y2="3"/>
                  <line x1="12" y1="21" x2="12" y2="23"/>
                  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
                  <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
                  <line x1="1" y1="12" x2="3" y2="12"/>
                  <line x1="21" y1="12" x2="23" y2="12"/>
                  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
                  <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
                </svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-400">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
                </svg>
              )}
              <div>
                <span className="text-sm text-zinc-600">{t('settings.darkMode')}</span>
                <p className="text-xs text-zinc-400">{darkMode ? t('settings.darkModeOn') : t('settings.darkModeOff')}</p>
              </div>
            </div>
            <button
              onClick={() => toggleDarkMode()}
              aria-label={darkMode ? t('settings.darkModeOn') : t('settings.darkModeOff')}
              aria-checked={darkMode}
              role="switch"
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${darkMode ? 'bg-blue-600' : 'bg-zinc-300'}`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${darkMode ? 'translate-x-6' : 'translate-x-1'}`}
              />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}