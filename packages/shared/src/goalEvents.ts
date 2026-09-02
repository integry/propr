import type { JsonValue } from './notifications.js';

/**
 * Version one of the closed durable goal-event vocabulary.  New public event
 * shapes require a new registry entry (and, for incompatible changes, a new
 * schema version); arbitrary provider objects are never made public.
 */
export const DURABLE_GOAL_EVENT_SCHEMA_VERSION = 1 as const;

export const DURABLE_GOAL_EVENT_TYPES = [
  'lifecycle.state_changed',
  'scheduler.node_changed',
  'provider.output',
  'provider.output_compacted',
  'provider.assistant',
  'provider.tool',
  'provider.plan',
  'provider.todo',
  'provider.status',
  'provider.completed',
  'usage.reported',
  'checkpoint.saved',
  'message.enqueued',
  'message.claimed',
  'message.delivered',
  'message.acknowledged',
  'message.failed',
  'message.cancelled',
  'github.entity_changed',
  'ci.status_changed',
  'review.status_changed',
  'ultrafix.status_changed',
] as const;

export type DurableGoalEventType = (typeof DURABLE_GOAL_EVENT_TYPES)[number];

/** Events the selected coding-agent session is allowed to submit. */
export const PROVIDER_GOAL_EVENT_TYPES = [
  'provider.output',
  'provider.assistant',
  'provider.tool',
  'provider.plan',
  'provider.todo',
  'provider.status',
  'provider.completed',
  'usage.reported',
  'checkpoint.saved',
] as const satisfies readonly DurableGoalEventType[];

export type ProviderGoalEventType = (typeof PROVIDER_GOAL_EVENT_TYPES)[number];

/** Events written only by trusted ProPR lifecycle/control code. */
export const INTERNAL_GOAL_EVENT_TYPES = [
  'lifecycle.state_changed',
  'scheduler.node_changed',
  'provider.output_compacted',
  'message.enqueued',
  'message.claimed',
  'message.delivered',
  'message.acknowledged',
  'message.failed',
  'message.cancelled',
  'github.entity_changed',
  'ci.status_changed',
  'review.status_changed',
  'ultrafix.status_changed',
] as const satisfies readonly DurableGoalEventType[];

export type InternalGoalEventType = (typeof INTERNAL_GOAL_EVENT_TYPES)[number];

export interface GoalEventSourceIdentity {
  sessionId: string;
  turnId: string;
  executionId: string;
  attemptId: string;
  /** Provider-local sequence. Retries with this identity are one occurrence. */
  providerSequence: number;
  /** Zero-based chunk within a provider occurrence. */
  chunkIndex: number;
  /** Provider session generation, fenced to the controller lease generation. */
  leaseGeneration: number;
}

export interface GoalMessageDeliveryIdentity extends GoalEventSourceIdentity {
  messageId: string;
  deliveryKey: string;
  providerIdempotencyKey: string;
  controllerId: string;
}

export type GoalOutputStream = 'stdout' | 'stderr' | 'structured';
export type GoalOutputType = 'text' | 'json';

export interface DurableGoalEventPayloadMap {
  'lifecycle.state_changed': {
    from: string;
    to: string;
    reason?: string;
    terminalReason?: string;
  };
  'scheduler.node_changed': {
    nodeId: string;
    status: string;
    attemptId?: string;
    blockedReason?: string;
  };
  'provider.output': {
    stream: GoalOutputStream;
    outputType: GoalOutputType;
    chunk: string | JsonValue;
  };
  'provider.assistant': { content: string | JsonValue };
  'provider.tool': {
    toolName: string;
    status: string;
    input?: JsonValue;
    output?: JsonValue;
  };
  'provider.plan': {
    items: Array<{ id: string; text: string; status: 'pending' | 'in_progress' | 'completed' }>;
  };
  'provider.output_compacted': {
    originalType: 'provider.output';
    contentDigest: string;
    payloadBytes: number;
  };
  'provider.todo': {
    items: Array<{ id: string; text: string; status: 'pending' | 'in_progress' | 'completed' }>;
  };
  'provider.status': { status: string; detail?: string };
  'provider.completed': {
    status: 'completed' | 'failed' | 'cancelled';
    summary?: string;
  };
  'usage.reported': {
    provider: string;
    model: string;
    occurrenceId: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    cumulative?: boolean;
  };
  'checkpoint.saved': { checkpointId: string; label?: string };
  'message.enqueued': { messageId: string; queueOrdinal: number; authorUserId: string };
  'message.claimed': GoalMessageDeliveryEvidence;
  'message.delivered': GoalMessageDeliveryEvidence;
  'message.acknowledged': GoalMessageDeliveryEvidence;
  'message.failed': GoalMessageDeliveryEvidence & { retryable: boolean; error: string };
  'message.cancelled': { messageId: string; queueOrdinal: number; authorUserId: string };
  'github.entity_changed': {
    entity: 'issue' | 'pull_request'; number: number; status: string; nodeId?: string;
  };
  'ci.status_changed': { pullRequestNumber: number; status: string };
  'review.status_changed': { pullRequestNumber: number; status: string };
  'ultrafix.status_changed': { pullRequestNumber: number; status: string; cycle?: number };
}

