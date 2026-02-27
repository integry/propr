import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { getTasks, getRepositoryStats } from '../api/proprApi';
import type { TaskListProps, LoadConfig } from './TaskList/types';
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

const TaskList: React.FC<TaskListProps> = ({ limit, showViewAll = false, hideFilters = false }) => {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

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

  const [tasks, setTasks] = useState<import('./TaskList/types').Task[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [availableRepos, setAvailableRepos] = useState<string[]>([]);
  const [reposLoading, setReposLoading] = useState<boolean>(true);

  const [totalTasks, setTotalTasks] = useState<number>(0);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const tasksPerPage = limit;

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

  useEffect(() => {
    const fetchRepos = async () => {
      try {
        setReposLoading(true);
        const data = await getRepositoryStats();

        // Extract repository names from stats (repos with task history)
        const reposWithHistory = (data.repositories || []).map(r => r.repository);

        // Sort alphabetically and include "all" option at the beginning
        setAvailableRepos(['all', ...reposWithHistory.sort()]);
      } catch (err) {
        console.error('Error fetching repositories:', err);
      } finally {
        setReposLoading(false);
      }
    };
    fetchRepos();
  }, []);

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

  useEffect(() => {
    const fetchTasks = async (loadConfig?: LoadConfig) => {
      try {
        setLoading(loadConfig?.setLoadingState ?? true);
        const offset = currentPage * tasksPerPage;
        // Fetch more tasks if we are doing grouping, as grouping reduces visible items
        // But for now respecting the limit passed to component to avoid breaking pagination logic entirely
        // Ideally pagination should be group-aware or fetch more to fill the page
        const data = await getTasks(filter, tasksPerPage * 2, offset, repoFilter, debouncedSearch);
        setTasks(data.tasks || []);
        setTotalTasks(data.total || 0);
      } catch (err) {
        setError((err as Error).message);
        console.error('Error fetching tasks:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchTasks({ setLoadingState: true });
    const interval = setInterval(() => fetchTasks({ setLoadingState: false }), 5000);
    return () => clearInterval(interval);
  }, [filter, tasksPerPage, currentPage, repoFilter, debouncedSearch]);

  const groupedTasks = useMemo(() => groupTasksForDisplay(tasks), [tasks]);

  const toggleGroup = useMemo(() => createToggleGroupHandler(setExpandedGroups), []);

  const handleRowClick = useCallback((taskId: string) => {
    navigate(`/tasks/${taskId}`);
  }, [navigate]);

  // Loading state
  if (loading && tasks.length === 0) {
    return hideFilters ? <DashboardLoadingState /> : <FullPageLoadingState />;
  }

  // Error state
  if (error) {
    return hideFilters ? <DashboardErrorState error={error} /> : <FullPageErrorState error={error} />;
  }

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
    groupedTasks,
    expandedGroups,
    onRowClick: handleRowClick,
    onToggleGroup: toggleGroup,
  };

  // Dashboard integration: simpler layout without anchored header/footer
  if (hideFilters) {
    return (
      <div>
        <Filters {...filterProps} />

        {tasks.length === 0 ? (
          <p className="text-gray-500 text-center py-8">No tasks found</p>
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
      {/* Anchored Header */}
      <div className="flex-shrink-0 bg-slate-50 border-b border-gray-200 px-6 py-4">
        <Filters {...filterProps} />
      </div>

      {/* Scrollable Content Area */}
      <div className="flex-1 overflow-auto">
        {tasks.length === 0 ? (
          <div className="text-center py-20 mx-6 my-6 bg-gray-50 rounded-lg border border-dashed border-gray-300">
            <p className="text-gray-500">No tasks found</p>
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
      {tasks.length > 0 && totalPages > 1 && (
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
