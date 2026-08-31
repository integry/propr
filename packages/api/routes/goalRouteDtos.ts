import type {
  Goal,
  GoalDetail,
  GoalEvent,
  GoalMessage,
  GoalNode,
} from '@propr/core';
import { redactSecrets } from '@propr/core';
import type {
  JsonValue,
  PublicGoalDetailDto,
  PublicGoalDto,
  PublicGoalEventDto,
  PublicGoalMessageDto,
  PublicGoalNodeDto,
} from '@propr/shared';

const PUBLIC_EVENT_PAYLOAD_LIMITS = {
  depth: 16,
  nodes: 512,
  collectionEntries: 100,
  keyBytes: 255,
  stringBytes: 16_384,
  totalStringBytes: 65_536,
} as const;

const SAFE_EVENT_KEY_NAMES = new Set([
  'requestedat',
  'requestedby',
  'requestedmodel',
]);

const PRIVATE_EVENT_KEY_WORDS = new Set([
  'controller',
  'session',
  'owner',
  'lease',
  'epoch',
  'idempotency',
  'claim',
  'request',
  'response',
  'runtime',
  'container',
  'worker',
  'turn',
  'rawturn',
  'worktree',
  'workspace',
  'path',
  'directory',
  'dir',
  'cwd',
  'host',
  'docker',
  'socket',
  'sock',
  'config',
  'configuration',
  'env',
  'environment',
  'mount',
  'volume',
  'credential',
  'fence',
  'secret',
  'password',
  'passwd',
  'passphrase',
  'private',
  'internal',
]);

const PRIVATE_EVENT_KEY_NAMES = new Set([
  'proto',
  'prototype',
  'constructor',
  'apikey',
  'accesstoken',
  'authtoken',
  'refreshtoken',
  'githubtoken',
  'npmtoken',
  'slacktoken',
  'citoken',
  'deploytoken',
  'servicetoken',
  'token',
  'authorization',
  'cookie',
  'setcookie',
  'userid',
  'providerthreadid',
  'lastcheckpoint',
  'recoverymetadata',
  'cwd',
  'dockerhost',
  'dockerhostname',
  'hostpath',
  'hostname',
  'rawturnid',
  'turnid',
  'workerid',
  'workspacepath',
]);

const UNSERIALIZABLE_PAYLOAD_MARKER = '[Unserializable]';

interface PublicPayloadProjectionState {
  nodes: number;
  remainingStringBytes: number;
  seen: WeakSet<object>;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8Bytes(value) <= maxBytes) return value;
  const suffix = '[Truncated]';
  if (maxBytes <= suffix.length) return suffix.slice(0, maxBytes);
  const contentLimit = maxBytes - suffix.length;
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const characterBytes = utf8Bytes(character);
    if (bytes + characterBytes > contentLimit) break;
    result += character;
    bytes += characterBytes;
  }
  return `${result}${suffix}`;
}

function isPrivateEventKey(key: string): boolean {
  const words = key
    .normalize('NFKC')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const normalizedName = words.join('');
  if (SAFE_EVENT_KEY_NAMES.has(normalizedName)) return false;
  if (PRIVATE_EVENT_KEY_NAMES.has(normalizedName)) return true;
  return words.some((word) => PRIVATE_EVENT_KEY_WORDS.has(word)
    || (word.endsWith('s') && PRIVATE_EVENT_KEY_WORDS.has(word.slice(0, -1)))
    || (word.endsWith('ies') && PRIVATE_EVENT_KEY_WORDS.has(`${word.slice(0, -3)}y`)));
}

function isUnsupportedPayloadValue(value: unknown): boolean {
  return value === undefined || typeof value === 'function' || typeof value === 'symbol'
    || typeof value === 'bigint';
}

function applyPayloadToJson(value: object): unknown {
  try {
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    return typeof toJSON === 'function'
      ? (toJSON as (this: object, key: string) => unknown).call(value, '')
      : value;
  } catch {
    return UNSERIALIZABLE_PAYLOAD_MARKER;
  }
}