export interface GoalMessageDeliveryEvidence {
  messageId: string;
  queueOrdinal: number;
  sessionId: string;
  turnId: string;
  executionId: string;
  attemptId: string;
  controllerId: string;
  leaseGeneration: number;
  deliveryKey: string;
  providerIdempotencyKey: string;
  providerSequence: number;
  providerChunkIndex: number;
}

export type DurableGoalEventInput = {
  [K in DurableGoalEventType]: {
    schemaVersion: typeof DURABLE_GOAL_EVENT_SCHEMA_VERSION;
    type: K;
    payload: DurableGoalEventPayloadMap[K];
    source: GoalEventSourceIdentity;
    idempotencyKey: string;
    leaseOwner: string;
    leaseEpoch: number;
  }
}[DurableGoalEventType];

export type DurableGoalProviderEventInput = Extract<
  DurableGoalEventInput,
  { type: ProviderGoalEventType }
>;

export interface GoalEventEnvelopeV1 {
  schemaVersion: typeof DURABLE_GOAL_EVENT_SCHEMA_VERSION;
  goalId: string;
  sequence: number;
  kind: 'lifecycle' | 'output' | 'domain';
  eventType: string;
  payload: JsonValue;
  createdAt: string;
  cursor: string;
}

type FieldRule = 'string' | 'integer' | 'boolean' | 'output' | 'todo-items';
interface SchemaDefinition {
  required: Readonly<Record<string, FieldRule>>;
  optional?: Readonly<Record<string, FieldRule>>;
  enum?: Readonly<Record<string, readonly string[]>>;
}

/** Runtime registry shared by ingestion and public projection. */
export const DURABLE_GOAL_EVENT_REGISTRY: Readonly<Record<DurableGoalEventType, SchemaDefinition>> = {
  'lifecycle.state_changed': {
    required: { from: 'string', to: 'string' },
    optional: { reason: 'string', terminalReason: 'string' },
  },
  'scheduler.node_changed': {
    required: { nodeId: 'string', status: 'string' },
    optional: { attemptId: 'string', blockedReason: 'string' },
  },
  'provider.output': {
    required: { stream: 'string', outputType: 'string', chunk: 'output' },
    enum: { stream: ['stdout', 'stderr', 'structured'], outputType: ['text', 'json'] },
  },
  'provider.assistant': { required: { content: 'output' } },
  'provider.tool': {
    required: { toolName: 'string', status: 'string' },
    optional: { input: 'output', output: 'output' },
  },
  'provider.plan': { required: { items: 'todo-items' } },
  'provider.output_compacted': {
    required: { originalType: 'string', contentDigest: 'string', payloadBytes: 'integer' },
    enum: { originalType: ['provider.output'] },
  },
  'provider.todo': { required: { items: 'todo-items' } },
  'provider.status': { required: { status: 'string' }, optional: { detail: 'string' } },
  'provider.completed': {
    required: { status: 'string' }, optional: { summary: 'string' },
    enum: { status: ['completed', 'failed', 'cancelled'] },
  },
  'usage.reported': {
    required: {
      provider: 'string', model: 'string', occurrenceId: 'string', inputTokens: 'integer',
      outputTokens: 'integer', cacheReadTokens: 'integer', cacheWriteTokens: 'integer',
      reasoningTokens: 'integer',
    },
    optional: { cumulative: 'boolean' },
  },
  'checkpoint.saved': { required: { checkpointId: 'string' }, optional: { label: 'string' } },
  'message.enqueued': { required: { messageId: 'string', queueOrdinal: 'integer', authorUserId: 'string' } },
  'message.claimed': { required: deliveryEvidenceRules() },
  'message.delivered': { required: deliveryEvidenceRules() },
  'message.acknowledged': { required: deliveryEvidenceRules() },
  'message.failed': {
    required: { ...deliveryEvidenceRules(), retryable: 'boolean', error: 'string' },
  },
  'message.cancelled': { required: { messageId: 'string', queueOrdinal: 'integer', authorUserId: 'string' } },
  'github.entity_changed': {
    required: { entity: 'string', number: 'integer', status: 'string' }, optional: { nodeId: 'string' },
    enum: { entity: ['issue', 'pull_request'] },
  },
  'ci.status_changed': { required: { pullRequestNumber: 'integer', status: 'string' } },
  'review.status_changed': { required: { pullRequestNumber: 'integer', status: 'string' } },
  'ultrafix.status_changed': {
    required: { pullRequestNumber: 'integer', status: 'string' }, optional: { cycle: 'integer' },
  },
};

function deliveryEvidenceRules(): Readonly<Record<string, FieldRule>> {
  return {
    messageId: 'string', queueOrdinal: 'integer', sessionId: 'string', turnId: 'string',
    executionId: 'string', attemptId: 'string', controllerId: 'string',
    leaseGeneration: 'integer', deliveryKey: 'string', providerIdempotencyKey: 'string',
    providerSequence: 'integer', providerChunkIndex: 'integer',
  };
}

