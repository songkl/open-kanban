import { useTranslation } from 'react-i18next';

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  onClear: () => void;
}

export function SearchBar({ value, onChange, onClear }: SearchBarProps) {
  const { t } = useTranslation();

  return (
    <div className="relative flex items-center">
      <input
        type="text"
        id="search-input"
        name="search-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t('filter.searchPlaceholder')}
        className="w-40 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
      />
      {value && (
        <button
          onClick={onClear}
          className="absolute right-2 text-zinc-400 hover:text-zinc-600"
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