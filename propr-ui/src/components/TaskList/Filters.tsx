import React from 'react';
import { Link } from 'react-router-dom';
import { Filter, Search, X } from 'lucide-react';
import { RepositorySelector, type RepoOption } from '../RepositorySelector';

interface FiltersProps {
  hideFilters?: boolean;
  showViewAll?: boolean;
  filter: string;
  setFilter: (filter: string) => void;
  repoFilter: string;
  setRepoFilter: (repo: string) => void;
  availableRepos: RepoOption[];
  reposLoading: boolean;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
}

export const Filters: React.FC<FiltersProps> = ({
  hideFilters,
  showViewAll,
  filter,
  setFilter,
  repoFilter,
  setRepoFilter,
  availableRepos,
  reposLoading,
  searchQuery,
  setSearchQuery
}) => {
  // Don't render anything if filters are hidden and no View All link
  if (hideFilters && !showViewAll) {
    return null;
  }

  return (
    <div className="flex items-center justify-between gap-2 sm:gap-4">
      {!hideFilters && <h1 className="text-lg sm:text-2xl font-bold text-gray-800 flex-shrink-0">Tasks</h1>}
      <div className="flex items-center gap-2 sm:gap-4 flex-1 justify-end">
        {!hideFilters && (
          <>
            {/* Search input - hidden on mobile, shown on desktop */}
            <div className="relative hidden sm:block">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search tasks..."
                className="pl-9 pr-8 py-2 w-64 border border-gray-300 rounded-md text-sm bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  title="Clear search"
                >
                  <X size={16} />
                </button>
              )}
            </div>
            {/* Filters row - inline on all screen sizes */}
            <div className="flex items-center gap-2">
              <Filter size={16} className="text-gray-500 hidden sm:block" />
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="px-2 sm:px-3 py-1.5 sm:py-2 border border-gray-300 rounded-md text-sm bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
              >
                <option value="all">All Tasks</option>
                <option value="active">Active</option>
                <option value="completed">Completed</option>
                <option value="failed">Failed</option>
                <option value="waiting">Waiting</option>
              </select>

              {/* Repository filter - only show if multiple repos (more than just "All Repos") */}
              {availableRepos.length > 1 && (
                <RepositorySelector
                  repos={availableRepos}
                  selectedRepo={repoFilter}
                  onRepoChange={setRepoFilter}
                  variant="default"
                  className="w-[160px] sm:w-[220px]"
                />
              )}
            </div>
          </>
        )}
        {showViewAll && (
          <Link to="/tasks" className="text-primary-600 hover:text-primary-700 transition-colors text-sm font-medium">
            View All Tasks
          </Link>
        )}
      </div>
    </div>
  );
};
