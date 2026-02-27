import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Activity, Users, X, Inbox, CornerDownRight, ScrollText, ListTodo, CheckCircle, Rocket } from 'lucide-react';
import { HeaderStats } from '../hooks/useHeaderStats';
import { DraftListItem } from '../api/plannerApi';
import { getStatusBadgeStyle } from './headerUtils';

interface TaskGroup { key: string; repoOwner: string; repoName: string; prNumber?: number; issueNumber?: number; latestTask: { id: string; status: string; createdAt: string; title?: string; }; allTasks: unknown[]; }

// Shared utility functions
const formatTimeAgo = (dateString: string): string => {
  const diffMins = Math.floor((Date.now() - new Date(dateString).getTime()) / 60000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
};
const useClickOutside = (onClose: () => void, isOpen: boolean) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    if (isOpen) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen, onClose]);
  return ref;
};

interface PlansDropdownProps { activePlans: DraftListItem[]; isOpen: boolean; onClose: () => void; onDismiss: (planId: string) => void; }

const PlansDropdown: React.FC<PlansDropdownProps> = ({ activePlans, isOpen, onClose, onDismiss }) => {
  const navigate = useNavigate();
  const displayPlans = activePlans.slice(0, 10);
  const handlePlanClick = (draftId: string) => { onClose(); navigate(`/studio/${draftId}`); };
  const handleViewAll = () => { onClose(); navigate('/plans'); };
  const handleDismiss = (e: React.MouseEvent, planId: string) => { e.stopPropagation(); onDismiss(planId); };
  if (!isOpen) return null;
  const getRepoName = (repository: string): string => { const parts = repository.split('/'); return parts.length > 1 ? parts[1] : repository; };

  return (
    <div
      className="fixed w-[600px] bg-white border border-slate-200 border-t-0 shadow-xl ring-1 ring-black/5 z-50 overflow-hidden"
      style={{
        top: '64px',
        left: '240px',
      }}
    >
      {/* Header with View All link moved to top-right */}
      <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200">
        <div className="flex items-baseline justify-between">
          <div className="flex items-baseline gap-2">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
              PLANS IN FOCUS
            </span>
            <span className="text-[10px] font-bold text-slate-400">
              ({activePlans.length})
            </span>
          </div>
          {activePlans.length > 0 && (
            <button
              onClick={handleViewAll}
              className="text-[10px] text-slate-400 hover:text-primary-600 transition-colors"
            >
              View All &rarr;
            </button>
          )}
        </div>
      </div>

      {/* Scrollable content with increased max-height (600px) */}
      <div className="max-h-[600px] overflow-y-auto scrollbar-stealth">
        {displayPlans.length === 0 ? (
          <div className="px-4 py-8 text-center flex flex-col items-center gap-4">
            <CheckCircle className="w-8 h-8 text-slate-200" />
            <div>
              <p className="text-sm font-medium text-slate-700">All caught up.</p>
              <p className="text-xs text-slate-400 mt-0.5">You don't have any active implementation plans.</p>
            </div>
            <button
              onClick={() => { onClose(); navigate('/studio/new'); }}
              className="flex items-center gap-2 px-4 py-2 bg-teal-600 text-white text-sm font-medium hover:bg-teal-700 transition-colors"
            >
              <ScrollText className="w-4 h-4" />
              <span>+ Generate AI Plan</span>
            </button>
            <button
              onClick={handleViewAll}
              className="text-xs text-slate-500 hover:text-slate-700 transition-colors"
            >
              View plan history &rarr;
            </button>
          </div>
        ) : (
          displayPlans.map((plan, index) => (
            <div
              key={plan.draft_id}
              className={`px-4 py-2.5 hover:bg-slate-50 transition-colors group cursor-pointer border-b border-slate-50 overflow-hidden ${
                index === displayPlans.length - 1 ? 'border-b-0' : ''
              }`}
              onClick={() => handlePlanClick(plan.draft_id)}
            >
              {/* Line 1 (Meta): Repo • Status Badge ... Time Ago (right-aligned) */}
              <div className="flex items-center gap-2 mb-0.5">
                <span className="text-xs font-normal text-slate-500">
                  {getRepoName(plan.repository)}
                </span>
                <span className="text-slate-300">•</span>
                <span className={`px-1.5 py-0.5 text-xs font-mono font-normal ${getStatusBadgeStyle(plan.status)}`}>
                  {plan.status}
                </span>
                <span className="text-xs font-normal text-slate-500 ml-auto">
                  {formatTimeAgo(plan.updated_at || plan.created_at)}
                </span>
                {/* Dismiss button */}
                <button
                  onClick={(e) => handleDismiss(e, plan.draft_id)}
                  className="p-1 hover:bg-slate-200 transition-colors flex-shrink-0 opacity-0 group-hover:opacity-100"
                  title="Dismiss"
                >
                  <X className="w-3.5 h-3.5 text-slate-400 hover:text-slate-600" />
                </button>
              </div>
              {/* Line 2 (Content): Full-width Title with CSS ellipsis truncation */}
              <div className="w-full min-w-0">
                <p className="text-sm font-medium text-slate-900 truncate group-hover:text-primary-600">
                  {plan.name || plan.initial_prompt}
                </p>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export const MachineStatus: React.FC<{ runningCount: number }> = ({ runningCount }) => {
  if (runningCount === 0) return null;
  return (<div className="flex items-center gap-1.5 px-2.5 py-1 bg-blue-50 border border-blue-200"><div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" /><Users className="w-3.5 h-3.5 text-blue-600" /><span className="text-xs font-medium text-blue-700">{runningCount}</span></div>);
};

export const HumanInbox: React.FC<{ reviewCount: number }> = ({ reviewCount }) => {
  if (reviewCount === 0) return null;
  return (<div className="flex items-center gap-1.5 px-2.5 py-1 bg-amber-50 border border-amber-200"><Inbox className="w-3.5 h-3.5 text-amber-600" /><span className="text-xs font-medium text-amber-700">{reviewCount}</span></div>);
};

interface TasksDropdownProps { taskGroups: TaskGroup[]; isOpen: boolean; onClose: () => void; onDismiss: (taskGroupKey: string, latestTaskCreatedAt: string) => void; }

const TasksDropdown: React.FC<TasksDropdownProps> = ({ taskGroups, isOpen, onClose, onDismiss }) => {
  const navigate = useNavigate();
  const displayGroups = taskGroups.slice(0, 10);
  const handleTaskClick = (group: TaskGroup) => { onClose(); navigate(`/tasks/${group.latestTask.id}`); };
  const handleViewAll = () => { onClose(); navigate('/tasks'); };
  // Pass the group key and latest task timestamp to auto-dismiss older followup tasks
  const handleDismiss = (e: React.MouseEvent, group: TaskGroup) => { e.stopPropagation(); onDismiss(group.key, group.latestTask.createdAt); };
  if (!isOpen) return null;
  const getIssueId = (group: TaskGroup): string => { if (group.prNumber) return `#${group.prNumber}`; if (group.issueNumber) return `#${group.issueNumber}`; return ''; };
  const isFollowUp = (group: TaskGroup): boolean => !!group.prNumber;
  const cleanTaskTitle = (title?: string): string => { if (!title) return ''; return title.replace(/^Followup:\s*/i, '').replace(/^\[.*?\]\s*/g, '').trim(); };

  return (
    <div
      className="fixed w-[600px] bg-white border border-slate-200 border-t-0 shadow-xl ring-1 ring-black/5 z-50 overflow-hidden"
      style={{
        top: '64px',
        left: '240px',
      }}
    >
      {/* Header with View All link moved to top-right */}
      <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200">
        <div className="flex items-baseline justify-between">
          <div className="flex items-baseline gap-2">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
              TASKS IN FOCUS
            </span>
            <span className="text-[10px] font-bold text-slate-400">
              ({taskGroups.length})
            </span>
          </div>
          {taskGroups.length > 0 && (
            <button
              onClick={handleViewAll}
              className="text-[10px] text-slate-400 hover:text-primary-600 transition-colors"
            >
              View All &rarr;
            </button>
          )}
        </div>
      </div>

      {/* Scrollable content with max-height 600px */}
      <div className="max-h-[600px] overflow-y-auto scrollbar-stealth">
        {displayGroups.length === 0 ? (
          <div className="px-4 py-8 text-center flex flex-col items-center gap-4">
            <CheckCircle className="w-8 h-8 text-slate-200" />
            <div>
              <p className="text-sm font-medium text-slate-700">All tasks completed.</p>
              <p className="text-xs text-slate-400 mt-0.5">Ready for the next implementation?</p>
            </div>
            <button
              onClick={() => { onClose(); navigate('/plans'); }}
              className="flex items-center gap-2 px-4 py-2 bg-teal-600 text-white text-sm font-medium hover:bg-teal-700 transition-colors"
            >
              <Rocket className="w-4 h-4" />
              <span>Implement a Plan</span>
            </button>
            <button
              onClick={handleViewAll}
              className="text-xs text-slate-500 hover:text-slate-700 transition-colors"
            >
              View task history &rarr;
            </button>
          </div>
        ) : (
          displayGroups.map((group, index) => (
            <div
              key={group.key}
              className={`px-4 py-2.5 hover:bg-slate-50 transition-colors group cursor-pointer border-b border-slate-50 overflow-hidden ${
                index === displayGroups.length - 1 ? 'border-b-0' : ''
              }`}
              onClick={() => handleTaskClick(group)}
            >
              {/* Line 1 (Meta): Repo • ID (Chip) ... Time Ago (right-aligned) */}
              <div className="flex items-center gap-2 mb-0.5">
                <span className="text-xs font-normal text-slate-500">
                  {group.repoName}
                </span>
                {getIssueId(group) && (
                  <>
                    <span className="text-slate-300">•</span>
                    <span className="px-1.5 py-0.5 bg-slate-100 border border-slate-200 text-xs font-mono font-normal text-slate-500">
                      {getIssueId(group)}
                    </span>
                  </>
                )}
                <span className="text-xs font-normal text-slate-500 ml-auto">
                  {formatTimeAgo(group.latestTask.createdAt)}
                </span>
                {/* Dismiss button */}
                <button
                  onClick={(e) => handleDismiss(e, group)}
                  className="p-1 hover:bg-slate-200 transition-colors flex-shrink-0 opacity-0 group-hover:opacity-100"
                  title="Dismiss"
                >
                  <X className="w-3.5 h-3.5 text-slate-400 hover:text-slate-600" />
                </button>
              </div>
              {/* Line 2 (Content): Full-width Title with CSS ellipsis truncation */}
              <div className="flex items-center gap-1.5 min-w-0 w-full">
                {isFollowUp(group) && (
                  <CornerDownRight className="w-3.5 h-3.5 text-slate-300 flex-shrink-0" />
                )}
                <p className="text-sm font-medium text-slate-900 truncate flex-1 min-w-0 group-hover:text-primary-600">
                  {cleanTaskTitle(group.latestTask.title) || 'Untitled'}
                </p>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export const TasksButton: React.FC<{ taskGroups: TaskGroup[]; onDismissTask: (taskGroupKey: string, latestTaskCreatedAt: string) => void }> = ({ taskGroups, onDismissTask }) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useClickOutside(() => setIsOpen(false), isOpen);
  return (
    <div className="relative h-full" ref={containerRef}>
      <button onClick={() => setIsOpen(!isOpen)} className={`relative flex items-center gap-1.5 px-4 h-full text-sm transition-colors ${isOpen ? 'bg-white' : 'hover:bg-slate-50'}`}>
        <ListTodo className="w-4 h-4 text-slate-600" /><span className="font-bold text-slate-900">{taskGroups.length}</span><span className="text-slate-600 text-sm">{taskGroups.length === 1 ? 'Task' : 'Tasks'}</span>
        {isOpen && <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-blue-600" />}
      </button>
      <TasksDropdown taskGroups={taskGroups} isOpen={isOpen} onClose={() => setIsOpen(false)} onDismiss={onDismissTask} />
    </div>
  );
};

export const SystemHealth: React.FC<{ systemHealth: HeaderStats['systemHealth'] }> = ({ systemHealth }) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useClickOutside(() => setIsOpen(false), isOpen);
  const getStatusColor = (status?: string): string => { if (!status) return 'bg-gray-400'; const lower = status.toLowerCase(); return (lower === 'running' || lower === 'connected' || lower === 'authenticated') ? 'bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.6)]' : 'bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.6)]'; };
  const getOverallHealthColor = (): string => { if (systemHealth.isHealthy) return 'bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.6)]'; const statuses = [systemHealth.daemon, systemHealth.redis, systemHealth.githubAuth]; const anyDown = statuses.some(s => !['running', 'connected', 'authenticated'].includes(s?.toLowerCase() || '')); if (anyDown) return systemHealth.daemon?.toLowerCase() !== 'running' ? 'bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.6)]' : 'bg-amber-500 shadow-[0_0_6px_rgba(245,158,11,0.6)]'; return 'bg-gray-400'; };

  return (
    <div
      className="relative h-full"
      ref={containerRef}
      onMouseEnter={() => setIsOpen(true)}
      onMouseLeave={() => setIsOpen(false)}
    >
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`relative flex items-center gap-1.5 px-3 h-full text-sm transition-colors ${isOpen ? 'bg-white' : 'hover:bg-slate-50'}`}
        aria-label="System Status"
      >
        <Activity className="w-4 h-4 text-slate-600" />
        <span className={`w-2 h-2 rounded-full ${getOverallHealthColor()}`} />
        {isOpen && <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-slate-600" />}
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full bg-white border border-slate-200 border-t-0 shadow-xl ring-1 ring-black/5 min-w-[200px] z-[100]">
          {/* Header section matching other dropdowns */}
          <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
              SYSTEM STATUS
            </span>
          </div>
          {/* Content */}
          <div className="px-4 py-3 space-y-2">
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

export const ActivePlansButton: React.FC<{ activePlans: DraftListItem[]; onDismissPlan: (planId: string) => void }> = ({ activePlans, onDismissPlan }) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useClickOutside(() => setIsOpen(false), isOpen);
  return (
    <div className="relative h-full" ref={containerRef}>
      <button onClick={() => setIsOpen(!isOpen)} className={`relative flex items-center gap-1.5 px-4 h-full text-sm transition-colors ${isOpen ? 'bg-white' : 'hover:bg-slate-50'}`}>
        <ScrollText className="w-4 h-4 text-slate-600" /><span className="font-bold text-slate-900">{activePlans.length}</span><span className="text-slate-600 text-sm">{activePlans.length === 1 ? 'Plan' : 'Plans'}</span>
        {isOpen && <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-teal-600" />}
      </button>
      <PlansDropdown activePlans={activePlans} isOpen={isOpen} onClose={() => setIsOpen(false)} onDismiss={onDismissPlan} />
    </div>
  );
};
