import { useTranslation } from 'react-i18next';

export function ShortcutsSettings() {
  const { t } = useTranslation();

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-zinc-800 dark:text-zinc-100">{t('settings.shortcuts')}</h2>
      <p className="text-sm text-zinc-500 dark:text-zinc-500">{t('settings.shortcutsDescription')}</p>
      <div className="space-y-6">
        <div>
          <h3 className="mb-3 text-sm font-medium text-zinc-700 dark:text-zinc-400">{t('settings.shortcutsGlobal')}</h3>
          <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 divide-y divide-zinc-100 dark:divide-zinc-700">
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-sm text-zinc-600 dark:text-zinc-300">{t('settings.shortcutSearch')}</span>
              <kbd className="rounded bg-zinc-100 dark:bg-zinc-700 px-2 py-1 text-xs font-mono text-zinc-600 dark:text-zinc-300">/</kbd>
            </div>
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-sm text-zinc-600 dark:text-zinc-300">{t('settings.shortcutNewTask')}</span>
              <kbd className="rounded bg-zinc-100 dark:bg-zinc-700 px-2 py-1 text-xs font-mono text-zinc-600 dark:text-zinc-300">N</kbd>
            </div>
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-sm text-zinc-600 dark:text-zinc-300">{t('settings.shortcutEditTask')}</span>
              <div className="flex gap-1">
                <kbd className="rounded bg-zinc-100 dark:bg-zinc-700 px-2 py-1 text-xs font-mono text-zinc-600 dark:text-zinc-300">E</kbd>
              </div>
            </div>
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-sm text-zinc-600 dark:text-zinc-300">{t('settings.shortcutSaveTask')}</span>
              <div className="flex gap-1">
                <kbd className="rounded bg-zinc-100 dark:bg-zinc-700 px-2 py-1 text-xs font-mono text-zinc-600 dark:text-zinc-300">Ctrl</kbd>
                <span className="text-xs text-zinc-400 dark:text-zinc-500">+</span>
                <kbd className="rounded bg-zinc-100 dark:bg-zinc-700 px-2 py-1 text-xs font-mono text-zinc-600 dark:text-zinc-300">S</kbd>
              </div>
            </div>
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-sm text-zinc-600 dark:text-zinc-300">{t('settings.shortcutCancelEdit')}</span>
              <kbd className="rounded bg-zinc-100 dark:bg-zinc-700 px-2 py-1 text-xs font-mono text-zinc-600 dark:text-zinc-300">Esc</kbd>
            </div>
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-sm text-zinc-600 dark:text-zinc-300">{t('settings.shortcutQuickAdd')}</span>
              <kbd className="rounded bg-zinc-100 dark:bg-zinc-700 px-2 py-1 text-xs font-mono text-zinc-600 dark:text-zinc-300">Q</kbd>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
