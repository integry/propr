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
import { redactPublicPathTokens } from './goalRoutePublicStringSanitizer.js';
import { isDurableGoalEventType, validateDurableGoalEvent } from '@propr/shared';

const PUBLIC_EVENT_PAYLOAD_LIMITS = {
  depth: 16,
  nodes: 512,
  collectionEntries: 100,
  keyBytes: 255,
  stringBytes: 16_384,
  totalStringBytes: 65_536,
} as const;

// Event payloads have no persisted schema, so the public boundary must not
// infer safety from an unfamiliar key name. Keep this list to fields that are
// part of the public event vocabulary; every other object member is omitted.
const PUBLIC_EVENT_KEY_NAMES = new Set([
  'auditTrail',
  'count',
  'current',
  'eventLabel',
  'eventName',
  'repositoryOwner',
  'requestedModel',
  'requestedAt',
  'pullRequestNumber',
  'prNumber',
  'filePath',
  'index',
  'label',
  'line',
  'message',
  'name',
  'nested',
  'note',
  'pathDescription',
  'paths',
  'progress',
  'relativeCopy',
  'relativePath',
  'safeArray',
  'safeSource',
  'sensitiveCopy',
  'setting',
  'socketDescription',
  'source',
  'status',
  'target',
  'total',
  'value',
]);

const TYPED_EVENT_KEY_NAMES = new Set([
  'from',
  'to',
  'reason',
  'terminalReason',
  'nodeId',
  'attemptId',
  'blockedReason',
  'stream',
  'outputType',
  'chunk',
  'originalType',
  'contentDigest',
  'payloadBytes',
  'items',
  'id',
  'text',
  'provider',
  'model',
  'occurrenceId',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
  'cumulative',
  'checkpointId',
  'messageId',
  'queueOrdinal',
  'authorUserId',
  'turnId',
  'sessionId',
  'executionId',
  'controllerId',
  'leaseGeneration',
  'deliveryKey',
  'providerIdempotencyKey',
  'providerSequence',
  'providerChunkIndex',
  'retryable',
  'error',
  'entity',
  'number',
  'pullRequestNumber',
  'cycle',
  'status',
]);

const UNSERIALIZABLE_PAYLOAD_MARKER = '[Unserializable]';
const SENSITIVE_PATH_MARKER = '[REDACTED_SENSITIVE_PATH]';
// The longest minimum provider token recognized by redactSecrets is currently
// 73 ASCII bytes. Keep a generous fixed window so a token beginning immediately
// before either public byte cutoff can still be classified without scanning an
// attacker-sized string.
const PUBLIC_EVENT_REDACTION_LOOKAHEAD_BYTES = 256;
// Raw sockets, Docker hosts, Windows paths, roots, and credential paths share
// explicit opening/closing token delimiters. A pipe is a raw boundary only when
// it is not attached to a word; embedded file-URI pipe suffixes are classified
// by the shared public-string classifier before these patterns run.
const IPV6_HEXTET_SOURCE = '[0-9A-F]{1,4}';
const IPV4_OCTET_SOURCE = '(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])';
const IPV4_ADDRESS_SOURCE = `${IPV4_OCTET_SOURCE}(?:\\.${IPV4_OCTET_SOURCE}){3}`;
const IPV6_LOW_32_BITS_SOURCE =
  `(?:${IPV6_HEXTET_SOURCE}:${IPV6_HEXTET_SOURCE}|${IPV4_ADDRESS_SOURCE})`;
const IPV6_ADDRESS_SOURCE = [
  `(?:${IPV6_HEXTET_SOURCE}:){6}${IPV6_LOW_32_BITS_SOURCE}`,
  `::(?:${IPV6_HEXTET_SOURCE}:){5}${IPV6_LOW_32_BITS_SOURCE}`,
  `(?:${IPV6_HEXTET_SOURCE})?::(?:${IPV6_HEXTET_SOURCE}:){4}${IPV6_LOW_32_BITS_SOURCE}`,
  `(?:(?:${IPV6_HEXTET_SOURCE}:){0,1}${IPV6_HEXTET_SOURCE})?::`
    + `(?:${IPV6_HEXTET_SOURCE}:){3}${IPV6_LOW_32_BITS_SOURCE}`,
  `(?:(?:${IPV6_HEXTET_SOURCE}:){0,2}${IPV6_HEXTET_SOURCE})?::`
    + `(?:${IPV6_HEXTET_SOURCE}:){2}${IPV6_LOW_32_BITS_SOURCE}`,
  `(?:(?:${IPV6_HEXTET_SOURCE}:){0,3}${IPV6_HEXTET_SOURCE})?::`
    + `${IPV6_HEXTET_SOURCE}:${IPV6_LOW_32_BITS_SOURCE}`,
  `(?:(?:${IPV6_HEXTET_SOURCE}:){0,4}${IPV6_HEXTET_SOURCE})?::`
    + IPV6_LOW_32_BITS_SOURCE,
  `(?:(?:${IPV6_HEXTET_SOURCE}:){0,5}${IPV6_HEXTET_SOURCE})?::${IPV6_HEXTET_SOURCE}`,
  `(?:(?:${IPV6_HEXTET_SOURCE}:){0,6}${IPV6_HEXTET_SOURCE})?::`,
].join('|');
const BRACKETED_IPV6_DOCKER_HOST_SOURCE =
  `\\[(?:${IPV6_ADDRESS_SOURCE})(?:%25(?:[0-9A-Z._~-]|%[0-9A-F]{2}){1,64})?\\]`;
