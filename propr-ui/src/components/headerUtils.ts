import { stripStatusSlot } from '@propr/shared';
// Utility functions for header components
// Separated to allow React Fast Refresh to work properly

// Status badge colors based on plan status - using outline pill style
export const getStatusBadgeStyle = (status: string): string => {
  switch (status) {
    case 'generating':
    case 'refining':
      return 'border border-blue-200 text-blue-600 bg-transparent';
    case 'review':
      return 'border border-amber-200 text-amber-600 bg-transparent';
    case 'approved':
      return 'border border-green-200 text-green-600 bg-transparent';
    case 'executing':
      return 'border border-purple-200 text-purple-600 bg-transparent';
    case 'executed':
      return 'border border-green-200 text-green-600 bg-transparent';
    case 'pr_created':
      return 'border border-cyan-200 text-cyan-600 bg-transparent';
    case 'draft':
    default:
      return 'border border-gray-200 text-gray-600 bg-transparent';
  }
};

// The shared relative age (`5m ago`, `Nov 2, 2026`); see `utils/dateFormat.ts`.
export { formatRelativeTime } from '../utils/dateFormat';

/**
 * A task title for the header's task list: without the `Followup:` prefix, a
 * PR status slot (`🔨 `, `✅➇ `) or the leading `[N by Model]` tag.
 */
export function cleanHeaderTaskTitle(title?: string): string {
  if (!title) return '';
  return stripStatusSlot(stripStatusSlot(title).replace(/^Followup:\s*/i, '')).replace(/^\[.*?\]\s*/g, '').trim();
}
