import React from 'react';
import { Link } from 'react-router-dom';
import { Filter } from 'lucide-react';

interface FiltersProps {
  hideFilters?: boolean;
  showViewAll?: boolean;
  filter: string;
  setFilter: (filter: string) => void;
  repoFilter: string;
  setRepoFilter: (repo: string) => void;
  availableRepos: string[];
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

              {/* Repository filter - only show if multiple repos */}
              {availableRepos.length > 2 && (
                <select
                  value={repoFilter}
                  onChange={(e) => setRepoFilter(e.target.value)}
                  disabled={reposLoading}
                  className="px-2 sm:px-3 py-1.5 sm:py-2 border border-gray-300 rounded-md text-sm bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500 disabled:opacity-50 max-w-[120px] sm:max-w-none truncate"
                >
                  {reposLoading ? (
                    <option value="all">Loading...</option>
                  ) : (
                    availableRepos.map(repo => (
                      <option key={repo} value={repo}>
                        {repo === 'all' ? 'All Repos' : repo}
                      </option>
                    ))
                  )}
                </select>
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
