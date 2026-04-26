import { LlmLogEntry } from '../api/llmLogsApi';

// Re-export pure display helpers from the shared module (no browser deps)
export { getWorkReferenceDisplay, getWorkTypeLabel, hasDetailedInfo } from './llmLogsDisplayUtils';

// Format duration to human-readable (e.g., "1m 30s")
export const formatDuration = (ms: number | null): string => {
  if (ms === null) return '-';
  if (ms < 1000) return `${ms}ms`;

  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) {
    return `${seconds}s`;
  }
  if (seconds === 0) {
    return `${minutes}m`;
  }
  return `${minutes}m ${seconds}s`;
};

// Format cost
export const formatCost = (cost: number | null): string => {
  if (cost === null) return '-';
  if (cost < 0.001) return '<$0.001';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(3)}`;
};

// Format tokens - includes cache tokens in input total (per Claude billing)
export const formatTokens = (
  input: number | null,
  output: number | null,
  cacheCreation?: number | null,
  cacheRead?: number | null
): string => {
  // Total input includes: input_tokens + cache_creation + cache_read (per Claude billing)
  const totalInput = (input ?? 0) + (cacheCreation ?? 0) + (cacheRead ?? 0);
  const totalOutput = output ?? 0;

  if (totalInput === 0 && totalOutput === 0) return '-';

  return `${totalInput.toLocaleString()} / ${totalOutput.toLocaleString()}`;
};

// Format timestamp
export const formatTimestamp = (timestamp: string | null): string => {
  if (!timestamp) return '-';
  const date = new Date(timestamp);
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
};

// Format execution type for display
export const formatType = (type: string): string => {
  return type
    .split(/[-_]/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
};

// Get context display text (shows repository, draft ID, or session ID)
export const getContextDisplay = (log: LlmLogEntry): string => {
  if (log.repository) {
    return log.repository;
  }
  if (log.draftId) {
    return `Draft: ${log.draftId.substring(0, 8)}...`;
  }
  if (log.sessionId) {
    return `Session: ${log.sessionId.substring(0, 8)}...`;
  }
  return '-';
};

