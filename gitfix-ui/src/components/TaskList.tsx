import React, { useState, useEffect, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { getTasks, getAvailableGithubRepos } from '../api/gitfixApi';

interface Task {
  id: string;
  repository?: string;
  repositoryOwner?: string;
  repositoryName?: string;
  issueNumber?: number;
  title?: string;
  subtitle?: string;
  status: string;
  createdAt: string;
  processedAt?: string;
  completedAt?: string;
  modelName?: string;
  model?: string;
  llmProvider?: string;
}

type TaskType = 'new-issue' | 'followup' | 'unknown';

interface TaskTypeInfo {
  type: TaskType;
  cleanTitle: string;
}

interface TaskListProps {
  limit: number;
  showViewAll?: boolean;
  hideFilters?: boolean;
}

interface LoadConfig {
  setLoadingState?: boolean;
}

interface TaskGroup {
  key: string;
  repoOwner: string;
  repoName: string;
  issueNumber?: number;
  tasks: Task[]; // Sorted newest first
}

const getTaskTypeInfo = (task: Task): TaskTypeInfo => {
  const title = task.title || '';

  if (title.startsWith('New Issue:')) {
    return {
      type: 'new-issue',
      cleanTitle: title.replace(/^New Issue:\s*/, '').trim()
    };
  }

  if (title.startsWith('Followup:')) {
    return {
      type: 'followup',
      cleanTitle: title.replace(/^Followup:\s*/, '').trim()
    };
  }

  return {
    type: 'unknown',
    cleanTitle: title
  };
};

const TaskTypeBadge: React.FC<{ type: TaskType }> = ({ type }) => {
  if (type === 'new-issue') {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800 border border-blue-200">
        New Issue
      </span>
    );
  }

  if (type === 'followup') {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-purple-100 text-purple-800 border border-purple-200">
        Followup
      </span>
    );
  }

  return null;
};

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
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const tasksPerPage = limit;

  const navigate = useNavigate();

  useEffect(() => {
    const fetchRepos = async () => {
      try {
        setReposLoading(true);
        const data = await getAvailableGithubRepos();
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
        // Fetch more tasks if we are doing grouping, as grouping reduces visible items
        // But for now respecting the limit passed to component to avoid breaking pagination logic entirely
        // Ideally pagination should be group-aware or fetch more to fill the page
        const data = await getTasks(filter, tasksPerPage * 2, offset, repoFilter); 
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

      // Determine if this is a PR comment/followup task or a new issue task
      const taskTypeInfo = getTaskTypeInfo(task);
      const isFollowupTask = task.id.startsWith('pr-comments-batch-') || taskTypeInfo.type === 'followup';

      // For followup tasks (PR comments), group by PR number
      // For new issue tasks, each implementation is separate, so use task ID as unique key
      let key: string;
      if (isFollowupTask && task.issueNumber) {
        // Group followup tasks by their PR number
        key = `${owner}/${name}-pr-${task.issueNumber}`;
      } else {
        // Each new issue implementation is unique, use task ID
        key = task.id;
      }

      if (!groups[key]) {
        groups[key] = {
          key,
          repoOwner: owner,
          repoName: name,
          issueNumber: task.issueNumber,
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

  const getStatusPill = (status: string) => {
    const baseClasses = "px-2 py-0.5 text-xs font-medium rounded-full inline-flex items-center gap-1.5";
    
    switch (status) {
      case 'completed':
        return (
          <span className={`${baseClasses} bg-green-50 text-green-700 border border-green-200`}>
             <span className="w-1.5 h-1.5 rounded-full bg-green-500"></span>
             Completed
          </span>
        );
      case 'failed':
        return (
          <span className={`${baseClasses} bg-red-50 text-red-700 border border-red-200`}>
             <span className="w-1.5 h-1.5 rounded-full bg-red-500"></span>
             Failed
          </span>
        );
      case 'active':
      case 'claude_execution':
      case 'processing':
        return (
          <span className={`${baseClasses} bg-blue-50 text-blue-700 border border-blue-200`}>
             <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"></span>
             Implementing
          </span>
        );
      case 'waiting':
      case 'pending':
        return (
          <span className={`${baseClasses} bg-purple-50 text-purple-700 border border-purple-200`}>
             <span className="w-1.5 h-1.5 rounded-full bg-purple-500"></span>
             Pending
          </span>
        );
      default:
        return (
          <span className={`${baseClasses} bg-gray-100 text-gray-700 border border-gray-200`}>
             <span className="w-1.5 h-1.5 rounded-full bg-gray-500"></span>
             {status}
          </span>
        );
    }
  };

  const formatRelativeTime = (dateString: string | undefined): string => {
    if (!dateString) return '';
    const date = new Date(dateString);
    const now = new Date();
    const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);
    
    if (diffInSeconds < 60) return 'Just now';
    
    // Simple logic to avoid Intl dependency issues if environment is strict, though Intl is standard now
    const minutes = Math.floor(diffInSeconds / 60);
    if (minutes < 60) return `${minutes} min${minutes > 1 ? 's' : ''} ago`;
    
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hr${hours > 1 ? 's' : ''} ago`;
    
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days} day${days > 1 ? 's' : ''} ago`;
    
    return date.toLocaleDateString();
  };

  const formatDuration = (startTime: string | undefined, endTime: string | undefined): string => {
    if (!startTime) return '--';
    
    const end = endTime ? new Date(endTime) : new Date();
    const duration = end.getTime() - new Date(startTime).getTime();
    
    const minutes = Math.floor(duration / 60000);
    const seconds = Math.floor((duration % 60000) / 1000);
    
    return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
  };

  const handleRowClick = (taskId: string) => {
    navigate(`/tasks/${taskId}`);
  };

  if (loading && tasks.length === 0) return <div className="text-gray-500 p-4">Loading tasks...</div>;
  if (error) return <div className="text-red-600 p-4">Error loading tasks: {error}</div>;

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
                onChange={(e) => { setFilter(e.target.value); setCurrentPage(0); }}
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

      {tasks.length === 0 ? (
        <p className="text-gray-500 text-center py-8">No tasks found</p>
      ) : (
        <div className="overflow-x-auto bg-white border border-gray-200 rounded-lg shadow-sm">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50/50">
                <th className="py-3 px-4 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider w-48">Repository</th>
                <th className="py-3 px-4 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Issue/Task</th>
                <th className="py-3 px-4 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider w-32">Status</th>
                <th className="py-3 px-4 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider w-32">Created</th>
                <th className="py-3 px-4 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider w-24">Duration</th>
                <th className="py-3 px-4 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider w-16"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
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
                    {/* PARENT ROW */}
                    <tr 
                      className="hover:bg-gray-50 transition-colors cursor-pointer group bg-white"
                      onClick={() => handleRowClick(parentTask.id)}
                    >
                      <td className="py-3 px-4 align-top">
                        <div className="flex flex-col">
                          <span className="text-xs text-gray-400 font-normal">{group.repoOwner}</span>
                          <span className="text-sm font-bold text-gray-800">{group.repoName}</span>
                        </div>
                      </td>
                      <td className="py-3 px-4 align-top">
                        <div className="flex flex-col gap-1">
                          <div className="flex items-center gap-2">
                            {group.issueNumber ? (
                              <span className="text-sm font-bold text-primary-600 hover:text-primary-700">
                                PR #{group.issueNumber}
                              </span>
                            ) : (
                              <span className="text-sm font-bold text-gray-700">Task {parentTask.id.substring(0, 8)}</span>
                            )}
                            <TaskTypeBadge type={getTaskTypeInfo(parentTask).type} />
                          </div>
                          <div className="text-sm text-gray-900 font-medium">
                            {(() => {
                              const typeInfo = getTaskTypeInfo(parentTask);
                              // For followup tasks, prefer subtitle if available
                              if (typeInfo.type === 'followup' && parentTask.subtitle) {
                                return parentTask.subtitle;
                              }
                              // Otherwise use the clean title
                              return typeInfo.cleanTitle || parentTask.subtitle || 'No title';
                            })()}
                          </div>
                          {(() => {
                            // Show agent/model info if available
                            const agent = parentTask.llmProvider || '';
                            const model = parentTask.model || parentTask.modelName || '';
                            if (agent || model) {
                              return (
                                <div className="flex items-center gap-2 text-xs text-gray-500">
                                  {agent && <span className="font-medium">{agent}</span>}
                                  {agent && model && <span>•</span>}
                                  {model && <span>{model}</span>}
                                </div>
                              );
                            }
                            return null;
                          })()}
                        </div>
                      </td>
                      <td className="py-3 px-4 align-top">
                        {getStatusPill(parentTask.status)}
                      </td>
                      <td className="py-3 px-4 align-top text-sm text-gray-500 whitespace-nowrap" title={new Date(parentTask.createdAt).toLocaleString()}>
                        {formatRelativeTime(parentTask.createdAt)}
                      </td>
                      <td className="py-3 px-4 align-top text-sm text-gray-600 font-mono whitespace-nowrap">
                        {formatDuration(parentTask.processedAt || parentTask.createdAt, parentTask.completedAt)}
                      </td>
                      <td className="py-3 px-4 align-top text-right">
                        <button className="p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-colors">
                          <ChevronRight size={16} />
                        </button>
                      </td>
                    </tr>

                    {/* COLLAPSE TRIGGER ROW */}
                    {hiddenCount > 0 && (
                      <tr className="bg-gray-50/30">
                        <td className="p-0 border-r border-transparent">
                           <div className="h-full w-full border-r-2 border-transparent"></div>
                        </td>
                        <td colSpan={5} className="py-1 px-4 text-xs">
                           <button 
                             onClick={(e) => toggleGroup(group.key, e)}
                             className="flex items-center gap-1 text-primary-600 hover:text-primary-700 font-medium py-1 px-2 hover:bg-blue-50 rounded transition-colors ml-6"
                           >
                             <span className="text-lg leading-none opacity-40">↳</span>
                             Show {hiddenCount} older updates...
                           </button>
                        </td>
                      </tr>
                    )}

                    {/* CHILDREN ROWS */}
                    {visibleChildren.map((child) => {
                      const childTypeInfo = getTaskTypeInfo(child);
                      const childDisplayTitle = (() => {
                        // For followup tasks, prefer subtitle if available
                        if (childTypeInfo.type === 'followup' && child.subtitle) {
                          return child.subtitle;
                        }
                        // Otherwise use the clean title
                        return childTypeInfo.cleanTitle || child.subtitle || 'Update';
                      })();

                      return (
                        <tr
                          key={child.id}
                          className="hover:bg-gray-50 transition-colors cursor-pointer bg-gray-50/30"
                          onClick={() => handleRowClick(child.id)}
                        >
                          <td className="py-2 px-4 align-top relative">
                             {/* Visual connector line placeholder if we wanted one spanning rows */}
                          </td>
                          <td className="py-2 px-4 align-top">
                            <div className="flex flex-col gap-1 pl-2">
                              <div className="flex items-start gap-2">
                                <span className="text-gray-300 font-light select-none">└─</span>
                                <span className="text-sm text-gray-600 line-clamp-1">{childDisplayTitle}</span>
                              </div>
                              {(() => {
                                // Show agent/model info if available
                                const agent = child.llmProvider || '';
                                const model = child.model || child.modelName || '';
                                if (agent || model) {
                                  return (
                                    <div className="flex items-center gap-2 text-xs text-gray-500 ml-5">
                                      {agent && <span className="font-medium">{agent}</span>}
                                      {agent && model && <span>•</span>}
                                      {model && <span>{model}</span>}
                                    </div>
                                  );
                                }
                                return null;
                              })()}
                            </div>
                          </td>
                          <td className="py-2 px-4 align-top">
                            {getStatusPill(child.status)}
                          </td>
                          <td className="py-2 px-4 align-top text-sm text-gray-500 whitespace-nowrap" title={new Date(child.createdAt).toLocaleString()}>
                            {formatRelativeTime(child.createdAt)}
                          </td>
                          <td className="py-2 px-4 align-top text-sm text-gray-600 font-mono whitespace-nowrap">
                            {formatDuration(child.processedAt || child.createdAt, child.completedAt)}
                          </td>
                          <td className="py-2 px-4 align-top text-right">
                             <button className="p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-colors">
                                <ChevronRight size={16} />
                             </button>
                          </td>
                        </tr>
                      );
                    })}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination Controls */}
      {!hideFilters && totalTasks > tasksPerPage && (
        <div className="flex justify-between items-center mt-4 px-2">
          <div className="text-sm text-gray-500">
            Showing {currentPage * tasksPerPage + 1} - {Math.min((currentPage + 1) * tasksPerPage, totalTasks)} of {totalTasks} tasks
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