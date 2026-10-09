import React from 'react';
import { Link } from 'react-router-dom';
import { Users } from 'lucide-react';
import { RepositorySelector, type RepoOption } from '../RepositorySelector';
import { useDecoratedRepoOptions } from '../../hooks/useDecoratedRepoOptions';
import { useIsMobile } from '../../hooks/useIsMobile';
import { ListSearchInput } from '../ListSearchInput';
import './task-queue.css';

/** One person the assignee filter can narrow the list to. */
export interface AssigneeOption {
  /** The `?assignee=` value that selects them. */
  value: string;
  login: string;
}

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
  /** `all`, `me`, `unassigned`, or one person's `AssigneeOption.value`. */
  assigneeFilter: string;
  setAssigneeFilter: (assignee: string) => void;
  /** The people the filter lists; empty without a signed-in user. */
  assigneeOptions: AssigneeOption[];
  /** Whether a user is signed in, so `Assigned to me` has someone to mean. */
  canFilterToMe: boolean;
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
    className="task-repo-filter flex-1 min-w-0 sm:flex-initial sm:w-[320px]"
  />
  );
};

const SELECT_CLASSES = 'py-2 border border-gray-300 rounded-md text-sm bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500';

/**
 * Whose tasks the list shows: everyone's, the signed-in user's, nobody's, or
 * one person's. The people are those assigned on the page plus the signed-in
 * user, so the list never offers a name that matches nothing in view. A value
 * the options do not hold (a login typed into the URL) still gets its own
 * option, so the select names what is applied instead of falling back to
 * `All assignees`. In a toolbar too narrow for it, the select collapses to an
 * icon, beside the repository picker collapsed the same way (see
 * `task-queue.css`).
 */
const AssigneeFilter: React.FC<Pick<FiltersProps, 'assigneeFilter' | 'setAssigneeFilter' | 'assigneeOptions' | 'canFilterToMe'> & {
  className?: string;
  /** Phone sizing, matching the search field beside it: a 16px font and a 40px target. */
  touch?: boolean;
}> = ({
  assigneeFilter,
  setAssigneeFilter,
  assigneeOptions,
  canFilterToMe,
  className = '',
  touch = false,
}) => {
  // `?assignee=me` from the URL keeps its own label even when nobody is signed in to mean.
  const showMe = canFilterToMe || assigneeFilter === 'me';
  const known = ['all', 'unassigned', 'me'].includes(assigneeFilter) || assigneeOptions.some(option => option.value === assigneeFilter);
  const people = known ? assigneeOptions : [...assigneeOptions, { value: assigneeFilter, login: assigneeFilter.replace(/^@/, '') }];
  const active = assigneeFilter !== 'all';
  return (
    <span className={`task-assignee-filter relative flex ${className}`}>
      <select
        data-testid="task-assignee-filter"
        value={assigneeFilter}
        onChange={(e) => setAssigneeFilter(e.target.value)}
        aria-label="Assignee"
        className={`${SELECT_CLASSES} min-w-0 flex-1 px-2 sm:px-3${touch ? ' h-10 text-base' : ''}`}
      >
        <option value="all">All assignees</option>
        {showMe && <option value="me">Assigned to me</option>}
        <option value="unassigned">Unassigned</option>
        {people.length > 0 && (
          <optgroup label="People">
            {people.map(option => <option key={option.value} value={option.value}>@{option.login}</option>)}
          </optgroup>
        )}
      </select>
      <Users
        aria-hidden="true"
        className={`task-assignee-filter-icon pointer-events-none absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 ${active ? 'text-teal-600' : 'text-gray-500'}`}
      />
    </span>
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
  setSearchQuery,
  assigneeFilter,
  setAssigneeFilter,
  assigneeOptions,
  canFilterToMe,
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
  const assigneeProps = { assigneeFilter, setAssigneeFilter, assigneeOptions, canFilterToMe };

  // A phone fits the title and both dropdowns on one line once the repository
  // picker drops its task count there (the open list still shows it). The
  // picker takes whatever the title and status filter leave. The assignee
  // filter joins them inline only where there is room; a phone puts it on
  // the search row instead.
  const header = (
    <div className={`${hideFilters ? '' : 'task-filters '}flex items-center justify-between gap-2 sm:gap-4`}>
      {!hideFilters && <h1 className="text-lg sm:text-2xl font-bold text-gray-800 flex-shrink-0">Tasks</h1>}
      <div className="task-filter-controls flex items-center gap-2 sm:gap-4 flex-1 min-w-0 justify-end">
        {!hideFilters && (
          <>
            {/* Takes the room the filters leave, and keeps enough of it that the repository picker gives way first in a list pane beside an open task. */}
            {!isMobile && (
              <ListSearchInput
                value={searchQuery}
                onChange={setSearchQuery}
                onClear={() => setSearchQuery('')}
                label="Search tasks"
                className="task-search hidden sm:block min-w-[13rem] flex-1 max-w-xs"
              />
            )}
            <div className="flex items-center gap-2 min-w-0 max-sm:flex-1">
              <div data-testid="task-status-filter" className="flex-none">
                <select
                  value={selectedFilter}
                  onChange={(e) => setFilter(e.target.value)}
                  aria-label="Task status"
                  className={`w-[120px] sm:w-auto px-2 sm:px-3 ${SELECT_CLASSES}`}
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

              {/* Gives way before the search does, so a list pane beside an open task still fits. */}
              {!isMobile && <AssigneeFilter {...assigneeProps} className="min-w-0 max-w-[10rem] flex-initial" />}
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
  // row under them, shared with the assignee filter rather than adding a
  // fourth control to the line above.
  if (hideFilters || !isMobile) return header;
  return (
    <div className="flex flex-col gap-2">
      {header}
      <div className="flex min-w-0 items-center gap-2 sm:hidden">
        <ListSearchInput
          value={searchQuery}
          onChange={setSearchQuery}
          onClear={() => setSearchQuery('')}
          label="Search tasks"
          className="min-w-0 flex-1"
          touch
        />
        <AssigneeFilter {...assigneeProps} className="w-[9.5rem] flex-none" touch />
      </div>
    </div>
  );
};
