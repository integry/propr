import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { getTasks, getRepositoryStats } from '../api/gitfixApi';
import type { Task, TaskListProps, LoadConfig, TaskGroup } from './TaskList/types';
import { Filters } from './TaskList/Filters';
import { Pagination } from './TaskList/Pagination';
import { ParentTaskRow, ChildTaskRow, CollapseToggleRow } from './TaskList/TaskRows';
import { MobileTaskCard } from './TaskList/MobileTaskCard';

const TaskList: React.FC<TaskListProps> = ({ limit, showViewAll = false, hideFilters = false, title }) => {
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
  const filter = useUrlState ? urlFilter : localFilter;
  const repoFilter = useUrlState ? urlRepoFilter : localRepoFilter;
  const currentPage = useUrlState ? urlPage : localCurrentPage;

  // Search state - local input for typing, debounced for API/URL
  const urlSearch = useUrlState ? urlSearchParam : '';
  const [searchQuery, setSearchQuery] = useState<string>(urlSearch);
  const [debouncedSearch, setDebouncedSearch] = useState<string>(urlSearch);
  const isInitialMount = useRef(true);

  const [tasks, setTasks] = useState<Task[]>([]);
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
        if (value === null || value === 'all' || value === '' || value === '1') {
          newParams.delete(key);
        } else {
          newParams.set(key, value);
        }
      });
      return newParams;
    }, { replace: true });
  }, [useUrlState, setSearchParams]);

  // Unified setters that work with both URL and local state
  const setFilter = useCallback((newFilter: string) => {
    if (useUrlState) {
      updateSearchParams({ status: newFilter, page: '1' });
    } else {
      setLocalFilter(newFilter);
      setLocalCurrentPage(0);
    }
  }, [useUrlState, updateSearchParams]);

  const setRepoFilter = useCallback((newRepo: string) => {
    if (useUrlState) {
      updateSearchParams({ repository: newRepo, page: '1' });
    } else {
      setLocalRepoFilter(newRepo);
      setLocalCurrentPage(0);
    }
  }, [useUrlState, updateSearchParams]);

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

  // Debounce search query and update URL when applicable
  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchQuery !== debouncedSearch) {
        setDebouncedSearch(searchQuery);
        if (useUrlState) {
          // Update URL with search parameter and reset to page 1
          setSearchParams(prev => {
            const newParams = new URLSearchParams(prev);
            if (searchQuery) {
              newParams.set('search', searchQuery);
            } else {
              newParams.delete('search');
            }
            newParams.delete('page'); // Reset to page 1 (default, so delete it)
            return newParams;
          }, { replace: true });
        } else {
          setLocalCurrentPage(0); // Reset page when search changes
        }
      }
    }, 400); // 400ms debounce

    return () => clearTimeout(timer);
  }, [searchQuery, debouncedSearch, useUrlState, setSearchParams]);

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

  const groupedTasks = useMemo(() => {
    const groups: Record<string, TaskGroup> = {};

    tasks.forEach(task => {
      // robustly handle owner/name splitting
      let owner = task.repositoryOwner;
      let name = task.repositoryName;

      if (!owner || !name) {
        const parts = (task.repository || 'unknown/unknown').split('/');
        owner = parts[0] || 'unknown';
        name = parts[1] || 'unknown';
      }

      // Group tasks by PR number if available, otherwise by issue number, or task ID
      // Both new issue tasks and followup tasks should be grouped by their PR number
      // since they all belong to the same PR (e.g., PR #380 for issue #379)
      // For new issues without followups, group by issue number instead
      let key: string;
      if (task.prNumber) {
        // Group by PR number (preferred)
        key = `${owner}/${name}-pr-${task.prNumber}`;
      } else if (task.issueNumber) {
        // Group by issue number if no PR number is available
        key = `${owner}/${name}-issue-${task.issueNumber}`;
      } else {
        // Fallback to task ID if neither PR nor issue number is available
        key = task.id;
      }

      if (!groups[key]) {
        groups[key] = {
          key,
          repoOwner: owner,
          repoName: name,
          prNumber: task.prNumber,
          tasks: []
        };
      }
      groups[key].tasks.push(task);
    });

    return Object.values(groups).sort((a, b) => {
      // Sort groups by the date of their most recent task
      const dateA = new Date(a.tasks[0].createdAt).getTime();
      const dateB = new Date(b.tasks[0].createdAt).getTime();
      return dateB - dateA;
    });
  }, [tasks]);

  const toggleGroup = (groupKey: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupKey)) {
        next.delete(groupKey);
      } else {
        next.add(groupKey);
      }
      return next;
    });
  };

  const handleRowClick = (taskId: string) => {
    navigate(`/tasks/${taskId}`);
  };

  if (loading && tasks.length === 0) return <div className="text-gray-500 p-4">Loading tasks...</div>;
  if (error) return <div className="text-red-600 p-4">Error loading tasks: {error}</div>;

  return (
    <div>
      <Filters
        title={title}
        hideFilters={hideFilters}
        showViewAll={showViewAll}
        filter={filter}
        setFilter={setFilter}
        repoFilter={repoFilter}
        setRepoFilter={setRepoFilter}
        availableRepos={availableRepos}
        reposLoading={reposLoading}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
      />

      {tasks.length === 0 ? (
        <p className="text-gray-500 text-center py-8">No tasks found</p>
      ) : (
        <>
          {/* Mobile Card View */}
          <div className="md:hidden space-y-3">
            {groupedTasks.map((group) => (
              <MobileTaskCard
                key={group.key}
                group={group}
                expandedGroups={expandedGroups}
                onRowClick={handleRowClick}
                onToggleGroup={toggleGroup}
              />
            ))}
          </div>

          {/* Desktop List View */}
          <div className="hidden md:block bg-white border border-gray-200 rounded-lg shadow-sm overflow-hidden">
            <div className="divide-y divide-gray-100">
              {groupedTasks.map((group) => {
                const parentTask = group.tasks[0];
                const allChildren = group.tasks.slice(1);

                const isExpanded = expandedGroups.has(group.key);

                // The "Last 3" Rule
                // If group has many items (e.g. > 5 total, so > 4 children), collapse by default
                // show collapse trigger if children > 3
                const shouldCollapse = allChildren.length > 3;

                let visibleChildren = allChildren;
                let hiddenCount = 0;

                if (shouldCollapse && !isExpanded) {
                  visibleChildren = allChildren.slice(0, 3);
                  hiddenCount = allChildren.length - 3;
                }

                return (
                  <React.Fragment key={group.key}>
                    <ParentTaskRow group={group} task={parentTask} onRowClick={handleRowClick} />

                    {visibleChildren.map((child, childIndex) => (
                      <ChildTaskRow
                        key={child.id}
                        task={child}
                        onRowClick={handleRowClick}
                        isLastChild={childIndex === visibleChildren.length - 1 && hiddenCount === 0}
                      />
                    ))}

                    {hiddenCount > 0 && (
                      <CollapseToggleRow groupKey={group.key} hiddenCount={hiddenCount} onToggle={toggleGroup} />
                    )}
                  </React.Fragment>
                );
              })}
            </div>
          </div>
        </>
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
};

export default TaskList;
