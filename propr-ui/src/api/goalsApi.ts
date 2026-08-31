import { API_BASE_URL, apiFetch } from './apiClient';
import { GOAL_STATES, type CreateGoalRequestV1, type GoalRecordV1, type GoalState, type GoalsListResponseV1 } from './goalContracts';
import { GoalContractError, handleGoalResponse } from './goalApiErrors';
import { boundedInteger, decodeGoalRecord, decodeListResponse, isBoundedCursor } from './goalDecoders';

export { GOAL_STATES } from './goalContracts';
export { GoalApiError, GoalContractError, GoalMutationUncertainError, isGoalApiErrorCode } from './goalApiErrors';
export { decodeGoalEvent } from './goalDecoders';
export {
  cancelGoal,
  cancelGoalMessage,
  getGoal,
  getGoalEvents,
  pauseGoal,
  requestGoalModel,
  resumeGoal,
  sendGoalMessage,
} from './goalDetailApi';
export type { GetGoalEventsOptions, SendGoalMessageParams } from './goalDetailApi';
export type {
  CreateGoalRequestV1 as CreateGoalParams,
  GoalDetailV1 as GoalDetail,
  GoalEventsPageV1 as GoalEventsPage,
  GoalEventType,
  GoalEventV1 as GoalEvent,
  GoalMergePolicy,
  GoalMessageV1 as GoalMessage,
  GoalRecordV1,
  GoalsListResponseV1 as GoalsListResponse,
  GoalState,
  GoalSummaryV1 as GoalListItem,
} from './goalContracts';

export const GOALS_LIST_LIMIT_MIN = 1;
export const GOALS_LIST_LIMIT_MAX = 100;
export const GOALS_SEARCH_MAX_LENGTH = 200;
export { GOALS_CURSOR_MAX_LENGTH } from './goalDecoders';
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

const enumState = (value: GoalState): void => {
  if (!GOAL_STATES.includes(value)) throw new GoalContractError('query.state', `one of ${GOAL_STATES.join(', ')}`);
};

const codePointLength = (value: string): number => Array.from(value).length;

const validateQuery = (options: GetGoalsOptions): GetGoalsOptions => {
  if (options.limit !== undefined) boundedInteger(options.limit, 'query.limit', GOALS_LIST_LIMIT_MIN, GOALS_LIST_LIMIT_MAX);
  if (options.state !== undefined) enumState(options.state);
  if (options.repository !== undefined && (options.repository.length === 0 || options.repository.length > GOAL_IDENTIFIER_MAX_LENGTH)) {
    throw new GoalContractError('query.repository', `a non-empty string no longer than ${GOAL_IDENTIFIER_MAX_LENGTH} characters`);
  }
  let search: string | undefined;
  if (options.search !== undefined) {
    if (typeof options.search !== 'string') throw new GoalContractError('query.search', 'a string');
    search = options.search.trim() || undefined;
    if (search && codePointLength(search) > GOALS_SEARCH_MAX_LENGTH) {
      throw new GoalContractError('query.search', `a string no longer than ${GOALS_SEARCH_MAX_LENGTH} Unicode characters`);
    }
  }
  if (options.cursor !== undefined && !isBoundedCursor(options.cursor)) throw new GoalContractError('query.cursor', 'a bounded base64url cursor');
  return { ...options, search };
};

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
    credentials: 'include', signal: requestOptions.signal,
  });
  await handleGoalResponse(response);
  return decodeListResponse(await response.json() as unknown);
};

export const createGoal = async (params: CreateGoalRequestV1, idempotencyKey: string): Promise<GoalRecordV1> => {
  if (!idempotencyKey || idempotencyKey.length > GOAL_IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new GoalContractError('Idempotency-Key', `a non-empty key no longer than ${GOAL_IDEMPOTENCY_KEY_MAX_LENGTH} characters`);
  }
  const response = await apiFetch(`${API_BASE_URL}/api/goals`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(params), credentials: 'include',
  }, { replayMutationAfterTokenRefresh: true });
  await handleGoalResponse(response);
  const body = await response.json() as { goal?: unknown };
  return decodeGoalRecord(body.goal, 'response.goal');
};
