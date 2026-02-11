import React from 'react';
import { Link } from 'react-router-dom';
import { Search } from 'lucide-react';

interface FiltersProps {
  title?: string;
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
  title,
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
  // When title is provided and filters are shown, render as a unified toolbar
  if (title && !hideFilters) {
    return (
      <div className="sticky top-0 z-10 bg-gray-100 border-b border-gray-200 px-4 py-3 mb-0">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          {/* Left side: Page Title */}
          <h1 className="text-xl font-semibold text-gray-900">{title}</h1>

          {/* Right side: Filters */}
          <div className="flex items-center gap-3">
            {/* Search Input */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search tasks..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 pr-3 py-1.5 bg-white border border-gray-300 text-gray-800 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500 text-sm w-48"
              />
            </div>

            {/* Status Filter */}
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="px-3 py-1.5 bg-white border border-gray-300 text-gray-800 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500 cursor-pointer text-sm"
            >
              <option value="all">All Statuses</option>
              <option value="active">Active</option>
              <option value="completed">Completed</option>
              <option value="failed">Failed</option>
              <option value="waiting">Waiting</option>
            </select>

            {/* Repository Filter */}
            <select
              value={repoFilter}
              onChange={(e) => setRepoFilter(e.target.value)}
              disabled={reposLoading}
              className="px-3 py-1.5 bg-white border border-gray-300 text-gray-800 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500 cursor-pointer disabled:opacity-50 text-sm"
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
          </div>
        </div>
      </div>
    );
  }

  // Original layout for cases without title or when filters are hidden
  return (
    <div className="flex justify-between items-center mb-4 flex-wrap gap-4">
      {title && <h3 className="text-lg font-semibold text-gray-900">{title}</h3>}
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
