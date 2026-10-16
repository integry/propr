/**
 * Strict API projection of the daemon-published routing resume-resync state
 * (installation suspension gap reconciliation). A malformed object is dropped
 * as a whole so the status route never reports a guessed gap or progress.
 */

const STATES = ['idle', 'pending', 'reconciling', 'partial', 'failed', 'completed', 'acknowledged'] as const;
const MAX_FAILED_REPOSITORIES = 10;
const MAX_TEXT_LENGTH = 512;
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export type RoutingResyncState = (typeof STATES)[number];

export interface RoutingResyncStatus {
  state: RoutingResyncState;
  installationId: number;
  routingGeneration: number | null;
  resumeGeneration: number | null;
  gapStartedAt: string | null;
  gapEndedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  acknowledgedAt: string | null;
  attempts: number;
  lastAttemptAt: string | null;
  nextRetryAt: string | null;
  lastError: string | null;
  running: boolean;
  repositories: { total: number; reconciled: number; inaccessible: number; failed: number; pending: number };
  failedRepositories: Array<{ repository: string; error: string | null }>;
  intakeWaiting: boolean;
  completionId: string | null;
  lastCompletionSentAt: string | null;
  lastRejection: { reason: string; frameType: string; at: string } | null;
}

const TIMESTAMP_FIELDS = [
  'gapStartedAt', 'gapEndedAt', 'startedAt', 'completedAt', 'acknowledgedAt',
  'lastAttemptAt', 'nextRetryAt', 'lastCompletionSentAt',
] as const;
const COUNT_FIELDS = ['total', 'reconciled', 'inaccessible', 'failed', 'pending'] as const;

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isNullableGeneration(value: unknown): boolean {
  return value === null || (Number.isSafeInteger(value) && (value as number) > 0);
}

function isNullableTimestamp(value: unknown): boolean {
  return value === null || (typeof value === 'string' && ISO_8601_RE.test(value) && !Number.isNaN(Date.parse(value)));
}

function isNullableText(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length <= MAX_TEXT_LENGTH);
}

function parseRepositories(value: unknown): RoutingResyncStatus['repositories'] | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const counts = value as Record<string, unknown>;
  if (!COUNT_FIELDS.every(field => isCount(counts[field]))) return undefined;
  return {
    total: counts.total as number,
    reconciled: counts.reconciled as number,
    inaccessible: counts.inaccessible as number,
    failed: counts.failed as number,
    pending: counts.pending as number,
  };
}

function parseFailedRepositories(value: unknown): RoutingResyncStatus['failedRepositories'] | undefined {
  if (!Array.isArray(value) || value.length > MAX_FAILED_REPOSITORIES) return undefined;
  const parsed: RoutingResyncStatus['failedRepositories'] = [];
  for (const entry of value) {
    const item = entry as Record<string, unknown> | null;
    if (!item || typeof item.repository !== 'string' || item.repository.length > MAX_TEXT_LENGTH || !isNullableText(item.error)) return undefined;
    parsed.push({ repository: item.repository, error: item.error });
  }
  return parsed;
}

function parseRejection(value: unknown): RoutingResyncStatus['lastRejection'] | undefined {
  if (value === null) return null;
  const item = value as Record<string, unknown> | undefined;
  if (!item || typeof item.reason !== 'string' || typeof item.frameType !== 'string'
    || item.reason.length > MAX_TEXT_LENGTH || item.frameType.length > MAX_TEXT_LENGTH
    || !isNullableTimestamp(item.at) || item.at === null) return undefined;
  return { reason: item.reason, frameType: item.frameType, at: item.at as string };
}

function hasValidScalars(state: Record<string, unknown>): boolean {
  return (STATES as readonly unknown[]).includes(state.state)
    && Number.isSafeInteger(state.installationId) && (state.installationId as number) > 0
    && isNullableGeneration(state.routingGeneration)
    && isNullableGeneration(state.resumeGeneration)
    && TIMESTAMP_FIELDS.every(field => isNullableTimestamp(state[field]))
    && isCount(state.attempts)
    && isNullableText(state.lastError)
    && isNullableText(state.completionId)
    && typeof state.running === 'boolean'
    && typeof state.intakeWaiting === 'boolean';
}

export function parseRoutingResyncStatus(value: unknown): RoutingResyncStatus | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const state = value as Record<string, unknown>;
  if (!hasValidScalars(state)) return undefined;
  const repositories = parseRepositories(state.repositories);
  const failedRepositories = parseFailedRepositories(state.failedRepositories);
  const lastRejection = parseRejection(state.lastRejection);
  if (!repositories || !failedRepositories || lastRejection === undefined) return undefined;
  const timestamps = Object.fromEntries(TIMESTAMP_FIELDS.map(field => [field, state[field] as string | null]));
  return {
    state: state.state as RoutingResyncState,
    installationId: state.installationId as number,
    routingGeneration: state.routingGeneration as number | null,
    resumeGeneration: state.resumeGeneration as number | null,
    gapStartedAt: timestamps.gapStartedAt,
    gapEndedAt: timestamps.gapEndedAt,
    startedAt: timestamps.startedAt,
    completedAt: timestamps.completedAt,
    acknowledgedAt: timestamps.acknowledgedAt,
    attempts: state.attempts as number,
    lastAttemptAt: timestamps.lastAttemptAt,
    nextRetryAt: timestamps.nextRetryAt,
    lastError: state.lastError as string | null,
    running: state.running as boolean,
    repositories,
    failedRepositories,
    intakeWaiting: state.intakeWaiting as boolean,
    completionId: state.completionId as string | null,
    lastCompletionSentAt: timestamps.lastCompletionSentAt,
    lastRejection,
  };
}
