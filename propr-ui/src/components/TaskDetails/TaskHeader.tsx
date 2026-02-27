import React from 'react';
import { TaskInfo } from './types';
import { CheckCircle2, XCircle, Loader2, Clock, Play, GitPullRequest } from 'lucide-react';

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

const getStatusInfo = (status: string): { icon: React.ReactNode; label: string; color: string } => {
  const normalizedStatus = status?.toUpperCase() || '';

  if (normalizedStatus === 'COMPLETED') {
    return {
      icon: <CheckCircle2 className="h-7 w-7 text-green-500" />,
      label: 'Completed',
      color: 'text-green-600'
    };
  }

  if (normalizedStatus === 'FAILED') {
    return {
      icon: <XCircle className="h-7 w-7 text-red-500" />,
      label: 'Failed',
      color: 'text-red-600'
    };
  }

  if (normalizedStatus === 'PENDING') {
    return {
      icon: <Clock className="h-7 w-7 text-gray-400" />,
      label: 'Queued',
      color: 'text-gray-500'
    };
  }

  if (normalizedStatus === 'PROCESSING') {
    return {
      icon: <Loader2 className="h-7 w-7 text-blue-500 animate-spin" />,
      label: 'Analyzing',
      color: 'text-blue-600'
    };
  }

  if (normalizedStatus === 'CLAUDE_EXECUTION' || normalizedStatus === 'CLAUDE_EXECUTION_STARTED') {
    return {
      icon: <Play className="h-7 w-7 text-blue-500 animate-pulse" />,
      label: 'Implementing',
      color: 'text-blue-600'
    };
  }

  if (normalizedStatus === 'CLAUDE_EXECUTION_COMPLETED') {
    return {
      icon: <CheckCircle2 className="h-7 w-7 text-green-500" />,
      label: 'Implementation Done',
      color: 'text-green-600'
    };
  }

  if (normalizedStatus === 'POST_PROCESSING') {
    return {
      icon: <GitPullRequest className="h-7 w-7 text-purple-500 animate-pulse" />,
      label: 'Creating PR',
      color: 'text-purple-600'
    };
  }

  // Default
  return {
    icon: <Clock className="h-7 w-7 text-gray-400" />,
    label: status || 'Unknown',
    color: 'text-gray-500'
  };
};

const TaskHeader: React.FC<TaskHeaderProps> = ({ taskInfo, currentStatus }) => {
  const statusInfo = getStatusInfo(currentStatus);

  return (
    <>
      <div className="flex items-center gap-3 mb-2">
        <div className="flex items-center gap-2">
          {statusInfo.icon}
          <span className={`text-sm font-medium ${statusInfo.color}`}>
            {statusInfo.label}
          </span>
        </div>
        <div className="h-6 w-px bg-gray-300" />
        <h2 className="text-2xl font-bold text-gray-900 break-all">
          {taskInfo?.title || 'Loading...'}
        </h2>
      </div>
      {taskInfo && (
        <p className="text-gray-600 mb-6 ml-0">{getSubtitle(taskInfo)}</p>
      )}
    </>
  );
};

export default TaskHeader;
