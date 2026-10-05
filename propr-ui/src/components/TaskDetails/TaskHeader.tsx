import React from 'react';
import { TaskInfo } from './types';
import { getDisplayTitle, getSubtitle } from './taskHeaderText';
import { formatRelativeTime } from '../TaskList/utils.tsx';
import { CheckCircle2, XCircle, Loader2, Clock, Play, GitPullRequest, Eye, Wrench, RefreshCw, History, ArrowRight } from 'lucide-react';

interface TaskHeaderProps {
  taskInfo: TaskInfo | null;
  currentStatus: string;
}

const getStatusInfo = (status: string, commandMode?: string): { icon: React.ReactNode; label: string; color: string; bgColor: string } => {
  const normalizedStatus = status?.toUpperCase() || '';

  if (normalizedStatus === 'COMPLETED') {
    return {
      icon: <CheckCircle2 className="h-4 w-4 text-green-600" />,
      label: 'Completed',
      color: 'text-green-700',
      bgColor: 'bg-green-50'
    };
  }

  if (normalizedStatus === 'FAILED') {
    return {
      icon: <XCircle className="h-4 w-4 text-red-600" />,
      label: 'Failed',
      color: 'text-red-700',
      bgColor: 'bg-red-50'
    };
  }

  if (normalizedStatus === 'PENDING') {
    return {
      icon: <Clock className="h-4 w-4 text-gray-500" />,
      label: 'Queued',
      color: 'text-gray-600',
      bgColor: 'bg-gray-100'
    };
  }

  if (normalizedStatus === 'PROCESSING') {
    return {
      icon: <Loader2 className="h-4 w-4 text-blue-600 animate-spin" />,
      label: 'Analyzing',
      color: 'text-blue-700',
      bgColor: 'bg-blue-50'
    };
  }

  if (normalizedStatus === 'CLAUDE_EXECUTION' || normalizedStatus === 'CLAUDE_EXECUTION_STARTED') {
    return {
      icon: <Play className="h-4 w-4 text-blue-600 animate-pulse" />,
      label: commandMode === 'review' ? 'Reviewing' : commandMode === 'fix' ? 'Fixing' : 'Implementing',
      color: 'text-blue-700',
      bgColor: 'bg-blue-50'
    };
  }

  if (normalizedStatus === 'CLAUDE_EXECUTION_COMPLETED') {
    return {
      icon: <CheckCircle2 className="h-4 w-4 text-green-600" />,
      label: commandMode === 'review' ? 'Review Done' : commandMode === 'fix' ? 'Fix Done' : 'Implementation Done',
      color: 'text-green-700',
      bgColor: 'bg-green-50'
    };
  }

  if (normalizedStatus === 'POST_PROCESSING') {
    return {
      icon: <GitPullRequest className="h-4 w-4 text-purple-600 animate-pulse" />,
      label: 'Creating PR',
      color: 'text-purple-700',
      bgColor: 'bg-purple-50'
    };
  }

  // Default
  return {
    icon: <Clock className="h-4 w-4 text-gray-500" />,
    label: status || 'Unknown',
    color: 'text-gray-600',
    bgColor: 'bg-gray-100'
  };
};

const getCommandModeBadge = (commandMode?: string): { icon: React.ReactNode; label: string; color: string; bgColor: string } | null => {
  if (commandMode === 'review') {
    return {
      icon: <Eye className="h-3.5 w-3.5" />,
      label: 'Review',
      color: 'text-indigo-700',
      bgColor: 'bg-indigo-50',
    };
  }
  if (commandMode === 'fix') {
    return {
      icon: <Wrench className="h-3.5 w-3.5" />,
      label: 'Fix',
      color: 'text-amber-700',
      bgColor: 'bg-amber-50',
    };
  }
  return null;
};

