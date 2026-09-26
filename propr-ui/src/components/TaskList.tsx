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
import { useLiveRefreshScheduler } from '../hooks/useLiveRefreshScheduler';
import type { TaskUpdatePayload } from '@propr/shared';

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

const TaskList: React.FC<TaskListProps> = ({ limit, showViewAll = false, hideFilters = false }) => {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { onTaskUpdate, isConnected } = useSocket();

  // Determine whether to use URL-based state (only when filters are shown - Tasks page)
  const useUrlState = !hideFilters;

  // Derive values directly from URL parameters
  const urlFilter = searchParams.get('status') || 'all';
  const urlRepoFilter = searchParams.get('repository') || 'all';
  const urlSearchParam = searchParams.get('search') || '';
  // Note: URL uses 1-based page, internal state uses 0-based
  const urlPage = Math.max(0, parseInt(searchParams.get('page') || '1', 10) - 1);

  // Local state (used when hideFilters is true, e.g., Dashboard)
  const [localFilter, setLocalFilter] = useState<string>('all');
  const [localRepoFilter, setLocalRepoFilter] = useState<string>('all');
  const [localCurrentPage, setLocalCurrentPage] = useState<number>(0);

  // Get the effective filter values based on whether we use URL or local state
  const filter = selectValue(useUrlState, urlFilter, localFilter);
  const repoFilter = selectValue(useUrlState, urlRepoFilter, localRepoFilter);
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
    () => JSON.stringify([filter, repoFilter, currentPage, debouncedSearch, tasksPerPage]),
    [currentPage, debouncedSearch, filter, repoFilter, tasksPerPage]
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
      // Fetch more tasks if we are doing grouping, as grouping reduces visible items
      // But for now respecting the limit passed to component to avoid breaking pagination logic entirely
      // Ideally pagination should be group-aware or fetch more to fill the page
      const data = await getTasks(filter, tasksPerPage * 2, offset, repoFilter, debouncedSearch);
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
  }, [filter, tasksPerPage, currentPage, repoFilter, debouncedSearch, queryScope]);

  // Refresh repository stats only on initial mount when filters are visible.
  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

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

  const toggleGroup = useMemo(() => createToggleGroupHandler(setExpandedGroups), []);

  const handleRowClick = useCallback((taskId: string) => {
    navigate(`/tasks/${encodeURIComponent(taskId)}`);
  }, [navigate]);

  const scopeState = resolveTaskScopeState(loadedScope, queryScope, tasks, groupedTasks, error);

  // A scope that has not completed successfully is loading even during the
  // render before its effect starts. This prevents old rows or an empty state
  // from flashing when URL filters change. Errors remain distinct from empty results.
  if (scopeState.kind !== 'ready') {
    return <TaskBlockingState state={scopeState} dashboard={hideFilters} />;
  }

  const { tasks: visibleTasks, groups: visibleGroupedTasks, refreshError: currentError } = scopeState;

  const totalPages = Math.ceil(totalTasks / tasksPerPage);

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
  };

  // Shared table content props
  const tableContentProps = {
    groupedTasks: visibleGroupedTasks,
    expandedGroups,
    onRowClick: handleRowClick,
    onToggleGroup: toggleGroup,
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
      {/* Anchored Header - compact on mobile */}
      <div className="flex-shrink-0 bg-slate-50 border-b border-gray-200 px-4 sm:px-6 py-2 sm:py-4">
        <Filters {...filterProps} />
      </div>

      {/* Scrollable Content Area */}
      <div className="flex-1 overflow-auto">
        {currentError && <div className="px-4 pt-4 sm:px-6"><DashboardErrorState error={currentError} /></div>}
        {visibleTasks.length === 0 ? (
          <div className="text-center py-20 mx-4 sm:mx-6 bg-gray-50 rounded-lg border border-dashed border-gray-300">
            <p className="text-gray-500">No tasks found — try clearing filters, or start one by creating a plan or adding your ProPR trigger label to a GitHub issue.</p>
          </div>
        ) : (
          <div className="flex flex-col h-full bg-white">
            <div className="flex-1 overflow-auto">
              <TaskTableContent {...tableContentProps} />
            </div>
          </div>
        )}
      </div>

      {/* Anchored Footer */}
      {visibleTasks.length > 0 && totalPages > 1 && (
        <div className="flex-shrink-0 bg-slate-50 border-t border-gray-200">
          <Pagination
            hideFilters={false}
            totalTasks={totalTasks}
            tasksPerPage={tasksPerPage}
            currentPage={currentPage}
            setCurrentPage={setCurrentPage}
          />
        </div>
      )}
    </>
  );
};

export default TaskList;