export interface GoalEventValidationResult {
  ok: boolean;
  error?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validJson(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0);
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.every(item => validJson(item, seen));
  if (!isPlainObject(value)) return false;
  return Object.entries(value).every(([key, child]) => key.length > 0 && validJson(child, seen));
}

function matchesRule(value: unknown, rule: FieldRule): boolean {
  if (rule === 'string') return typeof value === 'string' && value.length > 0;
  if (rule === 'integer') return Number.isSafeInteger(value) && (value as number) >= 0;
  if (rule === 'boolean') return typeof value === 'boolean';
  if (rule === 'output') return typeof value === 'string' || validJson(value);
  return Array.isArray(value) && value.length <= 500 && value.every(item => {
    if (!isPlainObject(item) || Object.keys(item).some(key => !['id', 'text', 'status'].includes(key))) return false;
    return typeof item.id === 'string' && item.id.length > 0
      && typeof item.text === 'string' && item.text.length > 0
      && ['pending', 'in_progress', 'completed'].includes(item.status as string);
  });
}

export function validateDurableGoalEvent(
  value: unknown
): GoalEventValidationResult {
  if (!isPlainObject(value)) return { ok: false, error: 'event must be an object' };
  if (Object.keys(value).some(key => ![
    'schemaVersion', 'type', 'payload', 'source', 'idempotencyKey', 'leaseOwner', 'leaseEpoch',
  ].includes(key))) return { ok: false, error: 'event contains unknown fields' };
  if (value.schemaVersion !== DURABLE_GOAL_EVENT_SCHEMA_VERSION) {
    return { ok: false, error: 'unsupported event schema version' };
  }
  if (typeof value.type !== 'string' || !Object.hasOwn(DURABLE_GOAL_EVENT_REGISTRY, value.type)) {
    return { ok: false, error: 'unknown event type' };
  }
  if (typeof value.idempotencyKey !== 'string' || !value.idempotencyKey.trim()
    || typeof value.leaseOwner !== 'string' || !value.leaseOwner.trim()
    || !Number.isSafeInteger(value.leaseEpoch) || (value.leaseEpoch as number) < 1) {
    return { ok: false, error: 'event fence or idempotency key is invalid' };
  }
  if (!isPlainObject(value.source)
    || Object.keys(value.source).some(key => ![
      'sessionId', 'turnId', 'executionId', 'attemptId', 'providerSequence',
      'chunkIndex', 'leaseGeneration',
    ].includes(key))) return { ok: false, error: 'source identity is invalid' };
  for (const field of ['sessionId', 'turnId', 'executionId', 'attemptId']) {
    if (typeof value.source[field] !== 'string' || !(value.source[field] as string).trim()) {
      return { ok: false, error: `source.${field} is invalid` };
    }
  }
  for (const field of ['providerSequence', 'chunkIndex', 'leaseGeneration']) {
    const number = value.source[field];
    if (!Number.isSafeInteger(number) || (number as number) < (field === 'leaseGeneration' ? 1 : 0)) {
      return { ok: false, error: `source.${field} is invalid` };
    }
  }
  if (!isPlainObject(value.payload)) return { ok: false, error: 'payload must be an object' };
  const schema = DURABLE_GOAL_EVENT_REGISTRY[value.type as DurableGoalEventType];
  const allowed = new Set([...Object.keys(schema.required), ...Object.keys(schema.optional ?? {})]);
  if (Object.keys(value.payload).some(key => !allowed.has(key))) {
    return { ok: false, error: 'payload contains unknown fields' };
  }
  for (const [field, rule] of Object.entries(schema.required)) {
    if (!Object.hasOwn(value.payload, field) || !matchesRule(value.payload[field], rule)) {
      return { ok: false, error: `payload.${field} is invalid` };
    }
  }
  for (const [field, rule] of Object.entries(schema.optional ?? {})) {
    if (Object.hasOwn(value.payload, field) && !matchesRule(value.payload[field], rule)) {
      return { ok: false, error: `payload.${field} is invalid` };
    }
  }
  for (const [field, values] of Object.entries(schema.enum ?? {})) {
    if (!values.includes(value.payload[field] as string)) {
      return { ok: false, error: `payload.${field} is invalid` };
    }
  }
  return { ok: true };
}

export function isDurableGoalEventType(value: string): value is DurableGoalEventType {
  return Object.hasOwn(DURABLE_GOAL_EVENT_REGISTRY, value);
}

export function isProviderGoalEventType(value: string): value is ProviderGoalEventType {
  return (PROVIDER_GOAL_EVENT_TYPES as readonly string[]).includes(value);
}

export function isInternalGoalEventType(value: string): value is InternalGoalEventType {
  return (INTERNAL_GOAL_EVENT_TYPES as readonly string[]).includes(value);
}