const TaskHeader: React.FC<TaskHeaderProps> = ({ taskInfo, currentStatus }) => {
  const statusInfo = getStatusInfo(currentStatus, taskInfo?.commandMode);
  const commandModeBadge = getCommandModeBadge(taskInfo?.commandMode);
  const title = getDisplayTitle(taskInfo?.title);

  return (
    <div className="flex flex-col gap-1.5">
      {/* Status badge - inline pill */}
      <div className="flex items-center gap-2">
        <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${statusInfo.bgColor} ${statusInfo.color}`}>
          {statusInfo.icon}
          {statusInfo.label}
        </span>
        {commandModeBadge && (
          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${commandModeBadge.bgColor} ${commandModeBadge.color}`}>
            {commandModeBadge.icon}
            {commandModeBadge.label}
          </span>
        )}
        {taskInfo?.ultrafixCycle && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-violet-50 text-violet-700">
            <RefreshCw className="h-3.5 w-3.5" />
            Ultrafix
          </span>
        )}
      </div>
      {/* Title */}
      <h2 className="text-base sm:text-lg font-semibold text-gray-900 leading-tight break-words line-clamp-2" title={title.tooltip}>
        {title.text || 'Loading...'}
      </h2>
      {/* Subtitle - smaller on mobile */}
      {taskInfo && (
        <p className="text-xs sm:text-sm text-gray-500">{getSubtitle(taskInfo)}</p>
      )}
    </div>
  );
};

/** The task's state as one pill, for the compact desktop header's first row. */
export const TaskStatusBadge: React.FC<TaskHeaderProps> = ({ taskInfo, currentStatus }) => {
  const statusInfo = getStatusInfo(currentStatus, taskInfo?.commandMode);
  return (
    <span data-testid="task-status-badge" className={`inline-flex flex-none items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${statusInfo.bgColor} ${statusInfo.color}`}>
      {statusInfo.icon}
      {statusInfo.label}
    </span>
  );
};

export interface RunInspection {
  runNumber: number;
  runCount: number;
  /** The inspected run's last recorded state. */
  status: string;
  commandMode?: string;
  /** Whether the newest run is still working. */
  headActive: boolean;
  /** Opens the newest run again. */
  onBack: () => void;
}

/**
 * Says, in the header of a panel below, that the panel shows an earlier run
 * and how it ended. Inspecting a run is local to those panels: the task's
 * header above keeps describing the task and its newest run.
 */
export const InspectedRunContext: React.FC<RunInspection> = ({ runNumber, runCount, status, commandMode, headActive, onBack }) => (
  <span
    role="status"
    data-testid="inspected-run-context"
    className="flex min-w-0 flex-1 items-center justify-between gap-3 text-xs normal-case tracking-normal"
  >
    <span className="inline-flex min-w-0 items-center gap-1.5 text-slate-500">
      <History aria-hidden="true" className="h-3.5 w-3.5 flex-none text-slate-400" />
      <span className="truncate">
        <span className="font-semibold text-slate-800">Run {runNumber} of {runCount}</span>
        {' · '}{getStatusInfo(status, commandMode).label}
      </span>
    </span>
    <button
      type="button"
      onClick={onBack}
      className="inline-flex flex-none items-center gap-1 rounded border border-slate-300 bg-white px-2 py-0.5 text-xs font-medium text-slate-800 shadow-sm transition-colors hover:border-slate-400 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
    >
      {headActive ? `Return to live Run ${runCount}` : `Back to Run ${runCount}`}
      <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 text-teal-600" />
    </button>
  </span>
);

/** The run on screen's state: `Active`, or how it ended and when, e.g. `Completed 39 mins ago`. */
export const RunStateLabel: React.FC<{ status: string; isActive: boolean; lastActivity?: string; commandMode?: string }> = ({ status, isActive, lastActivity, commandMode }) => {
  if (isActive) return <>Active</>;
  const ago = formatRelativeTime(lastActivity);
  const label = getStatusInfo(status, commandMode).label;
  return <>{ago ? `${label} ${ago === 'Just now' ? 'just now' : ago}` : label}</>;
};

export default TaskHeader;
