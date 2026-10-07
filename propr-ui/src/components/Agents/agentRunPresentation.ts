import { TERMINAL_AGENT_RUN_STATES, type AgentRunState, type AgentRunTrigger } from '@propr/shared';
import type { AgentCapacity, AgentRunRecord } from '../../api/agentDefinitionsApi';
import { agentTypeLabel, formatDuration } from './agentPresentation';

/** How the run history and run detail name triggers, times and capacity. */

export const RUN_TRIGGER_LABELS: Record<AgentRunTrigger, string> = {
  manual: 'Run now',
  schedule: 'Schedule',
  api: 'API',
  mcp: 'MCP',
  cli: 'CLI',
};

/** States a run can still be cancelled from. */
export const CANCELLABLE_RUN_STATES: readonly AgentRunState[] = ['queued', 'deferred', 'running', 'awaiting_approval', 'acting'];

export const isTerminalRunState = (state: AgentRunState): boolean =>
  (TERMINAL_AGENT_RUN_STATES as readonly AgentRunState[]).includes(state);

/** When the run began working, or when it was created if it never started. */
export const runStartedAt = (run: Pick<AgentRunRecord, 'startedAt' | 'createdAt'>): number => run.startedAt ?? run.createdAt;

/** `just now`, `5m ago`, `3h ago`, `2d ago`. */
export const formatRelativeTime = (timestamp: number, now: number): string => {
  const elapsed = now - timestamp;
  if (elapsed < 60_000) return 'just now';
  return `${formatDuration(elapsed)} ago`;
};

/** `45s`, `12m`, `2h`: how long a run took, or has taken so far; `—` before it starts. */
export const runDuration = (run: Pick<AgentRunRecord, 'startedAt' | 'finishedAt' | 'state'>, now: number): string => {
  if (run.startedAt === null) return '—';
  const end = run.finishedAt ?? (isTerminalRunState(run.state) ? null : now);
  if (end === null) return '—';
  const elapsed = Math.max(0, end - run.startedAt);
  return elapsed < 60_000 ? `${Math.round(elapsed / 1_000)}s` : formatDuration(elapsed);
};

/** A timestamp in the viewer's locale, or `—`. */
export const formatTimestamp = (timestamp: number | null): string =>
  timestamp === null ? '—' : new Date(timestamp).toLocaleString();

/** The first non-empty line of a report with leading Markdown markers removed, for one-line previews. */
export const firstReportLine = (report: string | null | undefined): string | null => {
  const line = report?.split('\n').map(candidate => candidate.trim()).find(Boolean);
  if (!line) return null;
  return line.replace(/^(?:#{1,6}\s+|[-*+]\s+|>\s*|\d+[.)]\s+)/, '').replace(/[*_`]/g, '').trim() || null;
};

/**
 * Report previews by run id. The history list does not carry reports, so a
 * row's preview is read on hover, and a run detail that has the report records
 * it here so returning to the history shows it without another read.
 */
const reportPreviews = new Map<string, string | null>();

export const rememberReportPreview = (runId: string, report: string | null | undefined): void => {
  reportPreviews.set(runId, firstReportLine(report));
};

export const recalledReportPreview = (runId: string): string | null | undefined => reportPreviews.get(runId);

export const forgetReportPreviews = (): void => reportPreviews.clear();

/**
 * "Claude is at 94% of its session window (pause threshold 90%). Run anyway?",
 * or null when the agent's subscription is not near its limit.
 */
export const capacityWarning = ({ capacity, threshold }: AgentCapacity): string | null => {
  if (capacity.status !== 'near_limit') return null;
  const provider = agentTypeLabel(capacity.provider);
  const { sessionPercent, weeklyPercent } = capacity;
  const sessionLimited = sessionPercent !== undefined && (sessionPercent >= threshold || weeklyPercent === undefined || weeklyPercent < threshold);
  const percent = sessionLimited ? sessionPercent : weeklyPercent;
  const window = sessionLimited ? 'session window' : 'weekly limit';
  const usage = percent === undefined ? 'near its usage limit' : `at ${Math.round(percent)}% of its ${window}`;
  return `${provider} is ${usage} (pause threshold ${Math.round(threshold)}%). Run anyway?`;
};
