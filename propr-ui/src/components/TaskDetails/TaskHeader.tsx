import React from 'react';
import { TaskInfo } from './types';
import { CheckCircle2, XCircle, Loader2, Clock, Play, GitPullRequest, Eye, Wrench } from 'lucide-react';

interface TaskHeaderProps {
  taskInfo: TaskInfo | null;
  currentStatus: string;
}

const getSubtitle = (taskInfo: TaskInfo): string => {
  if (taskInfo.subtitle) return taskInfo.subtitle;
  if (taskInfo.type === 'pr-comment') {
    return `Follow-up changes for PR #${taskInfo.number}`;
  }
  return `Initial implementation for Issue #${taskInfo.number}`;
};

const getStatusInfo = (status: string): { icon: React.ReactNode; label: string; color: string; bgColor: string } => {
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
      label: 'Implementing',
      color: 'text-blue-700',
      bgColor: 'bg-blue-50'
    };
  }

  if (normalizedStatus === 'CLAUDE_EXECUTION_COMPLETED') {
    return {
      icon: <CheckCircle2 className="h-4 w-4 text-green-600" />,
      label: 'Implementation Done',
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
  const statusInfo = getStatusInfo(currentStatus);
  const commandModeBadge = getCommandModeBadge(taskInfo?.commandMode);

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
      </div>
      {/* Title */}
      <h2 className="text-base sm:text-lg font-semibold text-gray-900 leading-tight break-words">
        {taskInfo?.title || 'Loading...'}
      </h2>
      {/* Subtitle - smaller on mobile */}
      {taskInfo && (
        <p className="text-xs sm:text-sm text-gray-500">{getSubtitle(taskInfo)}</p>
      )}
    </div>
  );
};

export default TaskHeader;
