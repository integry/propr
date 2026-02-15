import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Activity, ScrollText, Users, Inbox, ChevronDown, ExternalLink, ListTodo } from 'lucide-react';
import { HeaderStats } from '../hooks/useHeaderStats';
import { DraftListItem } from '../api/plannerApi';
import { getStatusBadgeStyle, formatRelativeTime } from './headerUtils';

// Task group interface (matches useHeaderStats)
interface TaskGroup {
  key: string;
  repoOwner: string;
  repoName: string;
  prNumber?: number;
  issueNumber?: number;
  latestTask: {
    id: string;
    status: string;
    createdAt: string;
    title?: string;
  };
  allTasks: unknown[];
}

// Plans Dropdown Component
interface PlansDropdownProps {
  activePlans: DraftListItem[];
  isOpen: boolean;
  onClose: () => void;
}

const PlansDropdown: React.FC<PlansDropdownProps> = ({ activePlans, isOpen, onClose }) => {
  const navigate = useNavigate();

  // Limit to top 10 most recently updated plans
  const displayPlans = activePlans.slice(0, 10);

  const handlePlanClick = (draftId: string) => {
    onClose();
    navigate(`/studio/${draftId}`);
  };

  const handleViewAll = () => {
    onClose();
    navigate('/plans');
  };

  if (!isOpen) return null;

  return (
    <div className="absolute right-0 top-full mt-2 w-80 bg-white border border-gray-200 rounded-lg shadow-lg z-50 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 bg-gray-50">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-gray-700">Active Plans</span>
          <span className="text-xs text-gray-500">{activePlans.length} total</span>
        </div>
      </div>

      <div className="max-h-96 overflow-y-auto">
        {displayPlans.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-gray-500">
            No active plans
          </div>
        ) : (
          displayPlans.map((plan) => (
            <button
              key={plan.draft_id}
              onClick={() => handlePlanClick(plan.draft_id)}
              className="w-full px-4 py-3 text-left hover:bg-gray-50 border-b border-gray-100 last:border-b-0 transition-colors group"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm text-gray-900 truncate group-hover:text-primary-600">
                    {plan.name || plan.initial_prompt.slice(0, 50) + (plan.initial_prompt.length > 50 ? '...' : '')}
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${getStatusBadgeStyle(plan.status)}`}>
                      {plan.status}
                    </span>
                    <span className="text-xs text-gray-500 truncate">
                      {plan.repository}
                    </span>
                  </div>
                  <div className="text-xs text-gray-400 mt-1">
                    Updated {formatRelativeTime(plan.updated_at)}
                  </div>
                </div>
                <ExternalLink className="w-4 h-4 text-gray-400 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 mt-0.5" />
              </div>
            </button>
          ))
        )}
      </div>

      {activePlans.length > 0 && (
        <div className="px-4 py-2 border-t border-gray-100 bg-gray-50">
          <button
            onClick={handleViewAll}
            className="w-full text-center text-sm font-medium text-primary-600 hover:text-primary-700 py-1"
          >
            View All Plans
          </button>
        </div>
      )}
    </div>
  );
};

// Machine Status Pill (Blue - Running Agents)
interface MachineStatusProps {
  runningCount: number;
}

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

// Human Inbox Pill (Amber - Review Items) - Now a simple indicator
interface HumanInboxProps {
  reviewCount: number;
}

export const HumanInbox: React.FC<HumanInboxProps> = ({ reviewCount }) => {
  if (reviewCount === 0) return null;

  return (
    <div className="flex items-center gap-1.5 px-2.5 py-1 bg-amber-50 border border-amber-200 rounded-full">
      <Inbox className="w-3.5 h-3.5 text-amber-600" />
      <span className="text-xs font-medium text-amber-700">{reviewCount}</span>
    </div>
  );
};

// Tasks Dropdown Component
interface TasksDropdownProps {
  taskGroups: TaskGroup[];
  isOpen: boolean;
  onClose: () => void;
}

const TasksDropdown: React.FC<TasksDropdownProps> = ({ taskGroups, isOpen, onClose }) => {
  const navigate = useNavigate();

  // Limit to top 10 most recently updated task groups
  const displayGroups = taskGroups.slice(0, 10);

  const handleTaskClick = (group: TaskGroup) => {
    onClose();
    // Navigate to tasks page with the specific task or PR
    if (group.prNumber) {
      navigate(`/tasks?pr=${group.prNumber}&repo=${group.repoOwner}/${group.repoName}`);
    } else if (group.issueNumber) {
      navigate(`/tasks?issue=${group.issueNumber}&repo=${group.repoOwner}/${group.repoName}`);
    } else {
      navigate(`/tasks/${group.latestTask.id}`);
    }
  };

  const handleViewAll = () => {
    onClose();
    navigate('/tasks');
  };

  if (!isOpen) return null;

  return (
    <div className="absolute right-0 top-full mt-2 w-80 bg-white border border-gray-200 rounded-lg shadow-lg z-50 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 bg-gray-50">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-gray-700">Tasks Needing Review</span>
          <span className="text-xs text-gray-500">{taskGroups.length} total</span>
        </div>
      </div>

      <div className="max-h-96 overflow-y-auto">
        {displayGroups.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-gray-500">
            No tasks needing review
          </div>
        ) : (
          displayGroups.map((group) => (
            <button
              key={group.key}
              onClick={() => handleTaskClick(group)}
              className="w-full px-4 py-3 text-left hover:bg-gray-50 border-b border-gray-100 last:border-b-0 transition-colors group"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm text-gray-900 truncate group-hover:text-primary-600">
                    {group.latestTask.title || `${group.repoOwner}/${group.repoName}`}
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${
                      group.latestTask.status === 'failed'
                        ? 'bg-red-100 text-red-700'
                        : 'bg-green-100 text-green-700'
                    }`}>
                      {group.latestTask.status}
                    </span>
                    <span className="text-xs text-gray-500 truncate">
                      {group.prNumber ? `PR #${group.prNumber}` : group.issueNumber ? `Issue #${group.issueNumber}` : ''}
                    </span>
                  </div>
                  <div className="text-xs text-gray-400 mt-1">
                    {group.repoOwner}/{group.repoName}
                  </div>
                </div>
                <ExternalLink className="w-4 h-4 text-gray-400 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 mt-0.5" />
              </div>
            </button>
          ))
        )}
      </div>

      {taskGroups.length > 0 && (
        <div className="px-4 py-2 border-t border-gray-100 bg-gray-50">
          <button
            onClick={handleViewAll}
            className="w-full text-center text-sm font-medium text-primary-600 hover:text-primary-700 py-1"
          >
            View All Tasks
          </button>
        </div>
      )}
    </div>
  );
};

