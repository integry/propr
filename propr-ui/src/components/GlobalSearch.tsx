import React, { useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, X, ScrollText, ListTodo, GitBranch, Loader2, ChevronRight } from 'lucide-react';
import { useGlobalSearch, TaskSearchResult } from '../hooks/useGlobalSearch';
import { DraftListItem } from '../api/plannerApi';
import { MonitoredRepo } from '../api/proprApi';

// Utility function for formatting time ago
const formatTimeAgo = (dateString: string): string => {
  const diffMins = Math.floor((Date.now() - new Date(dateString).getTime()) / 60000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
};

// Get status badge styling
const getStatusBadgeStyle = (status: string): string => {
  switch (status) {
    case 'completed':
      return 'bg-green-100 text-green-700';
    case 'failed':
      return 'bg-red-100 text-red-700';
    case 'running':
    case 'processing':
      return 'bg-blue-100 text-blue-700';
    case 'pending':
    case 'queued':
      return 'bg-yellow-100 text-yellow-700';
    case 'review':
      return 'bg-purple-100 text-purple-700';
    case 'draft':
      return 'bg-slate-100 text-slate-700';
    case 'generating':
    case 'refining':
      return 'bg-indigo-100 text-indigo-700';
    case 'executed':
      return 'bg-teal-100 text-teal-700';
    case 'merged':
      return 'bg-green-100 text-green-700';
    case 'approved':
      return 'bg-emerald-100 text-emerald-700';
    default:
      return 'bg-slate-100 text-slate-600';
  }
};

// Extract repo name from full path
const getRepoName = (repository: string): string => {
  const parts = repository.split('/');
  return parts.length > 1 ? parts[1] : repository;
};

interface GlobalSearchProps {
  inputRef?: React.RefObject<HTMLInputElement | null>;
}

type SearchResultState = 'loading' | 'error' | 'empty' | 'results' | 'idle';

function getSearchResultState(
  isLoading: boolean,
  error: string | null,
  query: string,
  hasResults: boolean,
): SearchResultState {
  if (isLoading && !hasResults) return 'loading';
  if (!isLoading && error) return 'error';
  if (!isLoading && query.trim() && !hasResults) return 'empty';
  return hasResults ? 'results' : 'idle';
}

const GlobalSearch: React.FC<GlobalSearchProps> = ({ inputRef: externalInputRef }) => {
  const navigate = useNavigate();
  const internalInputRef = useRef<HTMLInputElement>(null);
  const inputRef = externalInputRef || internalInputRef;
  const dropdownRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const {
    query,
    results,
    isLoading,
    isOpen,
    error,
    hasResults,
    setQuery,
    clearSearch,
    setIsOpen,
  } = useGlobalSearch();

  // Handle click outside to close dropdown
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen, setIsOpen]);

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
        inputRef.current?.blur();
      } else if (e.key === 'Enter' && query.trim()) {
        // Navigate to tasks page with search query on Enter
        navigate(`/tasks?search=${encodeURIComponent(query.trim())}`);
        clearSearch();
      }
    },
    [query, navigate, clearSearch, setIsOpen, inputRef]
  );

  // Handle input focus
  const handleFocus = () => {
    if (query.trim()) {
      setIsOpen(true);
    }
  };

  // Navigation handlers
  const handlePlanClick = (plan: DraftListItem) => {
    navigate(`/studio/${plan.draft_id}`);
    clearSearch();
  };

  const handleTaskClick = (task: TaskSearchResult) => {
    navigate(`/tasks/${task.id}`);
    clearSearch();
  };

  const handleRepositoryClick = (repo: MonitoredRepo) => {
    navigate(`/tasks?repository=${encodeURIComponent(repo.name)}`);
    clearSearch();
  };

  const handleViewAllPlans = () => {
    navigate(`/plans?search=${encodeURIComponent(query.trim())}`);
    clearSearch();
  };

  const handleViewAllTasks = () => {
    navigate(`/tasks?search=${encodeURIComponent(query.trim())}`);
    clearSearch();
  };

  // Should show dropdown
  const showDropdown = isOpen && (hasResults || isLoading || query.trim());
  const resultState = getSearchResultState(isLoading, error, query, hasResults);

  return (
    <div ref={containerRef} className="relative w-full max-w-md">
      {/* Search Input */}
      <div className="relative">
        <Search className="absolute left-3 sm:left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={handleFocus}
          aria-label="Search"
          placeholder="Search..."
          className="w-full rounded-lg border-0 bg-slate-100 py-1.5 pl-9 pr-14 text-sm text-gray-900 shadow-inner placeholder-gray-400 transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500 sm:py-2 sm:pl-12 sm:pr-16"
        />
        {/* Clear button or loading indicator */}
        {query && (
          <button
            onClick={clearSearch}
            className="absolute right-2 sm:right-3 top-1/2 -translate-y-1/2 p-1 hover:bg-gray-200 rounded transition-colors"
          >
            {isLoading ? (
              <Loader2 className="w-4 h-4 text-gray-400 animate-spin" />
            ) : (
              <X className="w-4 h-4 text-gray-400" />
            )}
          </button>
        )}
        {!query && (
          <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-medium text-slate-400 sm:right-3">
            ⌘K
          </kbd>
        )}
      </div>

      {/* Results Dropdown */}
      {showDropdown && (
        <div
          ref={dropdownRef}
          className="desktop-toolbar-popover absolute left-0 right-0 top-full z-50 mt-1 max-h-[480px] overflow-y-auto border border-slate-200 bg-white shadow-xl ring-1 ring-black/5"
        >
          {/* Loading state */}
          {resultState === 'loading' && (
            <div className="px-4 py-8 text-center">
              <Loader2 className="w-6 h-6 text-slate-400 animate-spin mx-auto mb-2" />
              <p className="text-sm text-slate-500">Searching...</p>
            </div>
          )}

          {resultState === 'error' && (
            <div role="alert" className="px-4 py-8 text-center">
              <p className="text-sm font-medium text-red-700">Couldn’t search</p>
              <p className="mt-1 text-xs text-red-600">{error}</p>
            </div>
          )}

          {/* No results state */}
          {resultState === 'empty' && (
            <div className="px-4 py-8 text-center">
              <Search className="w-6 h-6 text-slate-300 mx-auto mb-2" />
              <p className="text-sm text-slate-500">No results found for "{query}"</p>
              <button
                onClick={handleViewAllTasks}
                className="mt-3 text-xs text-primary-600 hover:text-primary-700 transition-colors"
              >
                Search all tasks
              </button>
            </div>
          )}

          {/* Results sections */}
          {hasResults && (
            <>
              {/* Repositories Section */}
              {results.repositories.length > 0 && (
                <div className="border-b border-slate-100">
                  <div className="px-4 py-2 bg-slate-50 flex items-center">
                    <div className="flex items-center gap-2">
                      <GitBranch className="w-3.5 h-3.5 text-slate-400" />
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                        Repositories
                      </span>
                      <span className="text-[10px] text-slate-400">
                        ({results.repositories.length})
                      </span>
                    </div>
                  </div>
                  {results.repositories.map((repo) => (
                    <div
                      key={repo.id}
                      onClick={() => handleRepositoryClick(repo)}
                      className="px-4 py-2.5 hover:bg-slate-50 cursor-pointer transition-colors group"
                    >
                      <div className="flex items-center gap-2">
                        <GitBranch className="w-4 h-4 text-slate-400 flex-shrink-0" />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-slate-900 truncate group-hover:text-primary-600">
                            {repo.name}
                          </p>
                          {repo.alias && (
                            <p className="text-xs text-slate-400 truncate">
                              {repo.alias}
                            </p>
                          )}
                        </div>
                        <ChevronRight className="w-4 h-4 text-slate-300 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Plans Section */}
              {results.plans.length > 0 && (
                <div className="border-b border-slate-100">
                  <div className="px-4 py-2 bg-slate-50 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <ScrollText className="w-3.5 h-3.5 text-slate-400" />
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                        Plans
                      </span>
                      <span className="text-[10px] text-slate-400">
                        ({results.plans.length})
                      </span>
                    </div>
                    <button
                      onClick={handleViewAllPlans}
                      className="text-[10px] text-slate-400 hover:text-primary-600 transition-colors flex items-center gap-0.5"
                    >
                      View All <ChevronRight className="w-3 h-3" />
                    </button>
                  </div>
                  {results.plans.map((plan) => (
                    <div
                      key={plan.draft_id}
                      onClick={() => handlePlanClick(plan)}
                      className="px-4 py-2.5 hover:bg-slate-50 cursor-pointer transition-colors group"
                    >
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-xs text-slate-500">
                          {getRepoName(plan.repository)}
                        </span>
                        <span className="text-slate-300">·</span>
                        <span
                          className={`px-1.5 py-0.5 text-xs font-mono ${getStatusBadgeStyle(
                            plan.status
                          )}`}
                        >
                          {plan.status}
                        </span>
                        <span className="text-xs text-slate-400 ml-auto">
                          {formatTimeAgo(plan.updated_at || plan.created_at)}
                        </span>
                      </div>
                      <p className="text-sm font-medium text-slate-900 truncate group-hover:text-primary-600">
                        {plan.name || plan.initial_prompt}
                      </p>
                    </div>
                  ))}
                </div>
              )}

              {/* Tasks Section */}
              {results.tasks.length > 0 && (
                <div className="border-b border-slate-100">
                  <div className="px-4 py-2 bg-slate-50 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <ListTodo className="w-3.5 h-3.5 text-slate-400" />
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                        Tasks
                      </span>
                      <span className="text-[10px] text-slate-400">
                        ({results.tasks.length})
                      </span>
                    </div>
                    <button
                      onClick={handleViewAllTasks}
                      className="text-[10px] text-slate-400 hover:text-primary-600 transition-colors flex items-center gap-0.5"
                    >
                      View All <ChevronRight className="w-3 h-3" />
                    </button>
                  </div>
                  {results.tasks.map((task) => (
                    <div
                      key={task.id}
                      onClick={() => handleTaskClick(task)}
                      className="px-4 py-2.5 hover:bg-slate-50 cursor-pointer transition-colors group"
                    >
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-xs text-slate-500">
                          {task.repository ? getRepoName(task.repository) : 'Unknown'}
                        </span>
                        <span className="text-slate-300">·</span>
                        <span
                          className={`px-1.5 py-0.5 text-xs font-mono ${getStatusBadgeStyle(
                            task.status
                          )}`}
                        >
                          {task.status}
                        </span>
                        <span className="text-xs text-slate-400 ml-auto">
                          {formatTimeAgo(task.createdAt)}
                        </span>
                      </div>
                      <p className="text-sm font-medium text-slate-900 truncate group-hover:text-primary-600">
                        {task.title || `Task ${task.id.slice(0, 8)}...`}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {/* Keyboard hints */}
          {hasResults && (
            <div className="px-4 py-2 bg-slate-50 border-t border-slate-100">
              <p className="text-[10px] text-slate-400">
                Press <kbd className="px-1 py-0.5 bg-slate-200 rounded text-slate-600">Enter</kbd> to search all tasks
                {' '}· <kbd className="px-1 py-0.5 bg-slate-200 rounded text-slate-600">Esc</kbd> to close
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default GlobalSearch;
