import type { Task, TaskTypeInfo } from './types';

/**
 * Extracts a clean title for document/browser tab display.
 * Transforms titles like "Followup: [870 by Claude Opus] Update checkout..."
 * to "870: Update checkout..."
 *
 * @param title - The full task title
 * @param issueNumber - Optional issue number to use if extraction fails
 * @returns Clean title in format "issueId: title" or the original title if no pattern matches
 */
export const getCleanDocumentTitle = (title: string | undefined, issueNumber?: number): string => {
  if (!title) return issueNumber ? `Task #${issueNumber}` : 'Task';

  // Pattern: "Followup: [870 by Claude Opus] Title here" or "New Issue: [870 by Claude Opus] Title here"
  // Extract issue number and clean title
  const bracketPattern = /^(?:Followup:|New Issue:)?\s*\[(\d+)\s+by\s+[^\]]+\]\s*(.+)$/i;
  const match = title.match(bracketPattern);

  if (match) {
    const [, extractedIssueId, cleanTitle] = match;
    return `${extractedIssueId}: ${cleanTitle.trim()}`;
  }

  // If no bracket pattern but we have "Followup:" or "New Issue:" prefix, strip it
  const prefixPattern = /^(?:Followup:|New Issue:)\s*(.+)$/i;
  const prefixMatch = title.match(prefixPattern);
  if (prefixMatch && issueNumber) {
    return `${issueNumber}: ${prefixMatch[1].trim()}`;
  }

  // Return original title if no patterns match
  return title;
};

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
    // "Success is Quiet" - Gray for completed tasks
    case 'completed':
      return (
        <span className={`${baseClasses} bg-gray-100 text-gray-500 border border-gray-200`}>
           <svg className="w-3 h-3 text-gray-400" fill="currentColor" viewBox="0 0 20 20">
             <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
           </svg>
           Completed
        </span>
      );
    // Red for failed tasks
    case 'failed':
      return (
        <span className={`${baseClasses} bg-red-50 text-red-700 border border-red-200`}>
           <span className="w-1.5 h-1.5 rounded-full bg-red-500"></span>
           Failed
        </span>
      );
    case 'cancelled':
      return (
        <span className={`${baseClasses} bg-orange-50 text-orange-700 border border-orange-200`}>
           <span className="w-1.5 h-1.5 rounded-full bg-orange-500"></span>
           Cancelled
        </span>
      );
    // Teal/Blue for active tasks (implementing)
    case 'active':
    case 'claude_execution':
    case 'processing':
      return (
        <span className={`${baseClasses} bg-teal-50 text-teal-700 border border-teal-200`}>
           <span className="w-1.5 h-1.5 rounded-full bg-teal-500 animate-pulse"></span>
           Implementing
        </span>
      );
    case 'waiting':
    case 'pending':
      return (
        <span className={`${baseClasses} bg-blue-50 text-blue-700 border border-blue-200`}>
           <span className="w-1.5 h-1.5 rounded-full bg-blue-500"></span>
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