function projectPublicPayloadValue(
  value: unknown,
  state: PublicPayloadProjectionState,
  depth: number
): JsonValue | undefined {
  if (state.nodes >= PUBLIC_EVENT_PAYLOAD_LIMITS.nodes) return '[Truncated]';
  state.nodes += 1;
  if (depth > PUBLIC_EVENT_PAYLOAD_LIMITS.depth) return '[Truncated]';
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const redacted = redactSecrets(value);
    const allowedBytes = Math.min(
      PUBLIC_EVENT_PAYLOAD_LIMITS.stringBytes,
      state.remainingStringBytes
    );
    const bounded = truncateUtf8(redacted, allowedBytes);
    state.remainingStringBytes -= utf8Bytes(bounded);
    return bounded;
  }
  if (isUnsupportedPayloadValue(value)) return undefined;
  if (value === null || typeof value !== 'object') return null;
  if (state.seen.has(value)) return '[Circular]';
  state.seen.add(value);
  if (Array.isArray(value)) {
    return value
      .slice(0, PUBLIC_EVENT_PAYLOAD_LIMITS.collectionEntries)
      .map((item) => projectPublicPayloadValue(item, state, depth + 1) ?? null);
  }
  const serializable = applyPayloadToJson(value);
  if (serializable !== value) {
    return projectPublicPayloadValue(serializable, state, depth + 1);
  }
  const projected: Record<string, JsonValue> = {};
  let retainedEntries = 0;
  for (const key of Object.keys(value)) {
    if (retainedEntries >= PUBLIC_EVENT_PAYLOAD_LIMITS.collectionEntries) break;
    if (utf8Bytes(key) > PUBLIC_EVENT_PAYLOAD_LIMITS.keyBytes || isPrivateEventKey(key)) continue;
    const child = projectPublicPayloadValue(
      (value as Record<string, unknown>)[key],
      state,
      depth + 1
    );
    if (child !== undefined) {
      projected[key] = child;
      retainedEntries += 1;
    }
  }
  return projected;
}

/** Canonical, conservative projection for all event payloads crossing the API. */
export function toPublicGoalEventPayload(payload: unknown): JsonValue {
  try {
    return projectPublicPayloadValue(payload, {
      nodes: 0,
      remainingStringBytes: PUBLIC_EVENT_PAYLOAD_LIMITS.totalStringBytes,
      seen: new WeakSet(),
    }, 0) ?? null;
  } catch {
    return UNSERIALIZABLE_PAYLOAD_MARKER;
  }
}

/** Explicit public projections keep persistence/controller fields off the wire. */
export function toPublicGoal(goal: Goal): PublicGoalDto {
  return {
    goalId: goal.goalId,
    repository: goal.repository,
    objective: goal.objective,
    state: goal.state,
    agent: goal.agent,
    requestedModel: goal.requestedModel,
    effectiveModel: goal.effectiveModel,
    maxActiveTasks: goal.maxActiveTasks,
    ultrafixEnabled: goal.ultrafixEnabled,
    ultrafixGoal: goal.ultrafixGoal,
    ultrafixMaxCycles: goal.ultrafixMaxCycles,
    mergePolicy: goal.mergePolicy,
    version: goal.version,
    terminalReason: goal.terminalReason,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
  };
}

export function toPublicGoalNode(node: GoalNode): PublicGoalNodeDto {
  return {
    nodeId: node.nodeId,
    goalId: node.goalId,
    parentNodeId: node.parentNodeId,
    kind: node.kind,
    externalRef: node.externalRef,
    externalKind: node.externalKind,
    title: node.title,
    status: node.status,
    orderIndex: node.orderIndex,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
}

export function toPublicGoalMessage(message: GoalMessage): PublicGoalMessageDto {
  return {
    messageId: message.messageId,
    goalId: message.goalId,
    sequence: message.sequence,
    body: message.body,
    predefinedKind: message.predefinedKind,
    state: message.state,
    deliveredAt: message.deliveredAt,
    acknowledgedAt: message.acknowledgedAt,
    createdAt: message.createdAt,
  };
}

export function toPublicGoalEvent(event: GoalEvent): PublicGoalEventDto {
  return {
    goalId: event.goalId,
    sequence: event.sequence,
    kind: event.kind,
    eventType: event.eventType,
    payload: toPublicGoalEventPayload(event.payload),
    createdAt: event.createdAt,
  };
}

export function toPublicGoalDetail(detail: GoalDetail): PublicGoalDetailDto {
  return {
    goal: toPublicGoal(detail.goal),
    nodes: detail.nodes.map(toPublicGoalNode),
    dependencies: detail.dependencies.map((dependency) => ({
      nodeId: dependency.nodeId,
      dependsOnNodeId: dependency.dependsOnNodeId,
    })),
    messages: detail.messages.map(toPublicGoalMessage),
    summary: detail.summary,
    stats: detail.stats,
  };
}
