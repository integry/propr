/* eslint-disable max-lines -- strict wire decoders intentionally stay beside the temporary V1 client contract */
import { API_BASE_URL, apiFetch, handleApiResponse } from './apiClient';
import {
  GOAL_MERGE_POLICIES,
  GOAL_EVENT_TYPES,
  GOAL_MESSAGE_STATES,
  GOAL_NODE_KINDS,
  GOAL_NODE_STATES,
  GOAL_STATES,
  type CreateGoalRequestV1,
  type GoalDetailV1,
  type GoalEventType,
  type GoalEventV1,
  type GoalEventsPageV1,
  type GoalHierarchyNodeV1,
  type GoalJsonValue,
  type GoalMessageV1,
  type GoalProjectionReadyV1,
  type GoalProjectionV1,
  type GoalRecordV1,
  type GoalsListResponseV1,
  type GoalState,
  type GoalSummaryV1,
} from './goalContracts';

export { GOAL_STATES } from './goalContracts';
export type {
  CreateGoalRequestV1 as CreateGoalParams,
  GoalMergePolicy,
  GoalRecordV1,
  GoalsListResponseV1 as GoalsListResponse,
  GoalState,
  GoalSummaryV1 as GoalListItem,
  GoalDetailV1 as GoalDetail,
  GoalEventV1 as GoalEvent,
  GoalEventType,
  GoalEventsPageV1 as GoalEventsPage,
  GoalMessageV1 as GoalMessage,
} from './goalContracts';

export const GOALS_LIST_LIMIT_MIN = 1;
export const GOALS_LIST_LIMIT_MAX = 100;
export const GOALS_SEARCH_MAX_LENGTH = 200;
export const GOALS_CURSOR_MAX_LENGTH = 1024;
const GOAL_IDENTIFIER_MAX_LENGTH = 255;
const GOAL_IDEMPOTENCY_KEY_MAX_LENGTH = 255;
const BASE64URL_CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface GetGoalsOptions {
  limit?: number;
  state?: GoalState;
  repository?: string;
  search?: string;
  cursor?: string;
}

export interface GoalRequestOptions {
  signal?: AbortSignal;
}

export class GoalContractError extends Error {
  constructor(path: string, expected: string) {
    super(`Goal API contract mismatch at ${path}: expected ${expected}. Please update the UI and backend together.`);
    this.name = 'GoalContractError';
  }
}

export class GoalApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = 'GoalApiError';
    this.code = code;
    this.status = status;
  }
}

export const isGoalApiErrorCode = (error: unknown, code: string): boolean =>
  error instanceof GoalApiError && error.code === code;

const record = (value: unknown, path: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GoalContractError(path, 'an object');
  }
  return value as Record<string, unknown>;
};

const string = (value: unknown, path: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new GoalContractError(path, 'a non-empty string');
  return value;
};

const timestamp = (value: unknown, path: string): string => {
  const result = string(value, path);
  if (!Number.isFinite(Date.parse(result))) throw new GoalContractError(path, 'an ISO timestamp');
  return result;
};

const integer = (value: unknown, path: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new GoalContractError(path, 'a non-negative safe integer');
  }
  return value as number;
};

const bool = (value: unknown, path: string): boolean => {
  if (typeof value !== 'boolean') throw new GoalContractError(path, 'a boolean');
  return value;
};

const nullableString = (value: unknown, path: string): string | null => {
  if (value === null) return null;
  if (typeof value !== 'string') throw new GoalContractError(path, 'a string or null');
  return value;
};

const array = (value: unknown, path: string): unknown[] => {
  if (!Array.isArray(value)) throw new GoalContractError(path, 'an array');
  return value;
};

