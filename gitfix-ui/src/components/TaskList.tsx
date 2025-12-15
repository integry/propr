import React, { useState, useEffect, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getTasks, getAvailableGithubRepos } from '../api/gitfixApi';
import { ChevronRight, ChevronDown } from 'lucide-react';
import {
  Task,
  getStatusPillClasses,
  isActiveStatus,
  getStatusLabel,
  formatRelativeTime,
  formatDuration,
  getTaskIdentifier,
  groupTasks,
} from '../utils/taskUtils';

interface TaskListProps {
  limit: number;
  showViewAll?: boolean;
  hideFilters?: boolean;
}

interface LoadConfig {
  setLoadingState?: boolean;
}

const TaskList: React.FC<TaskListProps> = ({ limit, showViewAll = false, hideFilters = false }) => {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [filter, setFilter] = useState<string>('all');
  const [repoFilter, setRepoFilter] = useState<string>('all');

  const [availableRepos, setAvailableRepos] = useState<string[]>([]);
  const [reposLoading, setReposLoading] = useState<boolean>(true);

  const [totalTasks, setTotalTasks] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState<number>(0);
  const tasksPerPage = limit;

  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const navigate = useNavigate();

  useEffect(() => {
    const fetchRepos = async () => {
      try {
        setReposLoading(true);
        const data = await getAvailableGithubRepos() as { repos?: string[] };
        setAvailableRepos(['all', ...(data.repos || []).sort()]);
      } catch (err) {
        console.error('Error fetching repositories:', err);
      } finally {
        setReposLoading(false);
      }
    };
    fetchRepos();
  }, []);

  useEffect(() => {
    const fetchTasks = async (loadConfig?: LoadConfig) => {
      try {
        setLoading(loadConfig?.setLoadingState ?? true);
        const offset = currentPage * tasksPerPage;
        const data = await getTasks(filter, tasksPerPage, offset, repoFilter) as { tasks?: Task[]; total?: number };
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
  }, [filter, tasksPerPage, currentPage, repoFilter]);

  // Group tasks by Repository + Issue/PR Number
  const groupedTasks = useMemo(() => groupTasks(tasks), [tasks]);

  const toggleGroup = (groupKey: string) => {
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

  const handleRowClick = (taskId: string, e: React.MouseEvent) => {
    // Prevent navigation when clicking on expand/collapse button
    if ((e.target as HTMLElement).closest('.expand-collapse-btn')) {
      return;
    }
    navigate(`/tasks/${taskId}`);
  };

  if (loading && tasks.length === 0) return <div className="text-gray-500">Loading tasks...</div>;
  if (error) return <div className="text-red-600">Error loading tasks: {error}</div>;

  return (
    <div>
      <div className="flex justify-between items-center mb-4 flex-wrap gap-4">
        <h3 className="text-lg font-semibold text-gray-900">Tasks</h3>
        <div className="flex items-center gap-4">
          {!hideFilters && (
            <>
              <select
                value={repoFilter}
                onChange={(e) => { setRepoFilter(e.target.value); setCurrentPage(0); }}
                disabled={reposLoading}
                className="px-3 py-2 bg-gray-50 border border-gray-300 text-gray-800 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500 cursor-pointer disabled:opacity-50"
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
                onChange={(e) => { setFilter(e.target.value); setCurrentPage(0); }}
                className="px-3 py-2 bg-gray-50 border border-gray-300 text-gray-800 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500 cursor-pointer"
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
            <Link to="/tasks" className="text-primary-600 hover:text-primary-700 transition-colors">
              View All Tasks
            </Link>
          )}
        </div>
      </div>

      {tasks.length === 0 ? (
        <p className="text-gray-500 text-center py-8">No tasks found</p>
      ) : (
        <div className="overflow-x-auto bg-white border border-gray-200 rounded-lg shadow-sm">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="py-3 px-4 text-left text-sm font-medium text-gray-500 uppercase tracking-wider">Repository</th>
                <th className="py-3 px-4 text-left text-sm font-medium text-gray-500 uppercase tracking-wider">Issue/Task</th>
                <th className="py-3 px-4 text-left text-sm font-medium text-gray-500 uppercase tracking-wider">Status</th>
                <th className="py-3 px-4 text-left text-sm font-medium text-gray-500 uppercase tracking-wider">Created</th>
                <th className="py-3 px-4 text-left text-sm font-medium text-gray-500 uppercase tracking-wider">Duration</th>
                <th className="py-3 px-4 text-left text-sm font-medium text-gray-500 uppercase tracking-wider w-12"></th>
              </tr>
            </thead>
            <tbody>
              {groupedTasks.map((group) => {
                const parentTask = group.tasks[0];
                const allChildren = group.tasks.slice(1);
                const isExpanded = expandedGroups.has(group.key);
                const showCollapse = allChildren.length > 3;

                const visibleChildren = isExpanded ? allChildren : allChildren.slice(0, 3);
                const hiddenCount = allChildren.length - (isExpanded ? 0 : Math.min(3, allChildren.length));

                return (
                  <React.Fragment key={group.key}>
                    {/* Parent Row */}
                    <tr
                      className="bg-white border-b border-gray-100 hover:bg-gray-50 transition-colors cursor-pointer"
                      onClick={(e) => handleRowClick(parentTask.id, e)}
                    >
                      {/* Repository Column */}
                      <td className="py-4 px-4">
                        <div className="text-xs text-gray-400">{group.repoOwner}</div>
                        <div className="font-bold text-gray-800 text-sm">{group.repoName}</div>
                      </td>

                      {/* Issue/Task Column */}
                      <td className="py-4 px-4 max-w-xs">
                        <div className="flex items-center gap-2">
                          <span className="text-blue-600 font-bold">
                            {getTaskIdentifier(parentTask)}
                          </span>
                        </div>
                        {parentTask.title && (
                          <div className="text-sm text-gray-600 mt-1 truncate">
                            {parentTask.title.replace(/^(New Issue: |Followup: )/, '')}
                          </div>
                        )}
                        {parentTask.subtitle && (
                          <div className="text-xs text-gray-400 mt-0.5 truncate">
                            {parentTask.subtitle}
                          </div>
                        )}
                      </td>

                      {/* Status Column - Pills */}
                      <td className="py-4 px-4">
                        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${getStatusPillClasses(parentTask.status)}`}>
                          {isActiveStatus(parentTask.status) && (
                            <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse"></span>
                          )}
                          {getStatusLabel(parentTask.status)}
                        </span>
                      </td>

                      {/* Created Column - Relative Time */}
                      <td className="py-4 px-4 text-sm text-gray-500" title={new Date(parentTask.createdAt).toLocaleString()}>
                        {formatRelativeTime(parentTask.createdAt)}
                      </td>

                      {/* Duration Column - Monospace */}
                      <td className="py-4 px-4 text-sm text-gray-600 font-mono">
                        {formatDuration(parentTask.processedAt || parentTask.createdAt, parentTask.completedAt, parentTask.status)}
                      </td>

                      {/* Actions Column */}
                      <td className="py-4 px-4">
                        <ChevronRight className="w-5 h-5 text-gray-400" />
                      </td>
                    </tr>

                    {/* Collapse Trigger Row - Show older updates */}
                    {showCollapse && hiddenCount > 0 && (
                      <tr
                        className="bg-gray-50/70 border-b border-gray-100 expand-collapse-btn"
                        onClick={() => toggleGroup(group.key)}
                      >
                        <td className="py-1.5 px-4">
                          <span className="text-gray-300 text-lg">│</span>
                        </td>
                        <td colSpan={5} className="py-1.5 px-4">
                          <button className="flex items-center gap-1 text-blue-500 text-xs hover:text-blue-600 transition-colors cursor-pointer">
                            <ChevronDown className={`w-3 h-3 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                            {isExpanded ? 'Hide' : `Show ${hiddenCount}`} older update{hiddenCount !== 1 ? 's' : ''}...
                          </button>
                        </td>
                      </tr>
                    )}

                    {/* Children Rows */}
                    {visibleChildren.map((child, childIndex) => (
                      <tr
                        key={child.id}
                        className="bg-gray-50/50 border-b border-gray-100 hover:bg-gray-100/50 transition-colors cursor-pointer"
                        onClick={(e) => handleRowClick(child.id, e)}
                      >
                        {/* Repository Column - Hidden for children, show connector */}
                        <td className="py-3 px-4">
                          <span className="text-gray-300 text-lg">
                            {childIndex === visibleChildren.length - 1 ? '└' : '│'}
                          </span>
                        </td>

                        {/* Issue/Task Column - Indented */}
                        <td className="py-3 px-4 max-w-xs">
                          <div className="flex items-start gap-2 pl-2">
                            <span className="text-gray-300 mt-0.5">─</span>
                            <div>
                              {child.title && (
                                <div className="text-sm text-gray-600 truncate">
                                  {child.title.replace(/^(New Issue: |Followup: )/, '')}
                                </div>
                              )}
                              {child.subtitle && (
                                <div className="text-xs text-gray-400 mt-0.5 truncate">
                                  {child.subtitle}
                                </div>
                              )}
                            </div>
                          </div>
                        </td>

                        {/* Status Column - Pills */}
                        <td className="py-3 px-4">
                          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${getStatusPillClasses(child.status)}`}>
                            {isActiveStatus(child.status) && (
                              <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse"></span>
                            )}
                            {getStatusLabel(child.status)}
                          </span>
                        </td>

                        {/* Created Column - Relative Time */}
                        <td className="py-3 px-4 text-sm text-gray-500" title={new Date(child.createdAt).toLocaleString()}>
                          {formatRelativeTime(child.createdAt)}
                        </td>

                        {/* Duration Column - Monospace */}
                        <td className="py-3 px-4 text-sm text-gray-600 font-mono">
                          {formatDuration(child.processedAt || child.createdAt, child.completedAt, child.status)}
                        </td>

                        {/* Actions Column */}
                        <td className="py-3 px-4">
                          <ChevronRight className="w-4 h-4 text-gray-300" />
                        </td>
                      </tr>
                    ))}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!hideFilters && totalTasks > tasksPerPage && (
        <div className="flex justify-between items-center mt-4">
          <div>
            <span className="text-sm text-gray-600">
              Showing {currentPage * tasksPerPage + 1} - {Math.min((currentPage + 1) * tasksPerPage, totalTasks)} of {totalTasks} tasks
            </span>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setCurrentPage(prev => Math.max(prev - 1, 0))}
              disabled={currentPage === 0}
              className="px-3 py-1.5 bg-white border border-gray-300 text-gray-700 hover:bg-gray-50 text-sm rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Previous
            </button>
            <button
              onClick={() => setCurrentPage(prev => (prev + 1) * tasksPerPage < totalTasks ? prev + 1 : prev)}
              disabled={(currentPage + 1) * tasksPerPage >= totalTasks}
              className="px-3 py-1.5 bg-white border border-gray-300 text-gray-700 hover:bg-gray-50 text-sm rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default TaskList;
