import { createHash } from 'node:crypto';
import type { Knex } from 'knex';
import type {
  TaskState,
  TaskStateData,
  UpdateMetadata,
} from './workerStateManager.types.js';

interface DurableTaskRow {
  correlation_id?: unknown;
  created_at?: unknown;
  initial_job_data?: unknown;
}

export interface DurableTaskHistoryRow {
  history_id: number;
  state: string;
  timestamp: string;
  reason?: string | null;
  metadata?: unknown;
  transition_key: string;
}

function canonicalValue(value: unknown): unknown {
  if (value === undefined) return { $undefined: true };
  if (typeof value === 'number' && !Number.isFinite(value)) return { $number: String(value) };
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalValue(entry)]));
}

function digestIdentity(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalValue(value))).digest('hex');
}

function canonicalTimestamp(value: unknown, fallback: string): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value !== 'string') return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function parsePositiveInteger(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error('Durable task transition did not return a valid history ID');
  }
  return parsed;
}

function parseHistoryRow(
  row: Record<string, unknown> | undefined,
  fallbackTimestamp: string,
  transitionKey: string
): DurableTaskHistoryRow {
  if (!row) throw new Error('Durable task transition could not be read after persistence');
  return {
    history_id: parsePositiveInteger(row.history_id),
    state: String(row.state),
    timestamp: canonicalTimestamp(row.timestamp, fallbackTimestamp),
    reason: typeof row.reason === 'string' ? row.reason : null,
    metadata: row.metadata,
    transition_key: typeof row.transition_key === 'string' ? row.transition_key : transitionKey,
  };
}

export function taskCreationTransitionKey(taskId: string): string {
  return `task-created:${taskId}`;
}

export function currentTaskTransitionKey(state: TaskStateData): string {
  if (state.currentTransitionKey) return state.currentTransitionKey;
  const latest = state.history.at(-1);
  if (latest?.transitionKey) return latest.transitionKey;
  return `legacy-state:${digestIdentity({
    taskId: state.taskId,
    state: state.state,
    updatedAt: state.updatedAt,
    latest,
  })}`;
}

export function buildTaskTransitionKey(
  taskId: string,
  previousTransitionKey: string,
  newState: TaskState,
  metadata: UpdateMetadata
): string {
  const fingerprint = buildTaskTransitionFingerprint(taskId, newState, metadata);
  const explicitKey = metadata.idempotencyKey?.trim();
  return `task-transition:${digestIdentity(explicitKey
    ? { taskId, explicitKey }
    : { taskId, previousTransitionKey, fingerprint })}`;
}

export function buildTaskTransitionFingerprint(
  taskId: string,
  newState: TaskState,
  metadata: UpdateMetadata
): string {
  const explicitKey = metadata.idempotencyKey?.trim();
  if (metadata.idempotencyKey !== undefined && !explicitKey) {
    throw new TypeError('Task transition idempotencyKey must be non-blank');
  }
  return digestIdentity({
    taskId,
    newState,
    metadata: { ...metadata, idempotencyKey: explicitKey },
  });
}

export function buildTaskEnrichmentKey(input: {
  taskId: string;
  kind: 'issue-ref' | 'history-metadata';
  baseVersion: string;
  transitionAt: string;
  change: unknown;
}): string {
  return `task-enrichment:${digestIdentity(input)}`;
}

export async function persistTaskCreation(input: {
  database: Knex;
  taskData: Record<string, unknown>;
  historyData: Record<string, unknown>;
  taskId: string;
  transitionKey: string;
  fallbackTimestamp: string;
}): Promise<{ task: DurableTaskRow; history: DurableTaskHistoryRow }> {
  return input.database.transaction(async (transaction) => {
    await transaction('tasks').insert(input.taskData).onConflict('task_id').ignore();
    await transaction('task_history').insert({
      ...input.historyData,
      transition_key: input.transitionKey,
    }).onConflict(['task_id', 'transition_key']).ignore();
    const task = await transaction('tasks').where({ task_id: input.taskId })
      .first('correlation_id', 'created_at', 'initial_job_data') as DurableTaskRow | undefined;
    const history = await transaction('task_history')
      .where({ task_id: input.taskId, transition_key: input.transitionKey })
      .first(
        'history_id', 'state', 'timestamp', 'reason', 'metadata', 'transition_key'
      ) as Record<string, unknown> | undefined;
    if (!task) throw new Error('Durable task row could not be read after persistence');
    return {
      task,
      history: parseHistoryRow(history, input.fallbackTimestamp, input.transitionKey),
    };
  });
}

export async function persistTaskTransition(input: {
  database: Knex;
  historyData: Record<string, unknown>;
  taskId: string;
  transitionKey: string;
  fallbackTimestamp: string;
}): Promise<DurableTaskHistoryRow> {
  return input.database.transaction(async (transaction) => {
    await transaction('task_history').insert({
      ...input.historyData,
      transition_key: input.transitionKey,
    }).onConflict(['task_id', 'transition_key']).ignore();
    const history = await transaction('task_history')
      .where({ task_id: input.taskId, transition_key: input.transitionKey })
      .first(
        'history_id', 'state', 'timestamp', 'reason', 'metadata', 'transition_key'
      ) as Record<string, unknown> | undefined;
    return parseHistoryRow(history, input.fallbackTimestamp, input.transitionKey);
  });
}
