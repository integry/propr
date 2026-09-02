import { API_BASE_URL, apiFetch } from './apiClient';
import type { GoalDetailV1, GoalEventsPageV1, GoalMessageV1, GoalRecordV1 } from './goalContracts';
import { GoalContractError, GoalMutationUncertainError, handleGoalResponse } from './goalApiErrors';
import { boundedInteger, decodeEventsPage, decodeGoalDetail, decodeGoalMessage, decodeGoalRecord } from './goalDecoders';
import { canonicalGoalText, GOAL_TEXT_MAX_CODE_POINTS } from '../utils/canonicalGoalText';

const GOAL_IDEMPOTENCY_KEY_MAX_LENGTH = 255;

export interface GoalRequestOptions {
  signal?: AbortSignal;
}

export const getGoal = async (goalId: string, options: GoalRequestOptions = {}): Promise<GoalDetailV1> => {
  const response = await apiFetch(`${API_BASE_URL}/api/goals/${encodeURIComponent(goalId)}`, {
    credentials: 'include', signal: options.signal,
  });
  await handleGoalResponse(response);
  const detail = decodeGoalDetail(await response.json() as unknown);
  if (detail.goal.goalId !== goalId) throw new GoalContractError('response.goal.goalId', `the requested goal ${goalId}`);
  return detail;
};

export interface GetGoalEventsOptions extends GoalRequestOptions {
  afterCursor?: string;
  beforeCursor?: string;
  limit?: number;
}

export const getGoalEvents = async (goalId: string, options: GetGoalEventsOptions = {}): Promise<GoalEventsPageV1> => {
  if (options.afterCursor !== undefined && options.beforeCursor !== undefined) {
    throw new GoalContractError('event cursor', 'only one of afterCursor or beforeCursor');
  }
  if (options.afterCursor !== undefined && !options.afterCursor) throw new GoalContractError('query.afterCursor', 'a non-empty opaque cursor');
  if (options.beforeCursor !== undefined && !options.beforeCursor) throw new GoalContractError('query.beforeCursor', 'a non-empty opaque cursor');
  if (options.limit !== undefined) boundedInteger(options.limit, 'query.limit', 1, 500);
  const query = new URLSearchParams();
  if (options.afterCursor !== undefined) query.set('afterCursor', options.afterCursor);
  if (options.beforeCursor !== undefined) query.set('beforeCursor', options.beforeCursor);
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
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    credentials: 'include', body: JSON.stringify(body),
  }, { replayMutationAfterTokenRefresh: true });
  await handleGoalResponse(response);
  const envelope = await response.json() as { goal?: unknown };
  const goal = decodeGoalRecord(envelope.goal, 'response.goal');
  if (goal.goalId !== goalId) throw new GoalContractError('response.goal.goalId', `the requested goal ${goalId}`);
  return goal;
};

export const pauseGoal = (goalId: string, expectedVersion: number, idempotencyKey: string) =>
  goalMutation(goalId, 'pause', { expectedVersion }, idempotencyKey);
export const resumeGoal = (goalId: string, expectedVersion: number, idempotencyKey: string) =>
  goalMutation(goalId, 'resume', { expectedVersion }, idempotencyKey);
export const cancelGoal = (goalId: string, expectedVersion: number, reason: string, idempotencyKey: string) =>
  goalMutation(goalId, 'cancel', { expectedVersion, reason }, idempotencyKey);
export const requestGoalModel = (goalId: string, expectedVersion: number, model: string, idempotencyKey: string) =>
  goalMutation(goalId, 'model', { expectedVersion, model }, idempotencyKey);

export type SendGoalMessageParams =
  | { body: string; cannedAction?: never; retryOfMessageId?: string }
  | { cannedAction: 'whats_done' | 'whats_left'; body?: never; retryOfMessageId?: string };

export const sendGoalMessage = async (
  goalId: string,
  params: SendGoalMessageParams,
  idempotencyKey: string
): Promise<GoalMessageV1> => {
  validateIdempotencyKey(idempotencyKey);
  const canonicalBody = canonicalGoalText(params.body ?? '');
  if ('body' in params && (canonicalBody.codePointLength > GOAL_TEXT_MAX_CODE_POINTS || !canonicalBody.value)) {
    throw new GoalContractError('message.body', `a non-empty message no longer than ${GOAL_TEXT_MAX_CODE_POINTS} characters`);
  }
  const canonicalParams = 'cannedAction' in params
    ? { cannedAction: params.cannedAction, ...(params.retryOfMessageId ? { retryOfMessageId: params.retryOfMessageId } : {}) }
    : { body: canonicalBody.value, ...(params.retryOfMessageId ? { retryOfMessageId: params.retryOfMessageId } : {}) };
  const response = await apiFetch(`${API_BASE_URL}/api/goals/${encodeURIComponent(goalId)}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    credentials: 'include', body: JSON.stringify(canonicalParams),
  }, { replayMutationAfterTokenRefresh: true });
  await handleGoalResponse(response);
  try {
    const envelope = await response.json() as { message?: unknown };
    return decodeGoalMessage(envelope.message, 'response.message');
  } catch (caught) {
    throw new GoalMutationUncertainError(caught);
  }
};

export const cancelGoalMessage = async (goalId: string, messageId: string, idempotencyKey: string): Promise<GoalMessageV1> => {
  validateIdempotencyKey(idempotencyKey);
  const response = await apiFetch(
    `${API_BASE_URL}/api/goals/${encodeURIComponent(goalId)}/messages/${encodeURIComponent(messageId)}/cancel`,
    { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, credentials: 'include' },
    { replayMutationAfterTokenRefresh: true }
  );
  await handleGoalResponse(response);
  const envelope = await response.json() as { message?: unknown };
  return decodeGoalMessage(envelope.message, 'response.message');
};
