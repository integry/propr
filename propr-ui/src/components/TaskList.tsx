import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Inbox } from 'lucide-react';
import { getTasks, getRepositoryStats } from '../api/proprApi';
import { useSocket } from '../contexts/useSocket';
import type { RepoOption } from './RepositorySelector';
import type { Task, TaskGroup, TaskListProps } from './TaskList/types';
import { Filters } from './TaskList/Filters';
import { Pagination } from './TaskList/Pagination';
import {
  DashboardLoadingState,
  FullPageLoadingState,
  DashboardErrorState,
  FullPageErrorState,
  TaskTableContent,
} from './TaskList/StateComponents';
import {
  createToggleGroupHandler,
  isDefaultParamValue,
  createFilterSetter,
  groupTasksForDisplay,
  selectValue,
} from './TaskList/utils';
import { useDebouncedCallback } from './TaskList/hooks';
import { isDialogOpen, isTypingTarget } from './TaskList/keyboardOwnership';
import { useLiveRefreshScheduler } from '../hooks/useLiveRefreshScheduler';
import { formatTaskAssignmentFilter, type TaskUpdatePayload } from '@propr/shared';
import { useCurrentUser } from '../contexts/AuthContext';
import type { AssigneeOption } from './TaskList/Filters';

const createRepoOptions = (repositories: Array<{ repository: string; total: number }>): RepoOption[] => {
  const totalCount = repositories.reduce((sum, repo) => sum + repo.total, 0);

  const allOption: RepoOption = {
    name: 'all',
    enabled: true,
    displayName: 'All Repos',
    count: totalCount,
  };

  const repoOptions: RepoOption[] = [...repositories]
    .sort((a, b) => a.repository.localeCompare(b.repository))
    .map(repo => ({
      name: repo.repository,
      enabled: true,
      count: repo.total,
    }));

  return [allOption, ...repoOptions];
};

/**
 * A person's `?assignee=` value. A login the URL would drop as a default (a
 * user named `1`) keeps an `@` prefix, which the API strips, so it survives.
 */
const assigneeOption = (login: string): AssigneeOption => {
  const value = formatTaskAssignmentFilter({ mode: 'users', logins: [login] });
  return { value: isDefaultParamValue(value) ? `@${value}` : value, login };
};

/**
 * The people the assignee filter offers: everyone assigned on the page plus
 * the signed-in user, sorted by login. Without a signed-in user the filter
 * offers only `All assignees` and `Unassigned`.
 */
function deriveAssigneeOptions(tasks: Task[], currentLogin: string | null): AssigneeOption[] {
  if (!currentLogin) return [];
  const logins = new Map<string, string>([[currentLogin.toLowerCase(), currentLogin]]);
  for (const task of tasks) {
    for (const user of task.assignees ?? []) {
      if (!logins.has(user.login.toLowerCase())) logins.set(user.login.toLowerCase(), user.login);
    }
  }
  return [...logins.values()].sort((a, b) => a.localeCompare(b)).map(assigneeOption);
}

type TaskScopeState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; tasks: Task[]; groups: TaskGroup[]; refreshError: string | null };

function resolveTaskScopeState(
  loadedScope: string | null,
  queryScope: string,
  tasks: Task[],
  groups: TaskGroup[],
  error: { scope: string; message: string } | null,
): TaskScopeState {
  const currentError = error?.scope === queryScope ? error.message : null;
  if (loadedScope !== queryScope) return currentError ? { kind: 'error', message: currentError } : { kind: 'loading' };
  if (currentError && tasks.length === 0) return { kind: 'error', message: currentError };
  return { kind: 'ready', tasks, groups, refreshError: currentError };
}

const TaskBlockingState: React.FC<{
  state: Extract<TaskScopeState, { kind: 'loading' | 'error' }>;
  dashboard: boolean;
}> = ({ state, dashboard }) => {
  if (state.kind === 'loading') return dashboard ? <DashboardLoadingState /> : <FullPageLoadingState />;
  return dashboard ? <DashboardErrorState error={state.message} /> : <FullPageErrorState error={state.message} />;
};

