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

const PUBLIC_EVENT_KEY_NAMES = new Set([
  'repositoryOwner',
  'requestedModel',
  'requestedAt',
  'pullRequestNumber',
  'prNumber',
  'filePath',
]);

const PRIVATE_EVENT_KEY_FAMILIES = new Set((
  'controller session lease epoch idempotency claim request response runtime container worker turn owner '
  + 'worktree workspace directory dir cwd host docker config configuration env environment mount mounts '
  + 'volume volumes credential credentials fence secret secrets password passwd passphrase private internal '
  + 'token authorization cookie'
).split(' '));

const PRIVATE_EVENT_KEY_NAMES = new Set([
  'owner',
  'rawturn',
  'path',
  'socket',
  'sock',
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
  'setcookie',
  // Camel-case splitting produces "requested"/"by", so deny the joined normalized name.
  'requestedby',
  'userid',
  'providerthreadid',
  'lastcheckpoint',
  'recoverymetadata',
  'dockerhost',
  'dockerhostname',
  'hostpath',
  'hostname',
  'rawturnid',
  'turnid',
  'workerid',
  'workspacepath',
  'worktreepath',
  'runtimepath',
  'containerpath',
  'configpath',
  'credentialpath',
]);

const PRIVATE_EVENT_KEY_SUFFIXES = [
  // Deliberately use specific ownership/request identities, not generic owner/request suffixes.
  // repositoryOwner, requestedModel, and pullRequestNumber are public event context.
  'owneruserid',
  'leaseowner',
  'controllerowner',
  'leaseepoch',
  'sessionid',
  'idempotencykey',
  'claimtoken',
  'requestid',
  'requestheaders',
  'requestbody',
  'requestmetadata',
  'requestcontext',
  'responseheaders',
  'responsebody',
  'responsemetadata',
  'responsecontext',
  'containerid',
  'workerid',
  'rawturnid',
  'turnid',
  'providerthreadid',
  'lastcheckpoint',
  'recoverymetadata',
  'requestedby',
  'epoch',
  'cwd',
  'host',
  'hostname',
  'socket',
  'sock',
  'config',
  'configuration',
  'env',
  'environment',
  'mount',
  'mounts',
  'volume',
  'volumes',
  'credential',
  'credentials',
  'apikey',
  'token',
  'authorization',
  'cookie',
  'secret',
  'secrets',
  'password',
  'passwd',
  'passphrase',
  'private',
  'internal',
] as const;

const UNSERIALIZABLE_PAYLOAD_MARKER = '[Unserializable]';
const SENSITIVE_PATH_MARKER = '[REDACTED_SENSITIVE_PATH]';
// The longest minimum provider token recognized by redactSecrets is currently
// 73 ASCII bytes. Keep a generous fixed window so a token beginning immediately
// before either public byte cutoff can still be classified without scanning an
// attacker-sized string.
const PUBLIC_EVENT_REDACTION_LOOKAHEAD_BYTES = 256;
const SENSITIVE_EVENT_VALUE_PATTERNS = [
  /(^|[\s"'`=(,:])(?:unix|npipe):\/\/[^\s"'`<>]+/gimu,
  /(^|[\s"'`=(,:])tcp:\/\/[^\s"'`<>]+(?::2375|:2376)(?:\/[^\s"'`<>]*)?/gimu,
  /(^|[\s"'`=(,:])\/(?:app|builds?|data|github|home|root|users|private|var|run|tmp|srv|workspaces?|worktrees?|mnt|etc|opt)(?:\/[^\s"'`<>]*)?/gimu,
  /(^|[\s"'`=(,:])\/(?:[^\s"'`<>/]+\/)*(?:\.env|\.npmrc|\.netrc|\.git-credentials|\.ssh|\.aws|\.azure|\.config|\.docker|\.kube|\.gnupg|configs?|configuration|credentials?|docker\.sock|secrets?|workspaces?|worktrees?)(?=\/|[\s"'`<>]|$)(?:\/[^\s"'`<>]*)?/gimu,
  /(^|[\s"'`=(,:])[A-Z]:[\\/](?:Users|Windows|ProgramData|workspaces?|worktrees?)[^\s"'`<>]*/gimu,
] as const;
const INCOMPLETE_SENSITIVE_EVENT_VALUE_PATTERN =
  /(^|[\s"'`=(,:])(?:tcp:\/\/[^\s"'`<>]*|\/(?!\/)[^\s"'`<>]*|[A-Z]:[\\/][^\s"'`<>]*)$/gimu;

interface PublicPayloadProjectionState {
  nodes: number;
  remainingStringBytes: number;
  seen: WeakSet<object>;
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
  let sanitized = redactSecrets(value);
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

function isPrivateEventKey(key: string): boolean {
  const normalizedKey = key.normalize('NFKC');
  if (PUBLIC_EVENT_KEY_NAMES.has(normalizedKey)) return false;
  const words = normalizedKey
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const normalizedName = words.join('');
  const isCredentialKey = words.some((word) => word === 'key' || word === 'keys')
    || /^[a-z0-9]*keys?(?:id|value|material|metadata)$/.test(normalizedName);
  return PRIVATE_EVENT_KEY_NAMES.has(normalizedName)
    || isCredentialKey
    || words.some((word) => PRIVATE_EVENT_KEY_FAMILIES.has(word))
    || PRIVATE_EVENT_KEY_SUFFIXES.some((suffix) => normalizedName.endsWith(suffix));
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
