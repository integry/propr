import React, { useState, useRef, useEffect } from 'react';
import { BookOpen, X, Info, ChevronDown, Check, ChevronRight } from 'lucide-react';
import { ContextRepository } from '../../api/plannerApi';

export interface IndexedRepository {
  full_name: string;
  branch: string;
}

interface ContextRepositoriesSectionProps {
  repositories: ContextRepository[];
  availableRepos: IndexedRepository[];
  onAdd: (repo: ContextRepository) => void;
  onRemove: (repository: string) => void;
  isLoading?: boolean;
}

// Helper to check if branch is a default branch (main, master, HEAD)
const isDefaultBranch = (branch: string): boolean => {
  return ['main', 'master', 'head'].includes(branch.toLowerCase());
};

export const ContextRepositoriesSection: React.FC<ContextRepositoriesSectionProps> = ({
  repositories,
  availableRepos,
  onAdd,
  onRemove,
  isLoading = false
}) => {
  // Section is expanded by default only if repos are already selected
  const [isSectionExpanded, setIsSectionExpanded] = useState(repositories.length > 0);
  const [isOpen, setIsOpen] = useState(false);
  const [filterText, setFilterText] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setFilterText('');
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Focus filter input when dropdown opens
  useEffect(() => {
    if (isOpen && filterInputRef.current) {
      filterInputRef.current.focus();
    }
  }, [isOpen]);

  // Filter repos based on search text
  const filteredRepos = availableRepos.filter(repo =>
    repo.full_name.toLowerCase().includes(filterText.toLowerCase()) ||
    repo.branch.toLowerCase().includes(filterText.toLowerCase())
  );

  const handleToggleRepo = (repo: IndexedRepository) => {
    const isSelected = repositories.some(r => r.repository === repo.full_name);
    if (isSelected) {
      onRemove(repo.full_name);
    } else {
      onAdd({
        repository: repo.full_name,
        branch: repo.branch
      });
    }
  };

  const selectedCount = repositories.length;

  return (
    <div className="space-y-4">
      {/* Collapsible header */}
      <button
        type="button"
        onClick={() => setIsSectionExpanded(!isSectionExpanded)}
        className="flex items-center gap-2 w-full text-left hover:bg-gray-50 rounded-md py-1 -ml-1 pl-1 transition-colors"
      >
        {isSectionExpanded ? (
          <ChevronDown className="w-4 h-4 text-gray-400" />
        ) : (
          <ChevronRight className="w-4 h-4 text-gray-400" />
        )}
        <BookOpen className="w-4 h-4 text-gray-500" />
        <span className="text-sm font-medium text-gray-700">
          Additional Context Repositories
        </span>
        <span className="text-xs text-gray-400">(optional)</span>
        {!isSectionExpanded && repositories.length > 0 && (
          <span className="text-xs text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-full">
            {repositories.length} selected
          </span>
        )}
      </button>

      {/* Collapsible content */}
      {isSectionExpanded && (
        <>
          {/* Info banner */}
          <div className="flex items-start gap-2 p-3 bg-blue-50 border border-blue-200 rounded-lg">
            <Info className="w-4 h-4 text-blue-500 mt-0.5 flex-shrink-0" />
            <p className="text-xs text-blue-700">
              Include indexed repositories as reference context.
              Content from these repos will be used as <strong>reference only</strong> —
              all implementation will be done in the target repository.
            </p>
          </div>

          {/* Multiselect dropdown */}
          <div className="relative" ref={dropdownRef}>
            <button
              type="button"
              onClick={() => setIsOpen(!isOpen)}
              disabled={isLoading || availableRepos.length === 0}
              className="w-full flex items-center justify-between px-3 py-2 text-sm border border-gray-300 rounded-md bg-white hover:bg-gray-50 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 disabled:bg-gray-100 disabled:cursor-not-allowed"
            >
              <span className={selectedCount > 0 ? 'text-gray-900' : 'text-gray-500'}>
                {isLoading ? 'Loading repositories...' :
                 availableRepos.length === 0 ? 'No indexed repositories available' :
                 selectedCount > 0 ? `${selectedCount} repositor${selectedCount === 1 ? 'y' : 'ies'} selected` :
                 'Select repositories...'}
              </span>
              <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
            </button>

            {/* Dropdown menu */}
            {isOpen && availableRepos.length > 0 && (
              <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-md shadow-lg">
                {/* Search filter input */}
                <div className="p-2 border-b border-gray-200">
                  <input
                    ref={filterInputRef}
                    type="text"
                    value={filterText}
                    onChange={(e) => setFilterText(e.target.value)}
                    placeholder="Filter repositories..."
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
                  />
                </div>
                {/* Repository list */}
                <div className="max-h-80 overflow-auto">
                  {filteredRepos.length === 0 ? (
                    <div className="px-3 py-2 text-sm text-gray-500">
                      No repositories match your filter
                    </div>
                  ) : (
                    filteredRepos.map((repo) => {
                      const isSelected = repositories.some(r => r.repository === repo.full_name);
                      const showBranch = !isDefaultBranch(repo.branch);
                      return (
                        <button
                          key={`${repo.full_name}:${repo.branch}`}
                          type="button"
                          onClick={() => handleToggleRepo(repo)}
                          className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-gray-50 ${
                            isSelected ? 'bg-indigo-50' : ''
                          }`}
                        >
                          <div className={`w-4 h-4 flex-shrink-0 flex items-center justify-center rounded border ${
                            isSelected ? 'bg-indigo-600 border-indigo-600' : 'border-gray-300'
                          }`}>
                            {isSelected && <Check className="w-3 h-3 text-white" />}
                          </div>
                          <span className="font-mono text-gray-900 truncate">
                            {repo.full_name}
                          </span>
                          {showBranch && (
                            <span className="text-xs text-gray-500 flex-shrink-0">
                              @{repo.branch}
                            </span>
                          )}
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Selected repositories chips */}
          {repositories.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {repositories.map((repo) => {
                const showBranch = repo.branch && !isDefaultBranch(repo.branch);
                return (
                  <div
                    key={repo.repository}
                    className="inline-flex items-center gap-2 px-3 py-1.5 bg-indigo-50 border border-indigo-200 rounded-full text-sm"
                  >
                    <BookOpen className="w-3 h-3 text-indigo-500" />
                    <span className="font-mono text-indigo-700">
                      {repo.repository}
                      {showBranch && (
                        <span className="text-indigo-500 ml-1">@{repo.branch}</span>
                      )}
                    </span>
                    <button
                      onClick={() => onRemove(repo.repository)}
                      className="p-0.5 text-indigo-400 hover:text-red-500 hover:bg-red-50 rounded-full"
                      title="Remove"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default ContextRepositoriesSection;