const nullableBoundedInteger = (
  value: unknown,
  path: string,
  minimum: number,
  maximum: number
): number | null => {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new GoalContractError(path, `null or an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
};

const enumValue = <T extends string>(value: unknown, values: readonly T[], path: string): T => {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new GoalContractError(path, `one of ${values.join(', ')}`);
  }
  return value as T;
};

const decodeGoalRecord = (value: unknown, path: string): GoalRecordV1 => {
  const goal = record(value, path);
  if (typeof goal.ultrafixEnabled !== 'boolean') {
    throw new GoalContractError(`${path}.ultrafixEnabled`, 'a boolean');
  }
  return {
    goalId: string(goal.goalId, `${path}.goalId`),
    objective: string(goal.objective, `${path}.objective`),
    repository: string(goal.repository, `${path}.repository`),
    state: enumValue(goal.state, GOAL_STATES, `${path}.state`),
    agent: string(goal.agent, `${path}.agent`),
    requestedModel: string(goal.requestedModel, `${path}.requestedModel`),
    effectiveModel: string(goal.effectiveModel, `${path}.effectiveModel`),
    maxActiveTasks: boundedInteger(goal.maxActiveTasks, `${path}.maxActiveTasks`, 1, 20),
    mergePolicy: enumValue(goal.mergePolicy, GOAL_MERGE_POLICIES, `${path}.mergePolicy`),
    ultrafixEnabled: goal.ultrafixEnabled,
    ultrafixGoal: nullableBoundedInteger(goal.ultrafixGoal, `${path}.ultrafixGoal`, 1, 10),
    ultrafixMaxCycles: nullableBoundedInteger(goal.ultrafixMaxCycles, `${path}.ultrafixMaxCycles`, 1, 20),
    version: integer(goal.version, `${path}.version`),
    createdAt: timestamp(goal.createdAt, `${path}.createdAt`),
    updatedAt: timestamp(goal.updatedAt, `${path}.updatedAt`),
  };
};

function boundedInteger(value: unknown, path: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new GoalContractError(path, `an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

const projectionCount = (container: Record<string, unknown>, key: string, path: string): number =>
  integer(container[key], `${path}.${key}`);

const codePointLength = (value: string): number => Array.from(value).length;

const isBoundedCursor = (value: string): boolean =>
  value.length > 0
  && value.length <= GOALS_CURSOR_MAX_LENGTH
  && BASE64URL_CURSOR_PATTERN.test(value);

const decodeReadyProjection = (value: Record<string, unknown>, path: string): GoalProjectionReadyV1 => {
  const checklist = record(value.checklist, `${path}.checklist`);
  const issues = record(value.issues, `${path}.issues`);
  const pullRequests = record(value.pullRequests, `${path}.pullRequests`);
  const tokens = record(value.tokens, `${path}.tokens`);
  const time = record(value.time, `${path}.time`);
  const total = projectionCount(checklist, 'total', `${path}.checklist`);
  const completed = projectionCount(checklist, 'completed', `${path}.checklist`);
  if (completed > total) throw new GoalContractError(`${path}.checklist.completed`, 'a count no greater than total');
  const connectionState = enumValue(value.connectionState, ['connected', 'recovering', 'disconnected'], `${path}.connectionState`);
  if (value.latestEvent !== null && typeof value.latestEvent !== 'string') throw new GoalContractError(`${path}.latestEvent`, 'a string or null');
  if (value.epicPrUrl !== null && typeof value.epicPrUrl !== 'string') throw new GoalContractError(`${path}.epicPrUrl`, 'a string or null');
  return {
    status: 'ready',
    checklist: { total, completed },
    issues: {
      total: projectionCount(issues, 'total', `${path}.issues`),
      active: projectionCount(issues, 'active', `${path}.issues`),
      processed: projectionCount(issues, 'processed', `${path}.issues`),
      failed: projectionCount(issues, 'failed', `${path}.issues`),
      blocked: projectionCount(issues, 'blocked', `${path}.issues`),
    },
    pullRequests: {
      open: projectionCount(pullRequests, 'open', `${path}.pullRequests`),
      reviewPending: projectionCount(pullRequests, 'reviewPending', `${path}.pullRequests`),
      ultrafixPending: projectionCount(pullRequests, 'ultrafixPending', `${path}.pullRequests`),
      mergeReady: projectionCount(pullRequests, 'mergeReady', `${path}.pullRequests`),
      merged: projectionCount(pullRequests, 'merged', `${path}.pullRequests`),
    },
    tokens: { total: projectionCount(tokens, 'total', `${path}.tokens`) },
    time: {
      elapsedSeconds: projectionCount(time, 'elapsedSeconds', `${path}.time`),
      activeSeconds: projectionCount(time, 'activeSeconds', `${path}.time`),
      pausedSeconds: projectionCount(time, 'pausedSeconds', `${path}.time`),
    },
    latestEvent: value.latestEvent as string | null,
    connectionState,
    epicPrUrl: value.epicPrUrl as string | null,
  };
};

const decodeProjection = (value: unknown, path: string): GoalProjectionV1 => {
  if (value === undefined) return { status: 'not-yet-projected' };
  const projection = record(value, path);
  if (projection.status === 'not-yet-projected') return { status: 'not-yet-projected' };
  if (projection.status === 'ready') return decodeReadyProjection(projection, path);
  throw new GoalContractError(`${path}.status`, 'ready or not-yet-projected');
};

const decodeGoalSummary = (value: unknown, path: string): GoalSummaryV1 => {
  const goal = record(value, path);
  return {
    ...decodeGoalRecord(goal, path),
    nodeCount: integer(goal.nodeCount, `${path}.nodeCount`),
    activeNodeCount: integer(goal.activeNodeCount, `${path}.activeNodeCount`),
    latestSequence: integer(goal.latestSequence, `${path}.latestSequence`),
    projection: decodeProjection(goal.projection, `${path}.projection`),
  };
};

const decodeJsonValue = (value: unknown, path: string, depth = 0): GoalJsonValue => {
  if (depth > 24) throw new GoalContractError(path, 'bounded JSON data');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => decodeJsonValue(item, `${path}[${index}]`, depth + 1));
  const object = record(value, path);
  return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, decodeJsonValue(child, `${path}.${key}`, depth + 1)]));
};

