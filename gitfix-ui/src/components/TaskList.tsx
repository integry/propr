import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { getTasks, getRepositoryStats } from '../api/gitfixApi';
import type { Task, TaskListProps, LoadConfig, TaskGroup } from './TaskList/types';
import { Filters } from './TaskList/Filters';
import { Pagination } from './TaskList/Pagination';
import { ParentTaskRow, ChildTaskRow, CollapseToggleRow } from './TaskList/TaskRows';
import { MobileTaskCard } from './TaskList/MobileTaskCard';

const TaskList: React.FC<TaskListProps> = ({ limit, showViewAll = false, hideFilters = false }) => {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [filter, setFilter] = useState<string>('all');
  const [repoFilter, setRepoFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [debouncedSearch, setDebouncedSearch] = useState<string>('');

  const [availableRepos, setAvailableRepos] = useState<string[]>([]);
  const [reposLoading, setReposLoading] = useState<boolean>(true);

  const [totalTasks, setTotalTasks] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState<number>(0);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const tasksPerPage = limit;

  const navigate = useNavigate();

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

  // Debounce search query
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
      setCurrentPage(0); // Reset page when search changes
    }, 400); // 400ms debounce

    return () => clearTimeout(timer);
  }, [searchQuery]);

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
        hideFilters={hideFilters}
        showViewAll={showViewAll}
        filter={filter}
        setFilter={setFilter}
        repoFilter={repoFilter}
        setRepoFilter={setRepoFilter}
        availableRepos={availableRepos}
        reposLoading={reposLoading}
        setCurrentPage={setCurrentPage}
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

          {/* Desktop Table View */}
          <div className="hidden md:block overflow-x-auto bg-white border border-gray-200 rounded-lg shadow-sm">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50/50">
                  <th className="py-3 px-4 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider w-48">Repository</th>
                  <th className="py-3 px-4 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Issue/Task</th>
                  <th className="py-3 px-4 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider w-32">Status</th>
                  <th className="py-3 px-4 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider w-36">Metadata</th>
                  <th className="py-3 px-4 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider w-16"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {groupedTasks.map((group, index) => {
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

                  // Check if this group's repository is the same as the previous one
                  const prevGroup = index > 0 ? groupedTasks[index - 1] : null;
                  const isDuplicateRepo = prevGroup
                    ? prevGroup.repoOwner === group.repoOwner && prevGroup.repoName === group.repoName
                    : false;

                  return (
                    <React.Fragment key={group.key}>
                      <ParentTaskRow group={group} task={parentTask} onRowClick={handleRowClick} isDuplicateRepo={isDuplicateRepo} />

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
              </tbody>
            </table>
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
