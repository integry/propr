import { LlmLogEntry } from '../api/llmLogsApi';
import { formatCount, formatRelativeTime } from '../utils/dateFormat';

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

  return `${formatCount(totalInput)} / ${formatCount(totalOutput)}`;
};

// A log line's start as the shared relative age (`5m ago`, then `Nov 2, 2026`)
export const formatTimestamp = (timestamp: string | null, now: number = Date.now()): string =>
  formatRelativeTime(timestamp, now) || '-';

/** Words in an execution type that are acronyms, written in capitals. */
const TYPE_ACRONYMS = new Set(['pr', 'ci', 'ai', 'llm', 'mcp', 'api', 'ui', 'url', 'id']);

/**
 * The display label of every execution type the server records (see
 * `ExecutionType` in packages/core and the job-specific types such as
 * `pr-review-context-scout`). One table for the type chips and the type filter.
 */
export const EXECUTION_TYPE_LABELS: Readonly<Record<string, string>> = {
  implementation: 'Implementation',
  'plan-generation': 'Plan generation',
  'plan-refinement': 'Plan refinement',
  'title-generation': 'Title generation',
  summarization: 'Summarization',
  'summary-selection': 'Summary selection',
  'context-analysis': 'Context analysis',
  'repo-chat': 'Repository chat',
  'repo-improvements': 'Repository improvements',
  'pr-review': 'PR review',
  'pr-review-context-scout': 'PR review context scout',
  'usage-tips-selection': 'Usage tips selection',
  'agent-health-check': 'Agent health check',
  other: 'Other',
};

/** An execution type key normalised to the kebab case of the label table. */
const typeKey = (type: string): string => type.trim().toLowerCase().replace(/[_\s]+/g, '-');

/**
 * An execution type for display: the label from `EXECUTION_TYPE_LABELS`, or,
 * for a type the table does not know yet, the type in sentence case with its
 * acronyms in capitals (`ci_fix_attempt` reads "CI fix attempt").
 */
export const formatType = (type: string): string => {
  const known = EXECUTION_TYPE_LABELS[typeKey(type)];
  if (known) return known;
  return type
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (TYPE_ACRONYMS.has(lower)) return lower.toUpperCase();
      return index === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
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