// Tasks Button with Dropdown
interface TasksButtonProps {
  taskGroups: TaskGroup[];
}

export const TasksButton: React.FC<TasksButtonProps> = ({ taskGroups }) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const handleToggle = () => {
    setIsOpen(!isOpen);
  };

  const handleClose = () => {
    setIsOpen(false);
  };

  const reviewCount = taskGroups.length;

  return (
    <div className="relative" ref={containerRef}>
      <button
        onClick={handleToggle}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border transition-colors ${
          reviewCount > 0
            ? 'bg-amber-50 border-amber-200 hover:bg-amber-100'
            : 'bg-gray-50 border-gray-200 hover:bg-gray-100'
        }`}
      >
        <ListTodo className={`w-4 h-4 ${reviewCount > 0 ? 'text-amber-600' : 'text-gray-500'}`} />
        <span className={`text-sm font-medium ${reviewCount > 0 ? 'text-amber-700' : 'text-gray-600'}`}>
          {reviewCount}
        </span>
        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${
          reviewCount > 0 ? 'text-amber-600' : 'text-gray-500'
        } ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      <TasksDropdown
        taskGroups={taskGroups}
        isOpen={isOpen}
        onClose={handleClose}
      />
    </div>
  );
};

// System Health Indicator
interface SystemHealthProps {
  systemHealth: HeaderStats['systemHealth'];
}

export const SystemHealth: React.FC<SystemHealthProps> = ({ systemHealth }) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const getStatusColor = (status?: string): string => {
    if (!status) return 'bg-gray-400';
    const lowerStatus = status.toLowerCase();
    if (lowerStatus === 'running' || lowerStatus === 'connected' || lowerStatus === 'authenticated') {
      return 'bg-green-500';
    }
    return 'bg-red-500';
  };

  const getOverallHealthColor = (): string => {
    if (systemHealth.isHealthy) return 'bg-green-500';

    const statuses = [systemHealth.daemon, systemHealth.redis, systemHealth.githubAuth];
    const anyDown = statuses.some(s => {
      const lower = s?.toLowerCase() || '';
      return !['running', 'connected', 'authenticated'].includes(lower);
    });

    if (anyDown) {
      if (systemHealth.daemon?.toLowerCase() !== 'running') {
        return 'bg-red-500';
      }
      return 'bg-amber-500';
    }
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

// Active Plans Button with Dropdown
interface ActivePlansButtonProps {
  activePlans: DraftListItem[];
}

export const ActivePlansButton: React.FC<ActivePlansButtonProps> = ({ activePlans }) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const handleToggle = () => {
    setIsOpen(!isOpen);
  };

  const handleClose = () => {
    setIsOpen(false);
  };

  return (
    <div className="relative" ref={containerRef}>
      <button
        onClick={handleToggle}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border transition-colors ${
          activePlans.length > 0
            ? 'bg-teal-50 border-teal-200 hover:bg-teal-100'
            : 'bg-gray-50 border-gray-200 hover:bg-gray-100'
        }`}
      >
        <ScrollText className={`w-4 h-4 ${activePlans.length > 0 ? 'text-teal-600' : 'text-gray-500'}`} />
        <span className={`text-sm font-medium ${activePlans.length > 0 ? 'text-teal-700' : 'text-gray-600'}`}>
          {activePlans.length}
        </span>
        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${
          activePlans.length > 0 ? 'text-teal-600' : 'text-gray-500'
        } ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      <PlansDropdown
        activePlans={activePlans}
        isOpen={isOpen}
        onClose={handleClose}
      />
    </div>
  );
};
