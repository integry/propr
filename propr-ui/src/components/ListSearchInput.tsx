import React from 'react';
import { Search, X } from 'lucide-react';

interface ListSearchInputProps {
  value: string;
  onChange: (value: string) => void;
  onClear: () => void;
  /** Accessible name, e.g. "Search tasks". The placeholder adds the ellipsis. */
  label: string;
  className?: string;
  inputClassName?: string;
  /** Phone sizing: a 16px font (no iOS focus zoom) and 40px input and clear targets. */
  touch?: boolean;
}

/**
 * The search field shared by the Tasks, Plans and Goals list headers. Callers
 * keep their own query, debounce and URL handling; this only draws the input
 * and its clear action.
 */
export const ListSearchInput: React.FC<ListSearchInputProps> = ({
  value,
  onChange,
  onClear,
  label,
  className = '',
  inputClassName = '',
  touch = false,
}) => {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const clear = () => {
    onClear();
    inputRef.current?.focus();
  };
  return (
    <div className={`relative ${className}`}>
      <Search size={16} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
      <input
        ref={inputRef}
        type="text"
        inputMode="search"
        enterKeyHint="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        // The query applies as you type; Enter only dismisses a phone keyboard.
        onKeyDown={(e) => { if (touch && e.key === 'Enter') e.currentTarget.blur(); }}
        aria-label={label}
        placeholder={`${label}...`}
        className={`pl-9 w-full border border-gray-300 rounded-md bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500 ${touch ? 'h-10 pr-10 text-base' : 'pr-8 py-2 text-sm'} ${inputClassName}`}
      />
      {value && (
        <button
          type="button"
          onClick={clear}
          className={`absolute top-1/2 -translate-y-1/2 flex items-center justify-center rounded-md text-gray-400 hover:text-gray-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 ${touch ? 'right-0 h-10 w-10' : 'right-2'}`}
          title="Clear search"
          aria-label="Clear search"
        >
          <X size={16} aria-hidden="true" />
        </button>
      )}
    </div>
  );
};