const NEXT_ROW_KEYS = new Set(['j', 'ArrowDown']);
const PREVIOUS_ROW_KEYS = new Set(['k', 'ArrowUp']);

/**
 * j/ArrowDown and k/ArrowUp move the selection to the next or previous row of
 * the page. Only primary rows (each group's newest run) are stops: an earlier
 * run can be opened by clicking it, but stepping skips it.
 */
function useRowKeyboardNavigation(
  groups: TaskGroup[],
  selectedTaskId: string | null | undefined,
  onSelectTask: ((taskId: string) => void) | undefined,
) {
  useEffect(() => {
    if (!onSelectTask || !selectedTaskId || groups.length === 0) return;
    const primaryTaskIds = groups.map(group => group.tasks[0].id);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target) || isDialogOpen()) return;
      const step = NEXT_ROW_KEYS.has(event.key) ? 1 : PREVIOUS_ROW_KEYS.has(event.key) ? -1 : 0;
      if (!step) return;
      // An earlier run steps from its own row; a task not on this page starts at the top or bottom.
      const index = groups.findIndex(group => group.tasks.some(task => task.id === selectedTaskId));
      const next = index === -1
        ? (step > 0 ? 0 : primaryTaskIds.length - 1)
        : Math.min(Math.max(index + step, 0), primaryTaskIds.length - 1);
      event.preventDefault();
      if (primaryTaskIds[next] !== selectedTaskId) onSelectTask(primaryTaskIds[next]);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [groups, selectedTaskId, onSelectTask]);
}

