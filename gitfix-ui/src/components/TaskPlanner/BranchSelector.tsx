import React, { useState, useRef, useEffect } from 'react';
import { ChevronDown, Check, Loader2 } from 'lucide-react';

interface BranchSelectorProps {
  value: string;
  branches: string[];
  isLoading: boolean;
  error: string | null;
  onChange: (branch: string) => void;
}

export const BranchSelector: React.FC<BranchSelectorProps> = ({
  value,
  branches,
  isLoading,
  error,
  onChange
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

  if (!isOpen) {
    return (
      <div className="flex flex-col items-end">
        <label className="block text-sm font-medium text-gray-700 mb-1">Base Branch</label>
        <button
          type="button"
          onClick={() => setIsOpen(true)}
          disabled={isLoading}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-mono rounded-md transition-colors ${
            error
              ? 'text-red-700 border-b border-dotted border-red-400 hover:bg-red-50'
              : 'text-gray-900 border-b border-dotted border-gray-400 hover:bg-gray-100'
          }`}
        >
          {isLoading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <>
              {value}
              <ChevronDown className="w-4 h-4 text-gray-500" />
            </>
          )}
        </button>
        {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex flex-col items-end relative">
      <label className="block text-sm font-medium text-gray-700 mb-1">Base Branch</label>
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter branches..."
          className="w-48 px-3 py-1.5 text-sm border border-indigo-500 rounded-t-md font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <div className="absolute right-0 top-full w-48 max-h-60 overflow-y-auto bg-white border border-t-0 border-gray-300 rounded-b-md shadow-lg z-10">
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