const decodeHierarchyNode = (value: unknown, path: string): GoalHierarchyNodeV1 => {
  const node = record(value, path);
  return {
    nodeId: string(node.nodeId, `${path}.nodeId`),
    parentNodeId: nullableString(node.parentNodeId, `${path}.parentNodeId`),
    kind: enumValue(node.kind, GOAL_NODE_KINDS, `${path}.kind`),
    title: string(node.title, `${path}.title`),
    state: enumValue(node.state, GOAL_NODE_STATES, `${path}.state`),
    orderIndex: integer(node.orderIndex, `${path}.orderIndex`),
    externalRef: nullableString(node.externalRef, `${path}.externalRef`),
    externalUrl: nullableString(node.externalUrl, `${path}.externalUrl`),
    blockedReason: nullableString(node.blockedReason, `${path}.blockedReason`),
    ci: enumValue(node.ci, ['pending', 'running', 'passed', 'failed', 'not_applicable'], `${path}.ci`),
    review: enumValue(node.review, ['pending', 'approved', 'changes_requested', 'not_applicable'], `${path}.review`),
    ultrafix: enumValue(node.ultrafix, ['pending', 'running', 'passed', 'failed', 'not_applicable'], `${path}.ultrafix`),
    merge: enumValue(node.merge, ['pending', 'ready', 'merged', 'failed', 'not_applicable'], `${path}.merge`),
  };
};

const decodeMessage = (value: unknown, path: string): GoalMessageV1 => {
  const message = record(value, path);
  const rawState = message.state === 'queued' ? 'pending' : message.state;
  return {
    messageId: string(message.messageId, `${path}.messageId`),
    sequence: integer(message.sequence, `${path}.sequence`),
    body: typeof message.body === 'string' ? message.body : (() => { throw new GoalContractError(`${path}.body`, 'a string'); })(),
    predefinedKind: message.predefinedKind === null ? null : enumValue(message.predefinedKind, ['whats_done', 'whats_left'] as const, `${path}.predefinedKind`),
    state: enumValue(rawState, GOAL_MESSAGE_STATES, `${path}.state`),
    responseSource: message.responseSource === null ? null : enumValue(message.responseSource, ['controller', 'provider'] as const, `${path}.responseSource`),
    response: nullableString(message.response, `${path}.response`),
    error: nullableString(message.error, `${path}.error`),
    createdAt: timestamp(message.createdAt, `${path}.createdAt`),
    updatedAt: timestamp(message.updatedAt, `${path}.updatedAt`),
  };
};

