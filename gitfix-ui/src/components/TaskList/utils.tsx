import type { Task, TaskTypeInfo } from './types';

export const getTaskTypeInfo = (task: Task): TaskTypeInfo => {
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

export const getStatusPill = (status: string) => {
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

export const formatRelativeTime = (dateString: string | undefined): string => {
  if (!dateString) return '';
  const date = new Date(dateString);
  const now = new Date();
  const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (diffInSeconds < 60) return 'Just now';

  const minutes = Math.floor(diffInSeconds / 60);
  if (minutes < 60) return `${minutes} min${minutes > 1 ? 's' : ''} ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr${hours > 1 ? 's' : ''} ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days > 1 ? 's' : ''} ago`;

  return date.toLocaleDateString();
};

export const formatDuration = (startTime: string | undefined, endTime: string | undefined): string => {
  if (!startTime) return '--';

  const end = endTime ? new Date(endTime) : new Date();
  const duration = end.getTime() - new Date(startTime).getTime();

  const minutes = Math.floor(duration / 60000);
  const seconds = Math.floor((duration % 60000) / 1000);

  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
};
