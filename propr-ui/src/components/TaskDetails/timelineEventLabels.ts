import type { HistoryItem } from './types';

/** Automatic-replacement timeline events repeat the task's state; label them by event. */
export const getReplacementEventLabel = (item: HistoryItem): string | null => {
  switch (item.metadata?.event) {
    case 'replacement.dispatched':
      return `Replacement Attempt ${item.metadata.attemptNumber ?? ''} Started`.replace('  ', ' ');
    case 'replacement.skipped':
      return item.reason || 'Replacement Skipped';
    case 'replacement.exhausted':
      return item.reason || 'Replacement Attempts Exhausted';
    case 'pull_request.auto_assignment':
      return item.metadata.description || item.reason || 'Pull Request Assignment';
    default:
      return null;
  }
};
