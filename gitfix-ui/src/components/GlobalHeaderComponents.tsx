import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Activity, Users, AlertTriangle, RefreshCw, X, Inbox } from 'lucide-react';
import { HeaderStats } from '../hooks/useHeaderStats';
import { DraftListItem } from '../api/plannerApi';
import { getStatusBadgeStyle } from './headerUtils';

interface TaskGroup {
  key: string;
  repoOwner: string;
  repoName: string;
  prNumber?: number;
  issueNumber?: number;
  latestTask: { id: string; status: string; createdAt: string; title?: string; };
  allTasks: unknown[];
}

interface PlansDropdownProps {
  activePlans: DraftListItem[];
  isOpen: boolean;
  onClose: () => void;
  onDismiss: (planId: string) => void;
}

const PlansDropdown: React.FC<PlansDropdownProps> = ({ activePlans, isOpen, onClose, onDismiss }) => {
  const navigate = useNavigate();
  const displayPlans = activePlans.slice(0, 10);
  const handlePlanClick = (draftId: string) => { onClose(); navigate(`/studio/${draftId}`); };
  const handleViewAll = () => { onClose(); navigate('/plans'); };
  const handleDismiss = (e: React.MouseEvent, planId: string) => { e.stopPropagation(); onDismiss(planId); };
  if (!isOpen) return null;

  // Extract repo name from repository string (e.g., "owner/repo" -> "repo")
  const getRepoName = (repository: string): string => {
    const parts = repository.split('/');
    return parts.length > 1 ? parts[1] : repository;
  };

  // Get truncated plan name
  const getPlanName = (plan: DraftListItem): string => {
    const name = plan.name || plan.initial_prompt;
    return name.length > 35 ? name.slice(0, 35) + '...' : name;
  };

  return (
    <div className="absolute right-0 top-full mt-2 w-96 bg-white border border-gray-200 rounded-lg shadow-xl z-50 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
          Active Plans ({activePlans.length})
        </span>
      </div>

      <div className="max-h-80 overflow-y-auto">
        {displayPlans.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-gray-500">
            No active plans
          </div>
        ) : (
          displayPlans.map((plan, index) => (
            <div
              key={plan.draft_id}
              className={`flex items-center gap-2 px-4 py-2.5 hover:bg-gray-50 transition-colors group ${
                index < displayPlans.length - 1 ? 'border-b border-gray-100' : ''
              }`}
            >
              {/* Vertical thread indicator */}
              <div className="w-0.5 h-full self-stretch bg-gray-200 rounded-full flex-shrink-0" />

              <button
                onClick={() => handlePlanClick(plan.draft_id)}
                className="flex-1 min-w-0 flex items-center gap-2"
              >
                {/* Repo name */}
                <span className="text-xs font-medium text-gray-600 flex-shrink-0">
                  {getRepoName(plan.repository)}
                </span>

                {/* Status badge */}
                <span className={`px-1.5 py-0.5 rounded text-xs font-medium flex-shrink-0 ${getStatusBadgeStyle(plan.status)}`}>
                  {plan.status}
                </span>

                {/* Plan name - truncated */}
                <span className="text-sm text-gray-900 truncate group-hover:text-primary-600">
                  {getPlanName(plan)}
                </span>
              </button>

              {/* Dismiss button */}
              <button
                onClick={(e) => handleDismiss(e, plan.draft_id)}
                className="p-1 rounded hover:bg-gray-200 transition-colors flex-shrink-0 opacity-0 group-hover:opacity-100"
                title="Dismiss"
              >
                <X className="w-4 h-4 text-gray-400 hover:text-gray-600" />
              </button>
            </div>
          ))
        )}
      </div>

      {activePlans.length > 0 && (
        <div className="px-4 py-2.5 border-t border-gray-200 bg-gray-50">
          <button
            onClick={handleViewAll}
            className="w-full text-center text-sm font-medium text-primary-600 hover:text-primary-700"
          >
            View All Plans &rarr;
          </button>
        </div>
      )}
    </div>
  );
};

interface MachineStatusProps { runningCount: number; }

export const MachineStatus: React.FC<MachineStatusProps> = ({ runningCount }) => {
  if (runningCount === 0) return null;
  return (
    <div className="flex items-center gap-1.5 px-2.5 py-1 bg-blue-50 border border-blue-200 rounded-full">
      <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
      <Users className="w-3.5 h-3.5 text-blue-600" />
      <span className="text-xs font-medium text-blue-700">{runningCount}</span>
    </div>
  );
};

