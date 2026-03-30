import { useTranslation } from 'react-i18next';

export function LoadingScreen() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-100">
      <div className="text-center">
        <div className="mb-4 text-4xl font-bold text-zinc-800">Open kanban</div>
        <div className="flex items-center justify-center gap-2 text-zinc-500">
          <svg className="h-5 w-5 animate-spin text-blue-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <span>{t('app.loading')}</span>
        </div>
      </div>
    </div>
  );
}
