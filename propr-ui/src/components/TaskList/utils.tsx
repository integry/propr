import { stripStatusSlot } from '@propr/shared';
import type { Task } from './types';
import { GitMerge } from 'lucide-react';

/**
 * Checks if a task should be visually dimmed based on its plan issue status.
 * Tasks with 'merged' or 'closed' status are dimmed to indicate completion.
 */
export const shouldDimTask = (task: Task): boolean => {
  const status = task.planIssueStatus?.toLowerCase();
  return status === 'merged' || status === 'closed';
};

/**
 * Extracts a clean title for document/browser tab display.
 * Transforms titles like "Followup: [870 by Claude Opus] Update checkout..."
 * to "870: Update checkout..."
 *
 * @param title - The full task title
 * @param issueNumber - Optional issue number to use if extraction fails
 * @returns Clean title in format "issueId: title" or the original title if no pattern matches
 */
/**
 * The title without a PR status slot (`🔨 `, `✅❽ `), at its start or right
 * after a `Followup:` / `New Issue:` prefix.
 */
const withoutStatusSlot = (title: string): string => {
  const unslotted = stripStatusSlot(title);
  const prefix = /^(?:Followup:|New Issue:)\s*/i.exec(unslotted);
  return prefix ? prefix[0] + stripStatusSlot(unslotted.slice(prefix[0].length)) : unslotted;
};

export const getCleanDocumentTitle = (title: string | undefined, issueNumber?: number): string => {
  if (!title) return issueNumber ? `Task #${issueNumber}` : 'Task';
  title = withoutStatusSlot(title);

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

/**
 * Status shown for a task row. A completed run whose pull request has since
 * merged reads as merged: that is the state an engineer scans the ledger for.
 */
export const getDisplayStatus = (task: Task): string =>
  task.status === 'completed' && (task.planIssueStatus?.toLowerCase() === 'merged' || task.prState === 'merged') ? 'merged' : task.status;

export const getStatusPill = (status: string, runType?: string | null) => {
  const baseClasses = "px-2 py-0.5 text-xs font-medium rounded-full inline-flex items-center gap-1.5";

  switch (status) {
    case 'completed':
      return (
        <span className={`${baseClasses} bg-gray-100 text-gray-600 border border-gray-200`}>
           <span className="w-1.5 h-1.5 rounded-full bg-gray-400"></span>
           Completed
        </span>
      );
    case 'merged':
      return (
        // Success is quiet: merged is neutral grey like Completed; the merge mark tells the two apart.
        <span className={`${baseClasses} bg-gray-100 text-gray-600 border border-gray-200`}>
           <GitMerge data-testid="status-merged-icon" className="h-3 w-3 text-gray-500" aria-hidden="true" />
           Merged
        </span>
      );
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
    case 'active':
    case 'implementing':
    case 'claude_execution':
    case 'processing':
    case 'post_processing':
      return (
        <span className={`${baseClasses} bg-teal-50 text-teal-700 border border-teal-200`}>
           <span className="w-1.5 h-1.5 rounded-full bg-teal-500 animate-pulse"></span>
           {runType?.toLowerCase() === 'review' ? 'Review' : 'Implementing'}
        </span>
      );
    case 'waiting':
    case 'pending':
    case 'queued':
      // Neutral slate. The hollow dot marks a run that has not started.
      return (
        <span className={`${baseClasses} bg-slate-100 text-slate-600 border border-slate-200`}>
           <span className="w-1.5 h-1.5 rounded-full border border-slate-400"></span>
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

/** The shared relative age (`5m ago`, `Nov 2, 2026`); see `utils/dateFormat.ts`. */
export { formatRelativeTime } from '../../utils/dateFormat';

/**
 * Elapsed time in the largest two units it actually needs.
 *
 * Seconds matter for a run that started a moment ago and stop mattering long
 * before minutes run out: `240m 00s` is a raw minute count printed rather than
 * a duration read, and nobody divides by sixty in their head to learn that a
 * task has been going for four hours. So each unit hands over once the one
 * above it is whole — `45m 12s`, then `4h 00m`, then `2d 06h` — and the value
 * stays two fields wide at every scale, which is what keeps a column of them
 * straight.
 */
export const formatDuration = (startTime: string | null | undefined, endTime: string | null | undefined): string => {
  if (!startTime) return '--';

  const end = endTime ? new Date(endTime) : new Date();
  const duration = Math.max(0, end.getTime() - new Date(startTime).getTime());

  const totalMinutes = Math.floor(duration / 60000);
  const totalHours = Math.floor(totalMinutes / 60);
  const pad = (value: number): string => value.toString().padStart(2, '0');

  if (totalHours >= 24) return `${Math.floor(totalHours / 24)}d ${pad(totalHours % 24)}h`;
  if (totalMinutes >= 60) return `${totalHours}h ${pad(totalMinutes % 60)}m`;

  const seconds = Math.floor((duration % 60000) / 1000);
  return `${totalMinutes}m ${pad(seconds)}s`;
};
