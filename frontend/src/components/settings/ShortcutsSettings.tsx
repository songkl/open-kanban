import { useTranslation } from 'react-i18next';

export function ShortcutsSettings() {
  const { t } = useTranslation();

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-zinc-800">{t('settings.shortcuts')}</h2>
      <p className="text-sm text-zinc-500">{t('settings.shortcutsDescription')}</p>
      <div className="space-y-6">
        <div>
          <h3 className="mb-3 text-sm font-medium text-zinc-700">{t('settings.shortcutsGlobal')}</h3>
          <div className="rounded-lg border border-zinc-200 divide-y divide-zinc-100">
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-sm text-zinc-600">{t('settings.shortcutSearch')}</span>
              <kbd className="rounded bg-zinc-100 px-2 py-1 text-xs font-mono text-zinc-600">/</kbd>
            </div>
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-sm text-zinc-600">{t('settings.shortcutNewTask')}</span>
              <kbd className="rounded bg-zinc-100 px-2 py-1 text-xs font-mono text-zinc-600">N</kbd>
            </div>
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-sm text-zinc-600">{t('settings.shortcutEditTask')}</span>
              <div className="flex gap-1">
                <kbd className="rounded bg-zinc-100 px-2 py-1 text-xs font-mono text-zinc-600">E</kbd>
              </div>
            </div>
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-sm text-zinc-600">{t('settings.shortcutSaveTask')}</span>
              <div className="flex gap-1">
                <kbd className="rounded bg-zinc-100 px-2 py-1 text-xs font-mono text-zinc-600">Ctrl</kbd>
                <span className="text-xs text-zinc-400">+</span>
                <kbd className="rounded bg-zinc-100 px-2 py-1 text-xs font-mono text-zinc-600">S</kbd>
              </div>
            </div>
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-sm text-zinc-600">{t('settings.shortcutCancelEdit')}</span>
              <kbd className="rounded bg-zinc-100 px-2 py-1 text-xs font-mono text-zinc-600">Esc</kbd>
            </div>
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-sm text-zinc-600">{t('settings.shortcutQuickAdd')}</span>
              <kbd className="rounded bg-zinc-100 px-2 py-1 text-xs font-mono text-zinc-600">Q</kbd>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