const decodeGoalDetail = (value: unknown): GoalDetailV1 => {
  const body = record(value, 'response');
  const goalWire = record(body.goal, 'response.goal');
  const hierarchy = record(body.hierarchy, 'response.hierarchy');
  const stats = record(body.stats, 'response.stats');
  const issues = record(stats.issues, 'response.stats.issues');
  const pullRequests = record(stats.pullRequests, 'response.stats.pullRequests');
  const tokens = record(stats.tokens, 'response.stats.tokens');
  const time = record(stats.time, 'response.stats.time');
  const recovery = record(body.recovery, 'response.recovery');
  return {
    goal: { ...decodeGoalRecord(goalWire, 'response.goal'), terminalReason: nullableString(goalWire.terminalReason, 'response.goal.terminalReason') },
    hierarchy: {
      nodes: array(hierarchy.nodes, 'response.hierarchy.nodes').map((node, index) => decodeHierarchyNode(node, `response.hierarchy.nodes[${index}]`)),
      dependencies: array(hierarchy.dependencies, 'response.hierarchy.dependencies').map((item, index) => {
        const dependency = record(item, `response.hierarchy.dependencies[${index}]`);
        return {
          nodeId: string(dependency.nodeId, `response.hierarchy.dependencies[${index}].nodeId`),
          dependsOnNodeId: string(dependency.dependsOnNodeId, `response.hierarchy.dependencies[${index}].dependsOnNodeId`),
        };
      }),
    },
    providerTodos: array(body.providerTodos, 'response.providerTodos').map((item, index) => {
      const todo = record(item, `response.providerTodos[${index}]`);
      return {
        todoId: string(todo.todoId, `response.providerTodos[${index}].todoId`),
        provider: string(todo.provider, `response.providerTodos[${index}].provider`),
        content: string(todo.content, `response.providerTodos[${index}].content`),
        status: enumValue(todo.status, ['pending', 'in_progress', 'completed'], `response.providerTodos[${index}].status`),
        updatedAt: timestamp(todo.updatedAt, `response.providerTodos[${index}].updatedAt`),
      };
    }),
    messages: array(body.messages, 'response.messages').map((message, index) => decodeMessage(message, `response.messages[${index}]`)),
    stats: {
      issues: {
        total: projectionCount(issues, 'total', 'response.stats.issues'),
        active: projectionCount(issues, 'active', 'response.stats.issues'),
        processed: projectionCount(issues, 'processed', 'response.stats.issues'),
        failed: projectionCount(issues, 'failed', 'response.stats.issues'),
        blocked: projectionCount(issues, 'blocked', 'response.stats.issues'),
      },
      pullRequests: {
        open: projectionCount(pullRequests, 'open', 'response.stats.pullRequests'),
        reviewPending: projectionCount(pullRequests, 'reviewPending', 'response.stats.pullRequests'),
        ultrafixPending: projectionCount(pullRequests, 'ultrafixPending', 'response.stats.pullRequests'),
        mergeReady: projectionCount(pullRequests, 'mergeReady', 'response.stats.pullRequests'),
        merged: projectionCount(pullRequests, 'merged', 'response.stats.pullRequests'),
      },
      tokens: {
        total: projectionCount(tokens, 'total', 'response.stats.tokens'),
        byModel: array(tokens.byModel, 'response.stats.tokens.byModel').map((item, index) => {
          const breakdown = record(item, `response.stats.tokens.byModel[${index}]`);
          const prefix = `response.stats.tokens.byModel[${index}]`;
          return {
            provider: string(breakdown.provider, `${prefix}.provider`), model: string(breakdown.model, `${prefix}.model`),
            input: integer(breakdown.input, `${prefix}.input`), output: integer(breakdown.output, `${prefix}.output`),
            cacheRead: integer(breakdown.cacheRead, `${prefix}.cacheRead`), cacheWrite: integer(breakdown.cacheWrite, `${prefix}.cacheWrite`),
            reasoning: integer(breakdown.reasoning, `${prefix}.reasoning`), total: integer(breakdown.total, `${prefix}.total`),
          };
        }),
      },
      time: {
        elapsedSeconds: projectionCount(time, 'elapsedSeconds', 'response.stats.time'),
        activeSeconds: projectionCount(time, 'activeSeconds', 'response.stats.time'),
        pausedSeconds: projectionCount(time, 'pausedSeconds', 'response.stats.time'),
        recoverySeconds: projectionCount(time, 'recoverySeconds', 'response.stats.time'),
      },
    },
    recovery: {
      state: enumValue(recovery.state, ['healthy', 'recovering', 'offline'], 'response.recovery.state'),
      attempt: integer(recovery.attempt, 'response.recovery.attempt'),
      reason: nullableString(recovery.reason, 'response.recovery.reason'),
    },
    epicPrUrl: nullableString(body.epicPrUrl, 'response.epicPrUrl'),
    completionBlockers: array(body.completionBlockers, 'response.completionBlockers').map((blocker, index) => string(blocker, `response.completionBlockers[${index}]`)),
    latestSequence: integer(body.latestSequence, 'response.latestSequence'),
  };
};

