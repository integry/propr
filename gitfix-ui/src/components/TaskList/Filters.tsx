import React from 'react';
import { Link } from 'react-router-dom';
import { Search, Filter, X } from 'lucide-react';

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

  const handleSearchClear = () => {
    setSearchQuery('');
  };

  return (
    <div className="flex justify-between items-center flex-wrap gap-4">
      {!hideFilters && <h1 className="text-2xl font-bold text-gray-800">Tasks</h1>}
      <div className="flex items-center gap-4">
        {!hideFilters && (
          <>
            {/* Search input with icon and clear button */}
            <div className="relative">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                placeholder="Search tasks..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 pr-8 py-2 w-64 border border-gray-300 rounded-md text-sm bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
              />
              {searchQuery && (
                <button
                  onClick={handleSearchClear}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  title="Clear search"
                >
                  <X size={16} />
                </button>
              )}
            </div>

            {/* Status filter with icon */}
            <div className="flex items-center gap-2">
              <Filter size={16} className="text-gray-500" />
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="px-3 py-2 border border-gray-300 rounded-md text-sm bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
              >
                <option value="all">All Tasks</option>
                <option value="active">Active</option>
                <option value="completed">Completed</option>
                <option value="failed">Failed</option>
                <option value="waiting">Waiting</option>
              </select>
            </div>

            {/* Repository filter - only show if multiple repos */}
            {availableRepos.length > 2 && (
              <select
                value={repoFilter}
                onChange={(e) => setRepoFilter(e.target.value)}
                disabled={reposLoading}
                className="px-3 py-2 border border-gray-300 rounded-md text-sm bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500 disabled:opacity-50"
              >
                {reposLoading ? (
                  <option value="all">Loading repos...</option>
                ) : (
                  availableRepos.map(repo => (
                    <option key={repo} value={repo}>
                      {repo === 'all' ? 'All Repositories' : repo}
                    </option>
                  ))
                )}
              </select>
            )}
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
