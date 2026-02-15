import React from 'react';
import { Link } from 'react-router-dom';

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
    <div className="flex justify-between items-center mb-4 flex-wrap gap-4">
      {!hideFilters && <h3 className="text-lg font-semibold text-gray-900">Tasks</h3>}
      <div className="flex items-center gap-4">
        {!hideFilters && (
          <>
            <input
              type="text"
              placeholder="Search tasks..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="px-3 py-2 bg-gray-50 border border-gray-300 text-gray-800 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500 text-sm w-48"
            />

            <select
              value={repoFilter}
              onChange={(e) => setRepoFilter(e.target.value)}
              disabled={reposLoading}
              className="px-3 py-2 bg-gray-50 border border-gray-300 text-gray-800 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500 cursor-pointer disabled:opacity-50 text-sm"
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

            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="px-3 py-2 bg-gray-50 border border-gray-300 text-gray-800 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500 cursor-pointer text-sm"
            >
              <option value="all">All Tasks</option>
              <option value="active">Active</option>
              <option value="completed">Completed</option>
              <option value="failed">Failed</option>
              <option value="waiting">Waiting</option>
            </select>
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