export const decodeGoalEvent = (value: unknown, path = 'event'): GoalEventV1 => {
  const event = record(value, path);
  const payload = decodeJsonValue(event.payload ?? null, `${path}.payload`);
  const payloadRecord = payload && !Array.isArray(payload) && typeof payload === 'object' ? payload : null;
  const rawType = event.type ?? event.eventType ?? payloadRecord?.type ?? payloadRecord?.stream;
  const content = event.content ?? payloadRecord?.content ?? payloadRecord?.text ?? '';
  if (typeof content !== 'string') throw new GoalContractError(`${path}.content`, 'a string');
  return {
    goalId: string(event.goalId, `${path}.goalId`),
    sequence: integer(event.sequence, `${path}.sequence`),
    type: enumValue(rawType, GOAL_EVENT_TYPES, `${path}.type`) as GoalEventType,
    source: string(event.source ?? event.kind, `${path}.source`),
    timestamp: timestamp(event.timestamp ?? event.createdAt, `${path}.timestamp`),
    turnId: nullableString(event.turnId ?? null, `${path}.turnId`),
    content,
    payload,
  };
};

const decodeEventsPage = (value: unknown): GoalEventsPageV1 => {
  const body = record(value, 'response');
  return {
    events: array(body.events, 'response.events').map((event, index) => decodeGoalEvent(event, `response.events[${index}]`)),
    previousCursor: body.previousCursor === null ? null : integer(body.previousCursor, 'response.previousCursor'),
    nextCursor: body.nextCursor === null ? null : integer(body.nextCursor, 'response.nextCursor'),
    hasMoreBefore: bool(body.hasMoreBefore, 'response.hasMoreBefore'),
  };
};

const decodeListResponse = (value: unknown): GoalsListResponseV1 => {
  const body = record(value, 'response');
  if (!Array.isArray(body.goals)) throw new GoalContractError('response.goals', 'an array');
  if (body.nextCursor !== null
    && (typeof body.nextCursor !== 'string' || !isBoundedCursor(body.nextCursor))) {
    throw new GoalContractError('response.nextCursor', 'null or a bounded base64url cursor');
  }
  return {
    goals: body.goals.map((goal, index) => decodeGoalSummary(goal, `response.goals[${index}]`)),
    nextCursor: body.nextCursor as string | null,
  };
};

