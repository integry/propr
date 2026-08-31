import { API_BASE_URL, apiFetch, handleApiResponse } from './apiClient';

export const GOAL_STATES = [
  'queued',
  'planning',
  'running',
  'pausing',
  'paused',
  'recovering',
  'completing',
  'completed',
  'failed',
  'cancelled',
] as const;

export type GoalState = (typeof GOAL_STATES)[number];
export type GoalMergePolicy = 'manual' | 'auto' | 'auto_squash';

export interface GoalListItem {
  id: string;
  objective: string;
  repository: string;
  state: GoalState;
  agentAlias: string;
  requestedModel: string;
  effectiveModel: string;
  maxConcurrentTasks: number;
  autoMergePolicy: GoalMergePolicy;
  ultrafixEnabled: boolean;
  ultrafixGoal?: number;
  ultrafixMaxCycles?: number;
  checklistTotal: number;
  checklistCompleted: number;
  activeTasks: number;
  issuesProcessed: number;
  issuesActive: number;
  issuesFailed: number;
  issuesBlocked: number;
  tokenTotal: number;
  elapsedSeconds: number;
  pausedSeconds: number;
  latestEvent?: string;
  epicPrUrl?: string;
  connectionState?: 'connected' | 'recovering' | 'disconnected';
  createdAt: string;
  updatedAt: string;
}

export interface GoalsListResponse {
  goals: GoalListItem[];
  total: number;
  hasMore: boolean;
}

export interface GetGoalsOptions {
  page?: number;
  limit?: number;
  state?: GoalState | 'all';
  repository?: string;
  search?: string;
}

export interface CreateGoalParams {
  objective: string;
  repository: string;
  agent: string;
  model: string;
  maxActiveTasks: number;
  mergePolicy: GoalMergePolicy;
  ultrafixEnabled: boolean;
  ultrafixGoal?: number;
  ultrafixMaxCycles?: number;
}

interface GoalWireRecord extends Partial<GoalListItem> {
  goalId?: string;
  agent?: string;
  maxActiveTasks?: number;
  mergePolicy?: GoalMergePolicy;
}

interface GoalListWireResponse {
  goals?: GoalWireRecord[];
  total?: number;
  hasMore?: boolean;
  nextCursor?: string | null;
}

const numberOrZero = (value: number | undefined): number => value ?? 0;

/**
 * Temporary #2006 integration boundary. The durable control plane uses
 * goalId/agent/maxActiveTasks/mergePolicy and wrapped mutation responses,
 * while the first #2011 UI branch used id/agentAlias/maxConcurrentTasks and
 * bare responses. Accept both here so components retain one state model.
 */
const normalizeGoal = (goal: GoalWireRecord): GoalListItem => {
  const requestedModel = goal.requestedModel ?? '';
  return {
    id: goal.id ?? goal.goalId ?? '',
    objective: goal.objective ?? '',
    repository: goal.repository ?? '',
    state: goal.state ?? 'queued',
    agentAlias: goal.agentAlias ?? goal.agent ?? '',
    requestedModel,
    effectiveModel: goal.effectiveModel ?? requestedModel,
    maxConcurrentTasks: goal.maxConcurrentTasks ?? goal.maxActiveTasks ?? 3,
    autoMergePolicy: goal.autoMergePolicy ?? goal.mergePolicy ?? 'manual',
    ultrafixEnabled: goal.ultrafixEnabled ?? false,
    ultrafixGoal: goal.ultrafixGoal,
    ultrafixMaxCycles: goal.ultrafixMaxCycles,
    checklistTotal: numberOrZero(goal.checklistTotal),
    checklistCompleted: numberOrZero(goal.checklistCompleted),
    activeTasks: numberOrZero(goal.activeTasks),
    issuesProcessed: numberOrZero(goal.issuesProcessed),
    issuesActive: numberOrZero(goal.issuesActive),
    issuesFailed: numberOrZero(goal.issuesFailed),
    issuesBlocked: numberOrZero(goal.issuesBlocked),
    tokenTotal: numberOrZero(goal.tokenTotal),
    elapsedSeconds: numberOrZero(goal.elapsedSeconds),
    pausedSeconds: numberOrZero(goal.pausedSeconds),
    latestEvent: goal.latestEvent,
    epicPrUrl: goal.epicPrUrl,
    connectionState: goal.connectionState,
    createdAt: goal.createdAt ?? '',
    updatedAt: goal.updatedAt ?? '',
  };
};

const unwrapGoal = (body: GoalWireRecord | { goal: GoalWireRecord }): GoalListItem =>
  normalizeGoal('goal' in body ? body.goal : body);

export const getGoals = async (options: GetGoalsOptions = {}): Promise<GoalsListResponse> => {
  const params = new URLSearchParams();
  if (options.page) params.set('page', String(options.page));
  if (options.limit) params.set('limit', String(options.limit));
  if (options.state && options.state !== 'all') params.set('state', options.state);
  if (options.repository) params.set('repository', options.repository);
  if (options.search) params.set('search', options.search);
  const query = params.toString();
  const response = await apiFetch(`${API_BASE_URL}/api/goals${query ? `?${query}` : ''}`, {
    credentials: 'include',
  });
  await handleApiResponse(response);
  const body = await response.json() as GoalListWireResponse;
  const goals = (body.goals ?? []).map(normalizeGoal);
  return {
    goals,
    total: body.total ?? goals.length,
    hasMore: body.hasMore ?? Boolean(body.nextCursor),
  };
};

export const createGoal = async (
  params: CreateGoalParams,
  idempotencyKey: string
): Promise<GoalListItem> => {
  const response = await apiFetch(
    `${API_BASE_URL}/api/goals`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(params),
      credentials: 'include',
    },
    { replayMutationAfterTokenRefresh: true }
  );
  await handleApiResponse(response);
  return unwrapGoal(await response.json() as GoalWireRecord | { goal: GoalWireRecord });
};

export const getGoal = async (goalId: string): Promise<GoalListItem> => {
  const response = await apiFetch(`${API_BASE_URL}/api/goals/${encodeURIComponent(goalId)}`, {
    credentials: 'include',
  });
  await handleApiResponse(response);
  return unwrapGoal(await response.json() as GoalWireRecord | { goal: GoalWireRecord });
};

const mutateGoal = async (goalId: string, action: 'pause' | 'resume' | 'cancel') => {
  const response = await apiFetch(
    `${API_BASE_URL}/api/goals/${encodeURIComponent(goalId)}/${action}`,
    { method: 'POST', credentials: 'include' },
    { replayMutationAfterTokenRefresh: true }
  );
  await handleApiResponse(response);
  return unwrapGoal(await response.json() as GoalWireRecord | { goal: GoalWireRecord });
};

export const pauseGoal = (goalId: string): Promise<GoalListItem> => mutateGoal(goalId, 'pause');
export const resumeGoal = (goalId: string): Promise<GoalListItem> => mutateGoal(goalId, 'resume');
export const cancelGoal = (goalId: string): Promise<GoalListItem> => mutateGoal(goalId, 'cancel');
