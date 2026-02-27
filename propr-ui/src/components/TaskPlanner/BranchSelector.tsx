import React, { useState, useRef, useEffect } from 'react';
import { ChevronDown, Check, Loader2, GitBranch } from 'lucide-react';

interface BranchSelectorProps {
  value: string;
  branches: string[];
  isLoading: boolean;
  error: string | null;
  onChange: (branch: string) => void;
  variant?: 'light' | 'dark';
}

export const BranchSelector: React.FC<BranchSelectorProps> = ({
  value,
  branches,
  isLoading,
  error,
  onChange,
  variant = 'dark'
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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

  const isDark = variant === 'dark';

  if (!isOpen) {
    return (
      <div className="flex flex-col items-end">
        <label className={`block text-sm font-medium mb-1 ${isDark ? 'text-slate-400' : 'text-gray-700'}`}>
          Base Branch
        </label>
        <button
          type="button"
          onClick={() => setIsOpen(true)}
          disabled={isLoading}
          className={`inline-flex items-center gap-2 px-3 py-1.5 text-sm font-mono rounded-lg transition-colors ${
            isDark
              ? error
                ? 'text-red-300 bg-red-900/30 border border-red-700/50 hover:bg-red-900/50'
                : 'text-white bg-slate-700 hover:bg-slate-600 border border-slate-600'
              : error
                ? 'text-red-700 border border-red-300 bg-red-50 hover:bg-red-100'
                : 'text-gray-900 border border-gray-300 bg-white hover:bg-gray-50'
          }`}
        >
          {isLoading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <>
              <GitBranch className={`w-4 h-4 ${isDark ? 'text-slate-400' : 'text-gray-500'}`} />
              <span className="max-w-[150px] truncate">{value}</span>
              <ChevronDown className={`w-4 h-4 ${isDark ? 'text-slate-400' : 'text-gray-500'}`} />
            </>
          )}
        </button>
        {error && (
          <p className={`text-xs mt-1 ${isDark ? 'text-red-300' : 'text-red-600'}`}>{error}</p>
        )}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex flex-col items-end relative z-50">
      <label className={`block text-sm font-medium mb-1 ${isDark ? 'text-slate-400' : 'text-gray-700'}`}>
        Base Branch
      </label>
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter branches..."
          className="w-56 px-3 py-1.5 text-sm border border-indigo-500 rounded-t-lg font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white text-gray-900"
        />
        <div className="absolute right-0 top-full w-56 max-h-60 overflow-y-auto bg-white border border-t-0 border-gray-300 rounded-b-lg shadow-xl">
          {filteredBranches.length === 0 ? (
            <div className="px-3 py-2 text-sm text-gray-500">No branches found</div>
          ) : (
            filteredBranches.map((branch) => (
              <button
                key={branch}
                type="button"
                onClick={() => handleSelect(branch)}
                className={`w-full px-3 py-2 text-sm font-mono text-left hover:bg-indigo-50 flex items-center justify-between ${
                  branch === value ? 'bg-indigo-50 text-indigo-700' : 'text-gray-900'
                }`}
              >
                <span className="truncate">{branch}</span>
                {branch === value && <Check className="w-4 h-4 flex-shrink-0" />}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
