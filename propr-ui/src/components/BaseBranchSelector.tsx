import React, { useState, useRef, useEffect } from 'react';
import { getRepoBranches } from '../api/proprApi';

interface BaseBranchSelectorProps {
  repoName: string;
  value: string;
  onChange: (branch: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

export const BaseBranchSelector: React.FC<BaseBranchSelectorProps> = ({
  repoName,
  value,
  onChange,
  placeholder = 'e.g., develop',
  disabled = false
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [branches, setBranches] = useState<string[]>([]);
  const [defaultBranch, setDefaultBranch] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Parse owner/repo from repoName
  const parseRepo = (name: string): { owner: string; repo: string } | null => {
    const parts = name.split('/');
    if (parts.length === 2 && parts[0] && parts[1]) {
      return { owner: parts[0], repo: parts[1] };
    }
    return null;
  };

  // Fetch branches when dropdown opens
  const fetchBranches = async () => {
    const parsed = parseRepo(repoName);
    if (!parsed) {
      setError('Invalid repository format');
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const response = await getRepoBranches(parsed.owner, parsed.repo);
      setBranches(response.branches);
      setDefaultBranch(response.defaultBranch);
    } catch (err) {
      setError((err as Error).message || 'Failed to fetch branches');
      setBranches([]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleOpen = () => {
    if (disabled || !repoName) return;
    setIsOpen(true);
    fetchBranches();
  };

  const filteredBranches = branches.filter(b =>
    b.toLowerCase().includes(filter.toLowerCase())
  );

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setFilter('');
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  const handleSelect = (branch: string) => {
    onChange(branch);
    setIsOpen(false);
    setFilter('');
  };

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange('');
  };

  if (!isOpen) {
    return (
      <div className="relative" ref={containerRef}>
        <button
          type="button"
          onClick={handleOpen}
          disabled={disabled || !repoName}
          className={`w-full px-3 py-2 text-left bg-white border border-gray-300 rounded-md font-mono text-sm transition-colors flex items-center justify-between ${
            disabled || !repoName
              ? 'opacity-50 cursor-not-allowed bg-gray-100'
              : 'hover:border-gray-400 focus:ring-2 focus:ring-primary-500 focus:border-primary-500 cursor-pointer'
          }`}
        >
          <span className={value ? 'text-gray-900' : 'text-gray-500'}>
            {value || placeholder}
          </span>
          <div className="flex items-center gap-1">
            {value && !disabled && (
              <button
                type="button"
                onClick={handleClear}
                className="p-0.5 hover:bg-gray-200 rounded text-gray-400 hover:text-gray-600"
                title="Clear selection"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
            <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </div>
        </button>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter branches..."
          className="w-full px-3 py-2 text-sm border border-primary-500 rounded-t-md font-mono focus:outline-none focus:ring-2 focus:ring-primary-500"
        />
        <div className="absolute right-0 top-full left-0 max-h-60 overflow-y-auto bg-white border border-t-0 border-gray-300 rounded-b-md shadow-lg z-20">
          {isLoading ? (
            <div className="px-3 py-4 text-sm text-gray-500 flex items-center gap-2">
              <svg className="animate-spin h-4 w-4 text-primary-600" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              Loading branches...
            </div>
          ) : error ? (
            <div className="px-3 py-2 text-sm text-red-600">{error}</div>
          ) : filteredBranches.length === 0 ? (
            <div className="px-3 py-2 text-sm text-gray-500">No branches found</div>
          ) : (
            <>
              {/* Option to clear/use default */}
              <button
                type="button"
                onClick={() => handleSelect('')}
                className={`w-full px-3 py-2 text-sm text-left hover:bg-gray-50 flex items-center justify-between border-b border-gray-100 ${
                  !value ? 'bg-primary-50 text-primary-700' : 'text-gray-600'
                }`}
              >
                <span className="italic">Use repository default ({defaultBranch})</span>
                {!value && (
                  <svg className="w-4 h-4 text-primary-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </button>
              {filteredBranches.map((branch) => (
                <button
                  key={branch}
                  type="button"
                  onClick={() => handleSelect(branch)}
                  className={`w-full px-3 py-2 text-sm font-mono text-left hover:bg-primary-50 flex items-center justify-between ${
                    branch === value ? 'bg-primary-50 text-primary-700' : 'text-gray-900'
                  }`}
                >
                  <span className="truncate flex items-center gap-2">
                    {branch}
                    {branch === defaultBranch && (
                      <span className="text-xs text-gray-500 font-sans">(default)</span>
                    )}
                  </span>
                  {branch === value && (
                    <svg className="w-4 h-4 text-primary-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </button>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default BaseBranchSelector;
