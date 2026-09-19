import { useTranslation } from 'react-i18next';

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  onClear: () => void;
  isMobile?: boolean;
}

export function SearchBar({ value, onChange, onClear, isMobile = false }: SearchBarProps) {
  const { t } = useTranslation();

  if (isMobile) {
    return (
      <div className="relative flex items-center w-full">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="absolute left-2.5 text-zinc-400 dark:text-zinc-500 pointer-events-none"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="text"
          id="search-input"
          name="search-input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t('filter.searchPlaceholder')}
          aria-label={t('filter.searchPlaceholder')}
          className="w-full min-h-[36px] rounded-md border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-700 pl-8 pr-8 py-1.5 text-sm text-zinc-800 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-400"
        />
        {value && (
          <button
            type="button"
            onClick={onClear}
            aria-label={t('filter.clearSearch')}
            className="absolute right-1 flex items-center justify-center min-h-[32px] min-w-[32px] text-zinc-400 dark:text-zinc-300"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="relative flex items-center">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="absolute left-2.5 text-zinc-400 dark:text-zinc-500 pointer-events-none"
        aria-hidden="true"
      >
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <input
        type="text"
        id="search-input"
        name="search-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t('filter.searchPlaceholder')}
        aria-label={t('filter.searchPlaceholder')}
        className="w-40 pl-8 pr-8 rounded-md border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-700 py-1.5 text-sm text-zinc-800 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-400"
      />
      {value && (
        <button
          type="button"
          onClick={onClear}
          aria-label={t('filter.clearSearch')}
          className="absolute right-1 flex items-center justify-center min-h-[32px] min-w-[32px] text-zinc-400 dark:text-zinc-300"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      )}
    </div>
  );
}