interface HumanInboxProps { reviewCount: number; }

export const HumanInbox: React.FC<HumanInboxProps> = ({ reviewCount }) => {
  if (reviewCount === 0) return null;
  return (
    <div className="flex items-center gap-1.5 px-2.5 py-1 bg-amber-50 border border-amber-200 rounded-full">
      <Inbox className="w-3.5 h-3.5 text-amber-600" />
      <span className="text-xs font-medium text-amber-700">{reviewCount}</span>
    </div>
  );
};

interface TasksDropdownProps {
  taskGroups: TaskGroup[];
  isOpen: boolean;
  onClose: () => void;
  onDismiss: (taskId: string) => void;
}

const TasksDropdown: React.FC<TasksDropdownProps> = ({ taskGroups, isOpen, onClose, onDismiss }) => {
  const navigate = useNavigate();
  const displayGroups = taskGroups.slice(0, 10);
  const handleTaskClick = (group: TaskGroup) => {
    onClose();
    if (group.prNumber) navigate(`/tasks?pr=${group.prNumber}&repo=${group.repoOwner}/${group.repoName}`);
    else if (group.issueNumber) navigate(`/tasks?issue=${group.issueNumber}&repo=${group.repoOwner}/${group.repoName}`);
    else navigate(`/tasks/${group.latestTask.id}`);
  };
  const handleViewAll = () => { onClose(); navigate('/tasks'); };
  const handleDismiss = (e: React.MouseEvent, taskId: string) => { e.stopPropagation(); onDismiss(taskId); };
  if (!isOpen) return null;

  // Get the issue/PR number for display
  const getIssueId = (group: TaskGroup): string => {
    if (group.prNumber) return `#${group.prNumber}`;
    if (group.issueNumber) return `#${group.issueNumber}`;
    return '';
  };

  // Get truncated title
  const getTitle = (group: TaskGroup): string => {
    const title = group.latestTask.title || 'Untitled';
    return title.length > 30 ? title.slice(0, 30) + '...' : title;
  };

  return (
    <div className="absolute right-0 top-full mt-2 w-96 bg-white border border-gray-200 rounded-lg shadow-xl z-50 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
          Tasks Needing Review ({taskGroups.length})
        </span>
      </div>

      <div className="max-h-80 overflow-y-auto">
        {displayGroups.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-gray-500">
            No tasks needing review
          </div>
        ) : (
          displayGroups.map((group, index) => (
            <div
              key={group.key}
              className={`flex items-center gap-2 px-4 py-2.5 hover:bg-gray-50 transition-colors group ${
                index < displayGroups.length - 1 ? 'border-b border-gray-100' : ''
              }`}
            >
              {/* Vertical thread indicator */}
              <div className="w-0.5 h-full self-stretch bg-gray-200 rounded-full flex-shrink-0" />

              <button
                onClick={() => handleTaskClick(group)}
                className="flex-1 min-w-0 flex items-center gap-2"
              >
                {/* Repo name */}
                <span className="text-xs font-medium text-gray-600 flex-shrink-0">
                  {group.repoName}
                </span>

                {/* Issue/PR ID as monospace chip */}
                {getIssueId(group) && (
                  <span className="px-1.5 py-0.5 bg-gray-100 border border-gray-200 rounded text-xs font-mono text-gray-700 flex-shrink-0">
                    {getIssueId(group)}
                  </span>
                )}

                {/* Title - truncated */}
                <span className="text-sm text-gray-900 truncate group-hover:text-primary-600">
                  {getTitle(group)}
                </span>
              </button>

              {/* Dismiss button */}
              <button
                onClick={(e) => handleDismiss(e, group.latestTask.id)}
                className="p-1 rounded hover:bg-gray-200 transition-colors flex-shrink-0 opacity-0 group-hover:opacity-100"
                title="Dismiss"
              >
                <X className="w-4 h-4 text-gray-400 hover:text-gray-600" />
              </button>
            </div>
          ))
        )}
      </div>

      {taskGroups.length > 0 && (
        <div className="px-4 py-2.5 border-t border-gray-200 bg-gray-50">
          <button
            onClick={handleViewAll}
            className="w-full text-center text-sm font-medium text-primary-600 hover:text-primary-700"
          >
            View All Tasks &rarr;
          </button>
        </div>
      )}
    </div>
  );
};

interface TasksButtonProps { taskGroups: TaskGroup[]; onDismissTask: (taskId: string) => void; }

