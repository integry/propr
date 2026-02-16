import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Activity, Users, X, Inbox, CornerDownRight, ScrollText, ListTodo } from 'lucide-react';
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
      <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ScrollText className="w-4 h-4 text-teal-600" />
          <span className="text-slate-500 font-bold text-[10px] uppercase tracking-wider">
            ACTIVE PLANS
          </span>
          <span className="font-bold text-slate-700">
            ({activePlans.length})
          </span>
        </div>
      </div>

      <div className="max-h-80 overflow-y-auto scrollbar-stealth">
        {displayPlans.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-gray-500">
            No active plans
          </div>
        ) : (
          displayPlans.map((plan, index) => (
            <div
              key={plan.draft_id}
              className={`px-4 py-3 hover:bg-slate-100 transition-colors group cursor-pointer ${
                index < displayPlans.length - 1 ? 'border-b border-slate-200' : ''
              }`}
              onClick={() => handlePlanClick(plan.draft_id)}
            >
              {/* Top Row: Repo • Status (right-aligned: Time) */}
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs text-gray-500">
                  {getRepoName(plan.repository)}
                </span>
                <span className="text-gray-300">•</span>
                <span className={`px-1.5 py-0.5 text-xs font-mono ${getStatusBadgeStyle(plan.status)}`}>
                  {plan.status}
                </span>
                <span className="text-xs text-gray-400 ml-auto">
                  {formatTimeAgo(plan.updated_at || plan.created_at)}
                </span>
                {/* Dismiss button */}
                <button
                  onClick={(e) => handleDismiss(e, plan.draft_id)}
                  className="p-1 hover:bg-slate-200 transition-colors flex-shrink-0 opacity-0 group-hover:opacity-100"
                  title="Dismiss"
                >
                  <X className="w-3.5 h-3.5 text-gray-400 hover:text-gray-600" />
                </button>
              </div>
              {/* Bottom Row: Plan Title (Normal weight, Truncated) */}
              <div className="flex items-center gap-1.5">
                <span className="text-sm text-gray-900 truncate group-hover:text-primary-600">
                  {plan.name || plan.initial_prompt}
                </span>
              </div>
            </div>
          ))
        )}
      </div>

      {activePlans.length > 0 && (
        <div className="px-4 py-2.5 bg-slate-50 border-t border-slate-200">
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

export const MachineStatus: React.FC<{ runningCount: number }> = ({ runningCount }) => {
  if (runningCount === 0) return null;
  return (<div className="flex items-center gap-1.5 px-2.5 py-1 bg-blue-50 border border-blue-200"><div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" /><Users className="w-3.5 h-3.5 text-blue-600" /><span className="text-xs font-medium text-blue-700">{runningCount}</span></div>);
};

export const HumanInbox: React.FC<{ reviewCount: number }> = ({ reviewCount }) => {
  if (reviewCount === 0) return null;
  return (<div className="flex items-center gap-1.5 px-2.5 py-1 bg-amber-50 border border-amber-200"><Inbox className="w-3.5 h-3.5 text-amber-600" /><span className="text-xs font-medium text-amber-700">{reviewCount}</span></div>);
};

interface TasksDropdownProps { taskGroups: TaskGroup[]; isOpen: boolean; onClose: () => void; onDismiss: (taskId: string) => void; }

const TasksDropdown: React.FC<TasksDropdownProps> = ({ taskGroups, isOpen, onClose, onDismiss }) => {
  const navigate = useNavigate();
  const displayGroups = taskGroups.slice(0, 10);
  const handleTaskClick = (group: TaskGroup) => { onClose(); if (group.prNumber) navigate(`/tasks?pr=${group.prNumber}&repo=${group.repoOwner}/${group.repoName}`); else if (group.issueNumber) navigate(`/tasks?issue=${group.issueNumber}&repo=${group.repoOwner}/${group.repoName}`); else navigate(`/tasks/${group.latestTask.id}`); };
  const handleViewAll = () => { onClose(); navigate('/tasks'); };
  const handleDismiss = (e: React.MouseEvent, taskId: string) => { e.stopPropagation(); onDismiss(taskId); };
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
      <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ListTodo className="w-4 h-4 text-blue-600" />
          <span className="text-slate-500 font-bold text-[10px] uppercase tracking-wider">
            PENDING REVIEW
          </span>
          <span className="font-bold text-slate-700">
            ({taskGroups.length})
          </span>
        </div>
      </div>

      <div className="max-h-[600px] overflow-y-auto scrollbar-stealth">
        {displayGroups.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-gray-500">
            No tasks needing review
          </div>
        ) : (
          displayGroups.map((group, index) => (
            <div
              key={group.key}
              className={`px-4 py-4 hover:bg-slate-100 transition-colors group cursor-pointer ${
                index < displayGroups.length - 1 ? 'border-b border-slate-200' : ''
              }`}
              onClick={() => handleTaskClick(group)}
            >
              {/* Top Row: Repo • ID (Chip) (right-aligned: Time) */}
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs text-gray-500">
                  {group.repoName}
                </span>
                {getIssueId(group) && (
                  <>
                    <span className="text-gray-300">•</span>
                    <span className="px-1.5 py-0.5 bg-gray-100 border border-gray-200 text-xs font-mono text-gray-700">
                      {getIssueId(group)}
                    </span>
                  </>
                )}
                <span className="text-xs text-gray-400 ml-auto">
                  {formatTimeAgo(group.latestTask.createdAt)}
                </span>
                {/* Dismiss button */}
                <button
                  onClick={(e) => handleDismiss(e, group.latestTask.id)}
                  className="p-1 hover:bg-slate-200 transition-colors flex-shrink-0 opacity-0 group-hover:opacity-100"
                  title="Dismiss"
                >
                  <X className="w-3.5 h-3.5 text-gray-400 hover:text-gray-600" />
                </button>
              </div>
              {/* Bottom Row: Icon (if followup) + Title (Normal weight, Truncated) */}
              <div className="flex items-center gap-1.5">
                {isFollowUp(group) && (
                  <CornerDownRight className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
                )}
                <span className="text-sm text-gray-900 truncate group-hover:text-primary-600">
                  {cleanTaskTitle(group.latestTask.title) || 'Untitled'}
                </span>
              </div>
            </div>
          ))
        )}
      </div>

      {taskGroups.length > 0 && (
        <div className="px-4 py-2.5 bg-slate-50 border-t border-slate-200">
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

export const TasksButton: React.FC<{ taskGroups: TaskGroup[]; onDismissTask: (taskId: string) => void }> = ({ taskGroups, onDismissTask }) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useClickOutside(() => setIsOpen(false), isOpen);
  return (
    <div className="relative h-full" ref={containerRef}>
      <button onClick={() => setIsOpen(!isOpen)} className={`flex items-center gap-2 px-4 h-full text-sm transition-colors ${isOpen ? 'bg-white border-b-2 border-b-blue-600' : 'hover:bg-slate-50'}`}>
        <ListTodo className="w-4 h-4 text-slate-600" /><span className="font-bold text-slate-900">{taskGroups.length}</span><span className="text-slate-600 uppercase text-xs tracking-wide">Tasks</span>
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
    <div className="relative" ref={containerRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        onMouseEnter={() => setIsOpen(true)}
        className="flex items-center gap-1.5 p-2 hover:bg-slate-100 transition-colors"
        aria-label="System Status"
      >
        <Activity className="w-4 h-4 text-gray-500" />
        <span className={`w-2 h-2 rounded-full ${getOverallHealthColor()}`} />
      </button>

      {isOpen && (
        <div
          className="absolute right-0 top-full mt-1 bg-white border border-slate-400 py-2 px-3 min-w-[160px] z-[100]"
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

export const ActivePlansButton: React.FC<{ activePlans: DraftListItem[]; onDismissPlan: (planId: string) => void }> = ({ activePlans, onDismissPlan }) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useClickOutside(() => setIsOpen(false), isOpen);
  return (
    <div className="relative h-full" ref={containerRef}>
      <button onClick={() => setIsOpen(!isOpen)} className={`flex items-center gap-2 px-4 h-full text-sm transition-colors ${isOpen ? 'bg-white border-b-2 border-b-teal-600' : 'hover:bg-slate-50'}`}>
        <ScrollText className="w-4 h-4 text-slate-600" /><span className="font-bold text-slate-900">{activePlans.length}</span><span className="text-slate-600 uppercase text-xs tracking-wide">Plans</span>
      </button>
      <PlansDropdown activePlans={activePlans} isOpen={isOpen} onClose={() => setIsOpen(false)} onDismiss={onDismissPlan} />
    </div>
  );
};
