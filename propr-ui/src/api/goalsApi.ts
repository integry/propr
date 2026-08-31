import { API_BASE_URL, apiFetch, handleApiResponse } from './apiClient';
import {
  GOAL_MERGE_POLICIES,
  GOAL_STATES,
  type CreateGoalRequestV1,
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
} from './goalContracts';

export const GOALS_LIST_LIMIT_MIN = 1;
export const GOALS_LIST_LIMIT_MAX = 100;
export const GOALS_SEARCH_MAX_LENGTH = 200;
export const GOALS_CURSOR_MAX_LENGTH = 1024;
const GOAL_IDENTIFIER_MAX_LENGTH = 255;
const GOAL_IDEMPOTENCY_KEY_MAX_LENGTH = 255;

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

const decodeListResponse = (value: unknown): GoalsListResponseV1 => {
  const body = record(value, 'response');
  if (!Array.isArray(body.goals)) throw new GoalContractError('response.goals', 'an array');
  if (body.nextCursor !== null && typeof body.nextCursor !== 'string') {
    throw new GoalContractError('response.nextCursor', 'a string or null');
  }
  if (typeof body.nextCursor === 'string' && (body.nextCursor.length === 0 || body.nextCursor.length > GOALS_CURSOR_MAX_LENGTH)) {
    throw new GoalContractError('response.nextCursor', `a cursor no longer than ${GOALS_CURSOR_MAX_LENGTH} characters`);
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
  if (options.search !== undefined && (options.search.length === 0 || options.search.length > GOALS_SEARCH_MAX_LENGTH)) {
    throw new GoalContractError('query.search', `a non-empty string no longer than ${GOALS_SEARCH_MAX_LENGTH} characters`);
  }
  if (options.cursor !== undefined && (options.cursor.length === 0 || options.cursor.length > GOALS_CURSOR_MAX_LENGTH || !/^[A-Za-z0-9_-]+$/.test(options.cursor))) {
    throw new GoalContractError('query.cursor', 'a bounded base64url cursor');
  }
  return options;
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

export const getGoal = async (goalId: string): Promise<GoalRecordV1> => {
  const response = await apiFetch(`${API_BASE_URL}/api/goals/${encodeURIComponent(goalId)}`, { credentials: 'include' });
  await handleGoalResponse(response);
  const body = record(await response.json() as unknown, 'response');
  return decodeGoalRecord(body.goal, 'response.goal');
};
