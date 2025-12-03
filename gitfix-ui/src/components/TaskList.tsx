import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getTasks, getAvailableGithubRepos } from '../api/gitfixApi';

interface Task {
  id: string;
  repository?: string;
  issueNumber?: number;
  title?: string;
  subtitle?: string;
  status: string;
  createdAt: string;
  processedAt?: string;
  completedAt?: string;
}

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
        const data = await getTasks(filter, tasksPerPage, offset, repoFilter);
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

  const getStatusColor = (status: string): string => {
    switch (status) {
      case 'completed':
        return '#10b981';
      case 'failed':
        return '#ef4444';
      case 'active':
      case 'claude_execution':
      case 'processing':
        return '#3b82f6';
      case 'waiting':
      case 'pending':
        return '#8b5cf6';
      default:
        return '#6b7280';
    }
  };

  const getStatusDotClass = (status: string): string => {
    switch (status) {
      case 'completed':
        return 'bg-green-500';
      case 'failed':
        return 'bg-red-500';
      case 'active':
      case 'claude_execution':
      case 'processing':
        return 'bg-orange-500 animate-pulse';
      case 'waiting':
      case 'pending':
        return 'bg-purple-500';
      default:
        return 'bg-gray-500';
    }
  };

  const formatDate = (dateString: string | undefined): string => {
    if (!dateString) return 'N/A';
    const date = new Date(dateString);
    return date.toLocaleString();
  };

  const formatDuration = (startTime: string | undefined, endTime: string | undefined, status: string): string => {
    if (!startTime) return 'N/A';
    
    const end = endTime ? new Date(endTime) : new Date();
    const duration = end.getTime() - new Date(startTime).getTime();
    
    const minutes = Math.floor(duration / 60000);
    const seconds = Math.floor((duration % 60000) / 1000);
    
    const isActive = ['active', 'claude_execution', 'processing'].includes(status);
    const suffix = isActive ? ' (running)' : '';
    return `${minutes}m ${seconds}s${suffix}`;
  };

  const handleRowClick = (taskId: string) => {
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
                <th className="py-3 px-4 text-left text-sm font-medium text-gray-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {tasks.map((task, index) => (
                <tr 
                  key={task.id}
                  className={`hover:bg-gray-50 transition-colors cursor-pointer ${
                    index % 2 === 0 ? 'bg-white' : 'bg-light-100/50'
                  }`}
                  onClick={() => handleRowClick(task.id)}
                >
                  <td className="py-4 px-4 text-sm text-gray-600 truncate">
                    {task.repository || 'Unknown'}
                  </td>
                  <td className="py-4 px-4 max-w-xs">
                    <div className="font-medium text-gray-800">
                      {task.id.startsWith('pr-comments-batch') ? 
                        `PR #${task.issueNumber || 'N/A'} Comments` : 
                        task.issueNumber ? `Issue #${task.issueNumber}` : 'Task'
                      }
                    </div>
                    {task.title && (
                      <div className="text-sm text-gray-500 mt-1 truncate">
                        {task.title.replace(/^(New Issue: |Followup: )/, '')}
                      </div>
                    )}
                    {task.subtitle && (
                      <div className="text-sm text-gray-400 mt-1 truncate">
                        {task.subtitle}
                      </div>
                    )}
                  </td>
                  <td className="py-4 px-4">
                    <div className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full ${getStatusDotClass(task.status)}`}></span>
                      <span className="text-sm font-medium capitalize" style={{ color: getStatusColor(task.status) }}>
                        {task.status === 'claude_execution' ? 'Implementing' : task.status}
                      </span>
                    </div>
                  </td>
                  <td className="py-4 px-4 text-sm text-gray-600">
                    {formatDate(task.createdAt)}
                  </td>
                  <td className="py-4 px-4 text-sm text-gray-600">
                    {formatDuration(task.processedAt || task.createdAt, task.completedAt, task.status)}
                  </td>
                  <td className="py-4 px-4">
                    <button className="px-3 py-1.5 bg-white border border-primary-600 text-primary-600 hover:bg-primary-600 hover:text-white text-sm rounded-md transition-colors">
                      Details
                    </button>
                  </td>
                </tr>
              ))}
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