const TaskList: React.FC<TaskListProps> = ({ limit, showViewAll = false, hideFilters = false, selectedTaskId = null, onSelectTask, refreshKey = 0, onGroupsChange }) => {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { onTaskUpdate, isConnected } = useSocket();
  const currentUser = useCurrentUser();

  // Determine whether to use URL-based state (only when filters are shown - Tasks page)
  const useUrlState = !hideFilters;

  // Derive values directly from URL parameters
  const urlFilter = searchParams.get('status') || 'all';
  const urlRepoFilter = searchParams.get('repository') || 'all';
  const urlSearchParam = searchParams.get('search') || '';
  const urlAssigneeFilter = searchParams.get('assignee') || 'all';
  // Note: URL uses 1-based page, internal state uses 0-based
  const urlPage = Math.max(0, parseInt(searchParams.get('page') || '1', 10) - 1);

  // Local state (used when hideFilters is true, e.g., Dashboard)
  const [localFilter, setLocalFilter] = useState<string>('all');
  const [localRepoFilter, setLocalRepoFilter] = useState<string>('all');
  const [localAssigneeFilter, setLocalAssigneeFilter] = useState<string>('all');
  const [localCurrentPage, setLocalCurrentPage] = useState<number>(0);

  // Get the effective filter values based on whether we use URL or local state
  const filter = selectValue(useUrlState, urlFilter, localFilter);
  const repoFilter = selectValue(useUrlState, urlRepoFilter, localRepoFilter);
  const assigneeFilter = selectValue(useUrlState, urlAssigneeFilter, localAssigneeFilter);
  const currentPage = selectValue(useUrlState, urlPage, localCurrentPage);

  // Search state - local input for typing, debounced for API/URL
  const urlSearch = selectValue(useUrlState, urlSearchParam, '');
  const [searchQuery, setSearchQuery] = useState<string>(urlSearch);
  const [debouncedSearch, setDebouncedSearch] = useState<string>(urlSearch);
  const isInitialMount = useRef(true);

  const [tasks, setTasks] = useState<Task[]>([]);
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  const [error, setError] = useState<{ scope: string; message: string } | null>(null);

  const [availableRepos, setAvailableRepos] = useState<RepoOption[]>([]);
  const [reposLoading, setReposLoading] = useState<boolean>(!hideFilters);
  const [totalTasks, setTotalTasks] = useState<number>(0);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const hasLoadedRepoStats = useRef(false);
  const repoStatsRequestId = useRef(0);
  const tasksRequestId = useRef(0);
  const taskEventFingerprintsRef = useRef<Map<string, string>>(new Map());

  const tasksPerPage = limit;
  const queryScope = useMemo(
    () => JSON.stringify([filter, repoFilter, assigneeFilter, currentPage, debouncedSearch, tasksPerPage]),
    [assigneeFilter, currentPage, debouncedSearch, filter, repoFilter, tasksPerPage]
  );

  // Helper to update URL params (only used when useUrlState is true)
  const updateSearchParams = useCallback((updates: Record<string, string | null>) => {
    if (!useUrlState) return;
    setSearchParams(prev => {
      const newParams = new URLSearchParams(prev);
      Object.entries(updates).forEach(([key, value]) => {
        if (isDefaultParamValue(value)) {
          newParams.delete(key);
        } else {
          newParams.set(key, value as string);
        }
      });
      return newParams;
    }, { replace: true });
  }, [useUrlState, setSearchParams]);

  // Unified setters that work with both URL and local state
  const setFilter = useMemo(() => createFilterSetter(
    useUrlState,
    (value) => updateSearchParams({ status: value, page: '1' }),
    setLocalFilter,
    () => setLocalCurrentPage(0)
  ), [useUrlState, updateSearchParams]);

  const setRepoFilter = useMemo(() => createFilterSetter(
    useUrlState,
    (value) => updateSearchParams({ repository: value, page: '1' }),
    setLocalRepoFilter,
    () => setLocalCurrentPage(0)
  ), [useUrlState, updateSearchParams]);

  const setAssigneeFilter = useMemo(() => createFilterSetter(
    useUrlState,
    (value) => updateSearchParams({ assignee: value, page: '1' }),
    setLocalAssigneeFilter,
    () => setLocalCurrentPage(0)
  ), [useUrlState, updateSearchParams]);

  const setCurrentPage = useCallback((pageOrUpdater: number | ((prev: number) => number)) => {
    if (useUrlState) {
      const newPage = typeof pageOrUpdater === 'function' ? pageOrUpdater(urlPage) : pageOrUpdater;
      // Convert 0-based internal page to 1-based URL page
      updateSearchParams({ page: (newPage + 1).toString() });
    } else {
      setLocalCurrentPage(pageOrUpdater);
    }
  }, [useUrlState, updateSearchParams, urlPage]);

  const refreshRepositoryStats = useCallback(async (showLoadingState: boolean) => {
    if (hideFilters) return;

    const requestId = ++repoStatsRequestId.current;
    try {
      if (showLoadingState) setReposLoading(true);
      const data = await getRepositoryStats();
      // Discard stale responses — only apply if this is still the latest request
      if (requestId !== repoStatsRequestId.current) return;
      setAvailableRepos(createRepoOptions(data.repositories || []));
    } catch (err) {
      console.error('Error fetching repositories:', err);
    } finally {
      if (requestId === repoStatsRequestId.current) setReposLoading(false);
    }
  }, [hideFilters]);

  // Sync search input with URL on initial load (only when using URL state)
  useEffect(() => {
    if (useUrlState && isInitialMount.current) {
      isInitialMount.current = false;
      setSearchQuery(urlSearchParam);
      setDebouncedSearch(urlSearchParam);
    }
  }, [useUrlState, urlSearchParam]);

  // Handler for when debounced search value changes
  const handleSearchChange = useMemo(() => createFilterSetter(
    useUrlState,
    (value) => { setDebouncedSearch(value); updateSearchParams({ search: value || null, page: null }); },
    (value) => { setDebouncedSearch(value); },
    () => setLocalCurrentPage(0)
  ), [useUrlState, updateSearchParams]);

  // Debounce search query
  useDebouncedCallback(searchQuery, handleSearchChange, 400);

  // Memoize fetchTasks to allow WebSocket handler to call it
  const fetchTasks = useCallback(async () => {
    const requestId = ++tasksRequestId.current;
    try {
      setError(current => current?.scope === queryScope ? null : current);
      const offset = currentPage * tasksPerPage;
      // A page is whole tasks, each with all of its runs, so the footer counts
      // the rows on screen and a task's runs never split across two pages.
      const data = await getTasks({
        status: filter, limit: tasksPerPage, offset, repository: repoFilter, search: debouncedSearch, groupBy: 'task',
        // `all` stays out of the query, so a server that predates assignment still answers.
        assignee: assigneeFilter === 'all' ? undefined : assigneeFilter,
      });
      if (requestId !== tasksRequestId.current) return;
      setTasks(data.tasks || []);
      setTotalTasks(data.total || 0);
      setLoadedScope(queryScope);
      setError(null);
    } catch (err) {
      if (requestId !== tasksRequestId.current) return;
      setError({ scope: queryScope, message: (err as Error).message });
      console.error('Error fetching tasks:', err);
    }
  }, [filter, tasksPerPage, currentPage, repoFilter, assigneeFilter, debouncedSearch, queryScope]);

  // Refresh repository stats only on initial mount when filters are visible.
  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  const lastRefreshKey = useRef(refreshKey);
  useEffect(() => {
    if (lastRefreshKey.current === refreshKey) return;
    lastRefreshKey.current = refreshKey;
    fetchTasks();
    refreshRepositoryStats(false);
  }, [refreshKey, fetchTasks, refreshRepositoryStats]);

  useEffect(() => {
    if (hideFilters || hasLoadedRepoStats.current) return;
    refreshRepositoryStats(true);
    hasLoadedRepoStats.current = true;
  }, [hideFilters, refreshRepositoryStats]);

  const refreshLiveTasks = useCallback(async () => {
    await Promise.all([
      fetchTasks(),
      refreshRepositoryStats(false),
    ]);
  }, [fetchTasks, refreshRepositoryStats]);
  const scheduleLiveRefresh = useLiveRefreshScheduler({
    isConnected,
    refresh: refreshLiveTasks,
  });

  // Subscribe to WebSocket task updates for real-time refresh
  useEffect(() => {
    if (!isConnected) return;

    const handleTaskUpdate = (payload: TaskUpdatePayload) => {
      const fingerprint = `${payload.state}\0${payload.repository ?? ''}\0${payload.issueNumber ?? ''}`;
      if (taskEventFingerprintsRef.current.get(payload.taskId) === fingerprint) return;
      taskEventFingerprintsRef.current.set(payload.taskId, fingerprint);
      scheduleLiveRefresh();
    };

    const unsubscribe = onTaskUpdate(handleTaskUpdate);
    return () => {
      unsubscribe();
    };
  }, [isConnected, onTaskUpdate, scheduleLiveRefresh]);

  const groupedTasks = useMemo(() => groupTasksForDisplay(tasks), [tasks]);
  const currentLogin = currentUser?.login || null;
  const assigneeOptions = useMemo(() => deriveAssigneeOptions(tasks, currentLogin), [tasks, currentLogin]);

  useEffect(() => {
    onGroupsChange?.(groupedTasks);
  }, [groupedTasks, onGroupsChange]);

  const toggleGroup = useMemo(() => createToggleGroupHandler(setExpandedGroups), []);

  const handleRowClick = useCallback((taskId: string) => {
    if (onSelectTask) onSelectTask(taskId);
    else navigate(`/tasks/${encodeURIComponent(taskId)}`);
  }, [navigate, onSelectTask]);

  useRowKeyboardNavigation(groupedTasks, selectedTaskId, onSelectTask);

  const scopeState = resolveTaskScopeState(loadedScope, queryScope, tasks, groupedTasks, error);

  // Shared filter props
  const filterProps = {
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
    canFilterToMe: Boolean(currentLogin),
  };

  // Anchored Header - compact on mobile. It leads both Tasks page returns
  // below, so React keeps the same nodes (and the focused search field, with
  // its phone keyboard) across each debounced reload.
  const pageHeader = (
    <div className="flex-shrink-0 bg-slate-50 border-b border-gray-200 px-4 sm:px-6 py-2 sm:py-4">
      <Filters {...filterProps} />
    </div>
  );

  // A scope that has not completed successfully is loading even during the
  // render before its effect starts. This prevents old rows or an empty state
  // from flashing when URL filters change. Errors remain distinct from empty results.
  if (scopeState.kind !== 'ready') {
    if (hideFilters) return <TaskBlockingState state={scopeState} dashboard />;
    return (
      <>
        {pageHeader}
        <TaskBlockingState state={scopeState} dashboard={false} />
      </>
    );
  }

  const { tasks: visibleTasks, groups: visibleGroupedTasks, refreshError: currentError } = scopeState;

  // Shared table content props
  const tableContentProps = {
    groupedTasks: visibleGroupedTasks,
    expandedGroups,
    onRowClick: handleRowClick,
    onToggleGroup: toggleGroup,
    selectedTaskId,
    // Rows open beside the list rather than navigating away, so cards draw no drill-in chevron.
    selectsInPlace: Boolean(onSelectTask),
  };

  // Dashboard integration: simpler layout without anchored header/footer
  if (hideFilters) {
    return (
      <div className="flex min-h-[18rem] w-full flex-1 flex-col">
        <Filters {...filterProps} />

        {currentError && <DashboardErrorState error={currentError} />}

        {visibleTasks.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center px-6 py-12 text-center">
            <Inbox className="mb-4 h-12 w-12 text-slate-200" aria-hidden="true" />
            <p className="max-w-md text-sm text-slate-500">No tasks found — try clearing filters, or start one by creating a plan or adding your ProPR trigger label to a GitHub issue.</p>
          </div>
        ) : (
          <TaskTableContent {...tableContentProps} />
        )}

        <Pagination
          hideFilters={hideFilters}
          totalTasks={totalTasks}
          tasksPerPage={tasksPerPage}
          currentPage={currentPage}
          setCurrentPage={setCurrentPage}
        />
      </div>
    );
  }

  // Main Tasks page: full-height flex layout with anchored header/footer
  return (
    <>
      {pageHeader}

      {/*
        Scrollable Content Area, bounded by the header and footer. Its bottom
        padding is the list's run-out: scrolled to the end, the last row stops
        2rem above the footer's border instead of sitting on it.
      */}
      <div className="min-h-0 flex-1 overflow-y-auto pb-8" data-testid="task-list-scroll">
        {currentError && <div className="px-4 pt-4 sm:px-6"><DashboardErrorState error={currentError} /></div>}
        {visibleTasks.length === 0 ? (
          <div className="text-center py-20 mx-4 sm:mx-6 bg-gray-50 rounded-lg border border-dashed border-gray-300">
            <p className="text-gray-500">No tasks found — try clearing filters, or start one by creating a plan or adding your ProPR trigger label to a GitHub issue.</p>
          </div>
        ) : (
          <TaskTableContent {...tableContentProps} />
        )}
      </div>

      {/* Anchored Footer, pinned to the bottom like the other sections, however few tasks there are */}
      <div className="flex-shrink-0 bg-slate-50 border-t border-gray-200" data-testid="task-list-footer">
        <Pagination
          hideFilters={false}
          pinned
          totalTasks={totalTasks}
          tasksPerPage={tasksPerPage}
          currentPage={currentPage}
          setCurrentPage={setCurrentPage}
          returnedCount={visibleGroupedTasks.length}
        />
      </div>
    </>
  );
};

export default TaskList;
