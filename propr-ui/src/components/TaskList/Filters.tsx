import React, { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Search, X } from 'lucide-react';
import { RepositorySelector, type RepoOption } from '../RepositorySelector';
import { useDecoratedRepoOptions } from '../../hooks/useDecoratedRepoOptions';

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

/**
 * Every repository on this instance shares an owner, so the trigger shows
 * `propr` rather than `integry/propr`; the full name stays in the row tooltip
 * and the search. A name two owners share keeps its owner.
 */
const withShortNames = (repos: RepoOption[]): RepoOption[] => {
  const shortName = (name: string) => name.split('/')[1] ?? name;
  const seen = new Map<string, number>();
  for (const repo of repos) seen.set(shortName(repo.name), (seen.get(shortName(repo.name)) ?? 0) + 1);
  return repos.map(repo => (
    repo.displayName || !repo.name.includes('/') || seen.get(shortName(repo.name))! > 1
      ? repo
      : { ...repo, displayName: shortName(repo.name) }
  ));
};

const RepoFilter: React.FC<Pick<FiltersProps, 'repoFilter' | 'setRepoFilter' | 'availableRepos' | 'reposLoading'>> = ({
  repoFilter,
  setRepoFilter,
  availableRepos,
  reposLoading
}) => {
  const decorated = useDecoratedRepoOptions(availableRepos);
  const repos = useMemo(() => withShortNames(decorated), [decorated]);
  return (
  <RepositorySelector
    repos={repos}
    selectedRepo={repoFilter}
    onRepoChange={setRepoFilter}
    isLoading={reposLoading}
    variant="default"
    className="flex-1 min-w-0 max-w-[220px] sm:flex-initial sm:max-w-[13rem]"
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
  // Don't render anything if filters are hidden and no View All link
  if (hideFilters && !showViewAll) {
    return null;
  }

  // The dropdown exposes lifecycle labels ("Active", "Waiting") while URLs and
  // callers may carry the worker-facing aliases, so collapse them onto the
  // option values to keep the select bound instead of falling back to "all".
  const selectedFilter = normalizeFilterValue(filter);

  return (
    <div className="flex items-center justify-between gap-2 sm:gap-4">
      {!hideFilters && <h1 className="text-lg sm:text-2xl font-bold text-gray-800 flex-shrink-0">Tasks</h1>}
      <div className="flex items-center gap-2 sm:gap-4 flex-1 min-w-0 justify-end">
        {!hideFilters && (
          <>
            {/* Search input - hidden on mobile, shown on desktop */}
            {/* Takes the room the filters leave, so it stays usable in a list pane beside an open task. */}
            <div className="relative hidden sm:block min-w-[8rem] flex-1 max-w-xs">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search tasks..."
                className="pl-9 pr-8 py-2 w-full border border-gray-300 rounded-md text-sm bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
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
            <div className="flex items-center gap-2 min-w-0">
              <select
                value={selectedFilter}
                onChange={(e) => setFilter(e.target.value)}
                className="w-[120px] sm:w-auto px-2 sm:px-3 py-1.5 sm:py-2 border border-gray-300 rounded-md text-sm bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
              >
                <option value="all">All Tasks</option>
                <option value="attention">Needs attention</option>
                <option value="active">Active</option>
                <option value="completed">Completed</option>
                <option value="failed">Failed</option>
                <option value="waiting">Waiting</option>
              </select>

              {/* Repository filter - only show if multiple repos (more than just "All Repos") */}
              {(reposLoading || availableRepos.length > 1) && (
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
};
