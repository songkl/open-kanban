import { useState, useRef, useEffect } from 'react';

interface DropdownOption {
  value: string;
  label: string;
}

interface CustomDropdownProps {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}

export function CustomDropdown({
  value,
  options,
  onChange,
  placeholder = 'Select...',
  className = '',
  disabled = false,
}: CustomDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedOption = options.find(opt => opt.value === value);

  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        e.preventDefault();
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;

    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setIsOpen(!isOpen);
    } else if (e.key === 'ArrowDown' && isOpen) {
      e.preventDefault();
      const currentIndex = options.findIndex(opt => opt.value === value);
      const nextIndex = currentIndex < options.length - 1 ? currentIndex + 1 : 0;
      onChange(options[nextIndex].value);
    } else if (e.key === 'ArrowUp' && isOpen) {
      e.preventDefault();
      const currentIndex = options.findIndex(opt => opt.value === value);
      const prevIndex = currentIndex > 0 ? currentIndex - 1 : options.length - 1;
      onChange(options[prevIndex].value);
    } else if (e.key === 'Escape') {
      setIsOpen(false);
    }
  };

  const handleSelect = (optionValue: string) => {
    onChange(optionValue);
    setIsOpen(false);
  };

  return (
    <div
      ref={containerRef}
      className={`relative ${className}`}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (!disabled) setIsOpen(!isOpen);
        }}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        className={`w-full rounded-md border px-3 py-1.5 text-left text-sm flex items-center justify-between ${
          disabled
            ? 'bg-zinc-100 dark:bg-zinc-700 border-zinc-200 dark:border-zinc-600 text-zinc-400 cursor-not-allowed'
            : 'bg-white dark:bg-zinc-700 border-zinc-300 dark:border-zinc-600 text-zinc-700 dark:text-zinc-200 hover:border-zinc-400 dark:hover:border-zinc-500'
        }`}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <span className={selectedOption ? '' : 'text-zinc-400'}>
          {selectedOption?.label || placeholder}
        </span>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`transition-transform ${isOpen ? 'rotate-180' : ''}`}
        >
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>

      {isOpen && (
        <div
          className="absolute z-50 mt-1 w-full rounded-md bg-white dark:bg-zinc-700 shadow-lg ring-1 ring-zinc-200 dark:ring-zinc-600 max-h-60 overflow-auto"
          role="listbox"
        >
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => handleSelect(option.value)}
              className={`w-full text-left px-3 py-2 text-sm ${
                option.value === value
                  ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                  : 'text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-600'
              } first:rounded-t-md last:rounded-b-md`}
              role="option"
              aria-selected={option.value === value}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
