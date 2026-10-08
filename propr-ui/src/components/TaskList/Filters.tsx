import React from 'react';
import { Link } from 'react-router-dom';
import { RepositorySelector, type RepoOption } from '../RepositorySelector';
import { useDecoratedRepoOptions } from '../../hooks/useDecoratedRepoOptions';
import { useIsMobile } from '../../hooks/useIsMobile';
import { ListSearchInput } from '../ListSearchInput';

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

const normalizeFilterValue = (filter: string): string => {
  switch (filter) {
    case 'implementing':
      return 'active';
    case 'pending':
      return 'waiting';
    default:
      return filter;
  }
};

const RepoFilter: React.FC<Pick<FiltersProps, 'repoFilter' | 'setRepoFilter' | 'availableRepos' | 'reposLoading'>> = ({
  repoFilter,
  setRepoFilter,
  availableRepos,
  reposLoading
}) => {
  const repos = useDecoratedRepoOptions(availableRepos);
  return (
  <RepositorySelector
    repos={repos}
    selectedRepo={repoFilter}
    onRepoChange={setRepoFilter}
    isLoading={reposLoading}
    variant="default"
    labelLayout="stacked"
    hideCountOnMobile
    className="flex-1 min-w-0 sm:flex-initial sm:w-[320px]"
  />
  );
};

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
  const isMobile = useIsMobile();

  // Don't render anything if filters are hidden and no View All link
  if (hideFilters && !showViewAll) {
    return null;
  }

  // The dropdown exposes lifecycle labels ("Active", "Waiting") while URLs and
  // callers may carry the worker-facing aliases, so collapse them onto the
  // option values to keep the select bound instead of falling back to "all".
  const selectedFilter = normalizeFilterValue(filter);

  const showRepoFilter = reposLoading || availableRepos.length > 1;

  // A phone fits the title and both dropdowns on one line once the repository
  // picker drops its task count there (the open list still shows it). The
  // picker takes whatever the title and status filter leave.
  const header = (
    <div className="flex items-center justify-between gap-2 sm:gap-4">
      {!hideFilters && <h1 className="text-lg sm:text-2xl font-bold text-gray-800 flex-shrink-0">Tasks</h1>}
      <div className="flex items-center gap-2 sm:gap-4 flex-1 min-w-0 justify-end">
        {!hideFilters && (
          <>
            {/* Takes the room the filters leave, and keeps enough of it that the repository picker gives way first in a list pane beside an open task. */}
            {!isMobile && (
              <ListSearchInput
                value={searchQuery}
                onChange={setSearchQuery}
                onClear={() => setSearchQuery('')}
                label="Search tasks"
                className="hidden sm:block min-w-[13rem] flex-1 max-w-xs"
              />
            )}
            <div className="flex items-center gap-2 min-w-0 max-sm:flex-1">
              <div data-testid="task-status-filter" className="flex-none">
                <select
                  value={selectedFilter}
                  onChange={(e) => setFilter(e.target.value)}
                  aria-label="Task status"
                  className="w-[120px] sm:w-auto px-2 sm:px-3 py-2 border border-gray-300 rounded-md text-sm bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
                >
                  <option value="all">All Tasks</option>
                  <option value="attention">Needs attention</option>
                  <option value="active">Active</option>
                  <option value="completed">Completed</option>
                  <option value="failed">Failed</option>
                  <option value="waiting">Waiting</option>
                </select>
              </div>

              {/* Repository filter - only show if multiple repos (more than just "All Repos") */}
              {showRepoFilter && (
                <RepoFilter repoFilter={repoFilter} setRepoFilter={setRepoFilter} availableRepos={availableRepos} reposLoading={reposLoading} />
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

  // A phone has no room for search beside the filters, so it takes its own
  // full-width row under them.
  if (hideFilters || !isMobile) return header;
  return (
    <div className="flex flex-col gap-2">
      {header}
      <ListSearchInput
        value={searchQuery}
        onChange={setSearchQuery}
        onClear={() => setSearchQuery('')}
        label="Search tasks"
        className="sm:hidden"
        touch
      />
    </div>
  );
};