const validateQuery = (options: GetGoalsOptions): GetGoalsOptions => {
  if (options.limit !== undefined) boundedInteger(options.limit, 'query.limit', GOALS_LIST_LIMIT_MIN, GOALS_LIST_LIMIT_MAX);
  if (options.state !== undefined) enumValue(options.state, GOAL_STATES, 'query.state');
  if (options.repository !== undefined && (options.repository.length === 0 || options.repository.length > GOAL_IDENTIFIER_MAX_LENGTH)) {
    throw new GoalContractError('query.repository', `a non-empty string no longer than ${GOAL_IDENTIFIER_MAX_LENGTH} characters`);
  }
  let search: string | undefined;
  if (options.search !== undefined) {
    if (typeof options.search !== 'string') {
      throw new GoalContractError('query.search', 'a string');
    }
    search = options.search.trim() || undefined;
    if (search !== undefined && codePointLength(search) > GOALS_SEARCH_MAX_LENGTH) {
      throw new GoalContractError('query.search', `a string no longer than ${GOALS_SEARCH_MAX_LENGTH} Unicode characters`);
    }
  }
  if (options.cursor !== undefined && !isBoundedCursor(options.cursor)) {
    throw new GoalContractError('query.cursor', 'a bounded base64url cursor');
  }
  return { ...options, search };
};

const handleGoalResponse = async (response: Response): Promise<Response> => {
  if (response.ok) return response;
  let body: GoalErrorResponse | null = null;
  try {
    body = await response.clone().json() as GoalErrorResponse;
  } catch {
    // The shared response handler supplies the safe generic fallback.
  }
  if (typeof body?.code === 'string' && body.code.startsWith('goal_')) {
    const message = typeof body.error === 'string'
      ? body.error
      : typeof body.message === 'string' ? body.message : `Goal request failed (${body.code})`;
    throw new GoalApiError(body.code, response.status, message);
  }
  return handleApiResponse(response);
};

interface GoalErrorResponse {
  code?: unknown;
  error?: unknown;
  message?: unknown;
}

export const getGoals = async (
  rawOptions: GetGoalsOptions = {},
  requestOptions: GoalRequestOptions = {}
): Promise<GoalsListResponseV1> => {
  const options = validateQuery(rawOptions);
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  if (options.state !== undefined) params.set('state', options.state);
  if (options.repository !== undefined) params.set('repository', options.repository);
  if (options.search !== undefined) params.set('search', options.search);
  if (options.cursor !== undefined) params.set('cursor', options.cursor);
  const query = params.toString();
  const response = await apiFetch(`${API_BASE_URL}/api/goals${query ? `?${query}` : ''}`, {
    credentials: 'include',
    signal: requestOptions.signal,
  });
  await handleGoalResponse(response);
  return decodeListResponse(await response.json() as unknown);
};

export const createGoal = async (
  params: CreateGoalRequestV1,
  idempotencyKey: string
): Promise<GoalRecordV1> => {
  if (!idempotencyKey || idempotencyKey.length > GOAL_IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new GoalContractError('Idempotency-Key', `a non-empty key no longer than ${GOAL_IDEMPOTENCY_KEY_MAX_LENGTH} characters`);
  }
  const response = await apiFetch(
    `${API_BASE_URL}/api/goals`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(params),
      credentials: 'include',
    },
    { replayMutationAfterTokenRefresh: true }
  );
  await handleGoalResponse(response);
  const body = record(await response.json() as unknown, 'response');
  return decodeGoalRecord(body.goal, 'response.goal');
};

export const getGoal = async (goalId: string, options: GoalRequestOptions = {}): Promise<GoalDetailV1> => {
  const response = await apiFetch(`${API_BASE_URL}/api/goals/${encodeURIComponent(goalId)}`, {
    credentials: 'include', signal: options.signal,
  });
  await handleGoalResponse(response);
  return decodeGoalDetail(await response.json() as unknown);
};

export interface GetGoalEventsOptions extends GoalRequestOptions {
  afterSequence?: number;
  beforeSequence?: number;
  limit?: number;
}