export const TasksButton: React.FC<TasksButtonProps> = ({ taskGroups, onDismissTask }) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setIsOpen(false);
    };
    if (isOpen) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);
  const reviewCount = taskGroups.length;
  return (
    <div className="relative" ref={containerRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1.5 px-3 py-1.5 border border-amber-200 text-amber-700 bg-amber-50 rounded-full text-xs font-medium hover:bg-amber-100 transition-colors"
      >
        <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
        <span>{reviewCount} Review</span>
      </button>

      <TasksDropdown taskGroups={taskGroups} isOpen={isOpen} onClose={() => setIsOpen(false)} onDismiss={onDismissTask} />
    </div>
  );
};

interface SystemHealthProps { systemHealth: HeaderStats['systemHealth']; }

export const SystemHealth: React.FC<SystemHealthProps> = ({ systemHealth }) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setIsOpen(false);
    };
    if (isOpen) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);
  const getStatusColor = (status?: string): string => {
    if (!status) return 'bg-gray-400';
    const lower = status.toLowerCase();
    return (lower === 'running' || lower === 'connected' || lower === 'authenticated') ? 'bg-green-500' : 'bg-red-500';
  };
  const getOverallHealthColor = (): string => {
    if (systemHealth.isHealthy) return 'bg-green-500';
    const statuses = [systemHealth.daemon, systemHealth.redis, systemHealth.githubAuth];
    const anyDown = statuses.some(s => !['running', 'connected', 'authenticated'].includes(s?.toLowerCase() || ''));
    if (anyDown) return systemHealth.daemon?.toLowerCase() !== 'running' ? 'bg-red-500' : 'bg-amber-500';
    return 'bg-gray-400';
  };

  return (
    <div className="relative" ref={containerRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        onMouseEnter={() => setIsOpen(true)}
        className="flex items-center gap-1.5 p-2 rounded-lg hover:bg-gray-100 transition-colors"
        aria-label="System Status"
      >
        <Activity className="w-4 h-4 text-gray-500" />
        <span className={`w-2 h-2 rounded-full ${getOverallHealthColor()}`} />
      </button>

      {isOpen && (
        <div
          className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg py-2 px-3 min-w-[160px] z-50"
          onMouseLeave={() => setIsOpen(false)}
        >
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">System Status</div>
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 text-sm text-gray-700">
              <span className={`w-2 h-2 rounded-full ${getStatusColor(systemHealth.daemon)}`} />
              <span>Daemon:</span>
              <span className="ml-auto font-medium">{systemHealth.daemon || 'Unknown'}</span>
            </div>
            <div className="flex items-center gap-2 text-sm text-gray-700">
              <span className={`w-2 h-2 rounded-full ${getStatusColor(systemHealth.redis)}`} />
              <span>Redis:</span>
              <span className="ml-auto font-medium">{systemHealth.redis || 'Unknown'}</span>
            </div>
            <div className="flex items-center gap-2 text-sm text-gray-700">
              <span className={`w-2 h-2 rounded-full ${getStatusColor(systemHealth.githubAuth)}`} />
              <span>GitHub:</span>
              <span className="ml-auto font-medium">{systemHealth.githubAuth || 'Unknown'}</span>
            </div>
            <div className="flex items-center gap-2 text-sm text-gray-700">
              <span className={`w-2 h-2 rounded-full ${getStatusColor(systemHealth.claudeAuth)}`} />
              <span>Claude:</span>
              <span className="ml-auto font-medium">{systemHealth.claudeAuth || 'Unknown'}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

interface ActivePlansButtonProps { activePlans: DraftListItem[]; onDismissPlan: (planId: string) => void; }

export const ActivePlansButton: React.FC<ActivePlansButtonProps> = ({ activePlans, onDismissPlan }) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setIsOpen(false);
    };
    if (isOpen) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);
  return (
    <div className="relative" ref={containerRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-teal-50 text-teal-700 border border-teal-100 rounded-full text-xs font-medium hover:bg-teal-100 transition-colors"
      >
        <RefreshCw className={`w-3.5 h-3.5 text-teal-600 ${activePlans.length > 0 ? 'animate-spin' : ''}`} style={{ animationDuration: '3s' }} />
        <span>{activePlans.length} Active</span>
      </button>

      <PlansDropdown activePlans={activePlans} isOpen={isOpen} onClose={() => setIsOpen(false)} onDismiss={onDismissPlan} />
    </div>
  );
};