const DOCKER_TCP_HOSTNAME_SOURCE = /[^\s"'`<>/?#,;|()[\]{}&:]+/u.source;
const DOCKER_TCP_PORT_SOURCE = '0*(?:2375|2376)';
const DOCKER_TCP_EVENT_VALUE_PATTERN = new RegExp(
  /(^|[\s"'`=()[\]{:};,&]|(?<![\p{L}\p{N}])\|)tcp:\/\//u.source
    + `(?:${DOCKER_TCP_HOSTNAME_SOURCE}|${BRACKETED_IPV6_DOCKER_HOST_SOURCE})`
    + `:${DOCKER_TCP_PORT_SOURCE}`
    + /(?=\/|[?#,;|()[\]{}&\s"'`<>]|$)(?:\/[^\s"'`<>?#,;|()[\]{}&]*)?/u.source,
  'gimu'
);
const SENSITIVE_EVENT_VALUE_PATTERNS = [
  /(^|[\s"'`=()[\]{:};,&]|(?<![\p{L}\p{N}])\|)(?:unix|npipe):\/\/[^\s"'`<>?#,;|()[\]{}&]+/gimu,
  DOCKER_TCP_EVENT_VALUE_PATTERN,
  /(^|[\s"'`=()[\]{:};,&]|(?<![\p{L}\p{N}])\|)\/(?:app|builds?|data|github|home|root|users|private|var|run|tmp|srv|workspaces?|worktrees?|mnt|etc|opt)(?=\/|[?#,;|()[\]{}&\s"'`<>]|$)(?:\/[^\s"'`<>?#,;|()[\]{}&]*)?/gimu,
  /(^|[\s"'`=()[\]{:};,&]|(?<![\p{L}\p{N}])\|)\/(?:[^\s"'`<>/]+\/)*(?:\.env(?!\.example(?=\/|[?#,;|()[\]{}&\s"'`<>]|$))(?:\.[^\s"'`<>/?#,;|()[\]{}&]+)?|\.npmrc|\.netrc|\.git-credentials|\.ssh|\.aws|\.azure|\.config|\.docker|\.kube|\.gnupg|configs?|configuration|credentials?|docker\.sock|secrets?|workspaces?|worktrees?)(?=\/|[?#,;|()[\]{}&\s"'`<>]|$)(?:\/[^\s"'`<>?#,;|()[\]{}&]*)?/gimu,
  /(^|[\s"'`=()[\]{:};,&]|(?<![\p{L}\p{N}])\|)[A-Z](?::|%3A)(?:[\\/]|%2F|%5C)(?:Users|Windows|ProgramData|workspaces?|worktrees?)(?=(?:[\\/]|%2F|%5C)|[?#,;|()[\]{}&\s"'`<>]|$)(?:(?:[\\/]|%2F|%5C)[^\s"'`<>?#,;|()[\]{}&]*)?/gimu,
] as const;
const INCOMPLETE_SENSITIVE_EVENT_VALUE_PATTERN =
  /(^|[\s"'`=()[\]{:};,&]|(?<![\p{L}\p{N}])\|)(?:tcp:\/\/[^\s"'`<>]*|\/(?!\/)[^\s"'`<>]*|[A-Z]:[\\/][^\s"'`<>]*)$/gimu;

interface PublicPayloadProjectionState {
  nodes: number;
  remainingStringBytes: number;
  seen: WeakSet<object>;
  allowedKeys: ReadonlySet<string>;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function takeUtf8Prefix(value: string, maxBytes: number): {
  value: string;
  truncated: boolean;
} {
  if (maxBytes <= 0) return { value: '', truncated: value.length > 0 };
  const characters: string[] = [];
  let bytes = 0;
  for (const character of value) {
    const characterBytes = utf8Bytes(character);
    if (bytes + characterBytes > maxBytes) {
      return { value: characters.join(''), truncated: true };
    }
    characters.push(character);
    bytes += characterBytes;
  }
  return { value: characters.join(''), truncated: false };
}

function truncateUtf8(value: string, maxBytes: number): string {
  const suffix = '[Truncated]';
  const characters: string[] = [];
  if (maxBytes <= 0) return '';
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const characterBytes = utf8Bytes(character);
    if (bytes + characterBytes > maxBytes) {
      const contentLimit = Math.max(0, maxBytes - suffix.length);
      let lastRemoved: string | undefined;
      while (bytes > contentLimit) {
        lastRemoved = characters.pop()!;
        bytes -= utf8Bytes(lastRemoved);
      }
      if (maxBytes - bytes > suffix.length && lastRemoved !== undefined) {
        characters.push(lastRemoved);
        bytes += utf8Bytes(lastRemoved);
      }
      return `${characters.join('')}${suffix.slice(0, maxBytes - bytes)}`;
    }
    characters.push(character);
    bytes += characterBytes;
  }
  result = characters.join('');
  return result;
}

function redactSensitiveEventValues(value: string, inputTruncated: boolean): string {
  let sanitized = redactPublicPathTokens(value, inputTruncated);
  sanitized = redactSecrets(sanitized);
  for (const pattern of SENSITIVE_EVENT_VALUE_PATTERNS) {
    sanitized = sanitized.replace(pattern, `$1${SENSITIVE_PATH_MARKER}`);
  }
  if (inputTruncated) {
    // A very long Docker TCP host or absolute path may hide its sensitive
    // component beyond the fixed inspection window. Fail closed only for the
    // unterminated suffix; ordinary complete and relative paths stay intact.
    sanitized = sanitized.replace(
      INCOMPLETE_SENSITIVE_EVENT_VALUE_PATTERN,
      `$1${SENSITIVE_PATH_MARKER}`
    );
  }
  return sanitized;
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
    const allowedBytes = Math.min(
      PUBLIC_EVENT_PAYLOAD_LIMITS.stringBytes,
      state.remainingStringBytes
    );
    if (allowedBytes <= 0) return '';
    const inspected = takeUtf8Prefix(
      value,
      allowedBytes + PUBLIC_EVENT_REDACTION_LOOKAHEAD_BYTES
    );
    const bounded = truncateUtf8(
      redactSensitiveEventValues(inspected.value, inspected.truncated),
      allowedBytes
    );
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
    if (utf8Bytes(key) > PUBLIC_EVENT_PAYLOAD_LIMITS.keyBytes
      || !state.allowedKeys.has(key)) continue;
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
  return projectEventPayload(payload, PUBLIC_EVENT_KEY_NAMES);
}

function projectEventPayload(payload: unknown, allowedKeys: ReadonlySet<string>): JsonValue {
  try {
    return projectPublicPayloadValue(payload, {
      nodes: 0,
      remainingStringBytes: PUBLIC_EVENT_PAYLOAD_LIMITS.totalStringBytes,
      seen: new WeakSet(),
      allowedKeys,
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
    authorUserId: message.authorUserId,
    cannedAction: message.cannedAction,
    predefinedKind: message.predefinedKind,
    state: message.state,
    deliveredAt: message.deliveredAt,
    acknowledgedAt: message.acknowledgedAt,
    cancelledAt: message.cancelledAt,
    createdAt: message.createdAt,
  };
}

export function toPublicGoalEvent(event: GoalEvent): PublicGoalEventDto {
  let payload = toPublicGoalEventPayload(event.payload);
  if (isDurableGoalEventType(event.eventType)) {
    const validation = validateDurableGoalEvent({
      schemaVersion: event.schemaVersion,
      type: event.eventType,
      payload: event.payload,
      source: {
        sessionId: 'public', turnId: 'public', executionId: 'public', attemptId: 'public',
        providerSequence: 0, chunkIndex: 0, leaseGeneration: 1,
      },
      idempotencyKey: 'public', leaseOwner: 'public', leaseEpoch: 1,
    });
    payload = validation.ok ? projectEventPayload(event.payload, TYPED_EVENT_KEY_NAMES) : null;
  }
  return {
    schemaVersion: 1,
    goalId: event.goalId,
    sequence: event.sequence,
    kind: event.kind,
    eventType: event.eventType,
    payload,
    createdAt: event.createdAt,
    cursor: event.cursor ?? (() => { throw new Error('Paged goal event is missing its canonical cursor'); })(),
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
    messagesNextCursor: detail.messagesNextCursor,
    checklistNextCursor: detail.checklistNextCursor,
    summary: detail.summary,
    stats: detail.stats,
    providerAdvisoryTodos: detail.providerAdvisoryTodos,
    asOfVersion: detail.asOfVersion,
    asOfSequence: detail.asOfSequence,
  };
}