export const getGoalEvents = async (goalId: string, options: GetGoalEventsOptions = {}): Promise<GoalEventsPageV1> => {
  if (options.afterSequence !== undefined && options.beforeSequence !== undefined) {
    throw new GoalContractError('event cursor', 'only one of afterSequence or beforeSequence');
  }
  for (const [key, value] of [['afterSequence', options.afterSequence], ['beforeSequence', options.beforeSequence]] as const) {
    if (value !== undefined) integer(value, `query.${key}`);
  }
  if (options.limit !== undefined) boundedInteger(options.limit, 'query.limit', 1, 500);
  const query = new URLSearchParams();
  if (options.afterSequence !== undefined) query.set('afterSequence', String(options.afterSequence));
  if (options.beforeSequence !== undefined) query.set('beforeSequence', String(options.beforeSequence));
  if (options.limit !== undefined) query.set('limit', String(options.limit));
  const suffix = query.toString();
  const response = await apiFetch(
    `${API_BASE_URL}/api/goals/${encodeURIComponent(goalId)}/events${suffix ? `?${suffix}` : ''}`,
    { credentials: 'include', signal: options.signal }
  );
  await handleGoalResponse(response);
  return decodeEventsPage(await response.json() as unknown);
};

const validateIdempotencyKey = (key: string): void => {
  if (!key || key.length > GOAL_IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new GoalContractError('Idempotency-Key', `a non-empty key no longer than ${GOAL_IDEMPOTENCY_KEY_MAX_LENGTH} characters`);
  }
};

const goalMutation = async (
  goalId: string,
  action: 'pause' | 'resume' | 'cancel' | 'model',
  body: Record<string, unknown>,
  idempotencyKey: string
): Promise<GoalRecordV1> => {
  validateIdempotencyKey(idempotencyKey);
  const response = await apiFetch(`${API_BASE_URL}/api/goals/${encodeURIComponent(goalId)}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    credentials: 'include',
    body: JSON.stringify(body),
  }, { replayMutationAfterTokenRefresh: true });
  await handleGoalResponse(response);
  const envelope = record(await response.json() as unknown, 'response');
  return decodeGoalRecord(envelope.goal, 'response.goal');
};

export const pauseGoal = (goalId: string, expectedVersion: number, idempotencyKey: string) =>
  goalMutation(goalId, 'pause', { expectedVersion }, idempotencyKey);

export const resumeGoal = (goalId: string, expectedVersion: number, idempotencyKey: string) =>
  goalMutation(goalId, 'resume', { expectedVersion }, idempotencyKey);

export const cancelGoal = (goalId: string, expectedVersion: number, reason: string, idempotencyKey: string) =>
  goalMutation(goalId, 'cancel', { expectedVersion, reason }, idempotencyKey);

export const requestGoalModel = (goalId: string, expectedVersion: number, model: string, idempotencyKey: string) =>
  goalMutation(goalId, 'model', { expectedVersion, model }, idempotencyKey);

export interface SendGoalMessageParams {
  body: string;
  predefinedKind?: 'whats_done' | 'whats_left';
  retryOfMessageId?: string;
}

export const sendGoalMessage = async (
  goalId: string,
  params: SendGoalMessageParams,
  idempotencyKey: string
): Promise<GoalMessageV1> => {
  validateIdempotencyKey(idempotencyKey);
  if (Array.from(params.body.trim()).length > 4000 || (!params.body.trim() && !params.predefinedKind)) {
    throw new GoalContractError('message.body', 'a non-empty message no longer than 4000 characters');
  }
  const response = await apiFetch(`${API_BASE_URL}/api/goals/${encodeURIComponent(goalId)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    credentials: 'include',
    body: JSON.stringify(params),
  }, { replayMutationAfterTokenRefresh: true });
  await handleGoalResponse(response);
  const envelope = record(await response.json() as unknown, 'response');
  return decodeMessage(envelope.message, 'response.message');
};

export const cancelGoalMessage = async (
  goalId: string,
  messageId: string,
  idempotencyKey: string
): Promise<GoalMessageV1> => {
  validateIdempotencyKey(idempotencyKey);
  const response = await apiFetch(
    `${API_BASE_URL}/api/goals/${encodeURIComponent(goalId)}/messages/${encodeURIComponent(messageId)}/cancel`,
    { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, credentials: 'include' },
    { replayMutationAfterTokenRefresh: true }
  );
  await handleGoalResponse(response);
  const envelope = record(await response.json() as unknown, 'response');
  return decodeMessage(envelope.message, 'response.message');
};
