import {
  GOAL_EVENT_TYPES,
  GOAL_MERGE_POLICIES,
  GOAL_MESSAGE_STATES,
  GOAL_NODE_KINDS,
  GOAL_NODE_STATES,
  GOAL_STATES,
  type GoalDetailV1,
  type GoalEventV1,
  type GoalEventsPageV1,
  type GoalHierarchyNodeV1,
  type GoalJsonValue,
  type GoalMessageV1,
  type GoalProjectionReadyV1,
  type GoalProjectionV1,
  type GoalRecordV1,
  type GoalsListResponseV1,
  type GoalSummaryV1,
} from './goalContracts';
import { GoalContractError } from './goalApiErrors';

export const GOALS_CURSOR_MAX_LENGTH = 1024;
const BASE64URL_CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;

const record = (value: unknown, path: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GoalContractError(path, 'an object');
  return value as Record<string, unknown>;
};

const string = (value: unknown, path: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new GoalContractError(path, 'a non-empty string');
  return value;
};

const plainString = (value: unknown, path: string): string => {
  if (typeof value !== 'string') throw new GoalContractError(path, 'a string');
  return value;
};

const timestamp = (value: unknown, path: string): string => {
  const result = string(value, path);
  if (!Number.isFinite(Date.parse(result))) throw new GoalContractError(path, 'an ISO timestamp');
  return result;
};

export const integer = (value: unknown, path: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new GoalContractError(path, 'a non-negative safe integer');
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

export function boundedInteger(value: unknown, path: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new GoalContractError(path, `an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

const nullableBoundedInteger = (value: unknown, path: string, minimum: number, maximum: number): number | null => {
  if (value === null) return null;
  return boundedInteger(value, path, minimum, maximum);
};

const enumValue = <T extends string>(value: unknown, values: readonly T[], path: string): T => {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new GoalContractError(path, `one of ${values.join(', ')}`);
  }
  return value as T;
};

export const isBoundedCursor = (value: string): boolean =>
  value.length > 0 && value.length <= GOALS_CURSOR_MAX_LENGTH && BASE64URL_CURSOR_PATTERN.test(value);

export const decodeGoalRecord = (value: unknown, path: string): GoalRecordV1 => {
  const goal = record(value, path);
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
    ultrafixEnabled: bool(goal.ultrafixEnabled, `${path}.ultrafixEnabled`),
    ultrafixGoal: nullableBoundedInteger(goal.ultrafixGoal, `${path}.ultrafixGoal`, 1, 10),
    ultrafixMaxCycles: nullableBoundedInteger(goal.ultrafixMaxCycles, `${path}.ultrafixMaxCycles`, 1, 20),
    version: integer(goal.version, `${path}.version`),
    createdAt: timestamp(goal.createdAt, `${path}.createdAt`),
    updatedAt: timestamp(goal.updatedAt, `${path}.updatedAt`),
  };
};

const count = (container: Record<string, unknown>, key: string, path: string): number => integer(container[key], `${path}.${key}`);

const decodeIssues = (value: unknown, path: string) => {
  const issues = record(value, path);
  return {
    total: count(issues, 'total', path), ready: count(issues, 'ready', path), active: count(issues, 'active', path),
    processed: count(issues, 'processed', path), failed: count(issues, 'failed', path), blocked: count(issues, 'blocked', path),
  };
};

const decodeReadyProjection = (value: Record<string, unknown>, path: string): GoalProjectionReadyV1 => {
  const checklist = record(value.checklist, `${path}.checklist`);
  const issues = decodeIssues(value.issues, `${path}.issues`);
  const pullRequests = record(value.pullRequests, `${path}.pullRequests`);
  const tokens = record(value.tokens, `${path}.tokens`);
  const time = record(value.time, `${path}.time`);
  const total = count(checklist, 'total', `${path}.checklist`);
  const completed = count(checklist, 'completed', `${path}.checklist`);
  if (completed > total) throw new GoalContractError(`${path}.checklist.completed`, 'a count no greater than total');
  return {
    status: 'ready', checklist: { total, completed }, issues,
    pullRequests: {
      open: count(pullRequests, 'open', `${path}.pullRequests`), reviewPending: count(pullRequests, 'reviewPending', `${path}.pullRequests`),
      ultrafixPending: count(pullRequests, 'ultrafixPending', `${path}.pullRequests`), mergeReady: count(pullRequests, 'mergeReady', `${path}.pullRequests`),
      merged: count(pullRequests, 'merged', `${path}.pullRequests`),
    },
    tokens: { total: count(tokens, 'total', `${path}.tokens`) },
    time: {
      elapsedSeconds: count(time, 'elapsedSeconds', `${path}.time`), activeSeconds: count(time, 'activeSeconds', `${path}.time`),
      pausedSeconds: count(time, 'pausedSeconds', `${path}.time`),
    },
    latestEvent: nullableString(value.latestEvent, `${path}.latestEvent`),
    connectionState: enumValue(value.connectionState, ['connected', 'recovering', 'disconnected'], `${path}.connectionState`),
    epicPrUrl: nullableString(value.epicPrUrl, `${path}.epicPrUrl`),
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
    ...decodeGoalRecord(goal, path), nodeCount: integer(goal.nodeCount, `${path}.nodeCount`),
    activeNodeCount: integer(goal.activeNodeCount, `${path}.activeNodeCount`),
    latestSequence: integer(goal.latestSequence, `${path}.latestSequence`), projection: decodeProjection(goal.projection, `${path}.projection`),
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
    nodeId: string(node.nodeId, `${path}.nodeId`), parentNodeId: nullableString(node.parentNodeId, `${path}.parentNodeId`),
    kind: enumValue(node.kind, GOAL_NODE_KINDS, `${path}.kind`), title: string(node.title, `${path}.title`),
    state: enumValue(node.state, GOAL_NODE_STATES, `${path}.state`), orderIndex: integer(node.orderIndex, `${path}.orderIndex`),
    externalRef: nullableString(node.externalRef, `${path}.externalRef`), externalUrl: nullableString(node.externalUrl, `${path}.externalUrl`),
    blockedReason: nullableString(node.blockedReason, `${path}.blockedReason`),
    ci: enumValue(node.ci, ['pending', 'running', 'passed', 'failed', 'not_applicable'], `${path}.ci`),
    review: enumValue(node.review, ['pending', 'approved', 'changes_requested', 'not_applicable'], `${path}.review`),
    ultrafix: enumValue(node.ultrafix, ['pending', 'running', 'passed', 'failed', 'not_applicable'], `${path}.ultrafix`),
    merge: enumValue(node.merge, ['pending', 'ready', 'merged', 'failed', 'not_applicable'], `${path}.merge`),
  };
};

export const decodeGoalMessage = (value: unknown, path: string): GoalMessageV1 => {
  const message = record(value, path);
  return {
    messageId: string(message.messageId, `${path}.messageId`), sequence: integer(message.sequence, `${path}.sequence`),
    body: plainString(message.body, `${path}.body`),
    predefinedKind: message.predefinedKind === null ? null : enumValue(message.predefinedKind, ['whats_done', 'whats_left'] as const, `${path}.predefinedKind`),
    state: enumValue(message.state, GOAL_MESSAGE_STATES, `${path}.state`),
    responseSource: message.responseSource === null ? null : enumValue(message.responseSource, ['controller', 'provider'] as const, `${path}.responseSource`),
    response: nullableString(message.response, `${path}.response`), error: nullableString(message.error, `${path}.error`),
    createdAt: timestamp(message.createdAt, `${path}.createdAt`), updatedAt: timestamp(message.updatedAt, `${path}.updatedAt`),
  };
};

const decodeTokenBreakdown = (value: unknown, path: string) => {
  const item = record(value, path);
  return {
    provider: string(item.provider, `${path}.provider`), model: string(item.model, `${path}.model`),
    input: integer(item.input, `${path}.input`), output: integer(item.output, `${path}.output`),
    cacheRead: integer(item.cacheRead, `${path}.cacheRead`), cacheWrite: integer(item.cacheWrite, `${path}.cacheWrite`),
    reasoning: integer(item.reasoning, `${path}.reasoning`), total: integer(item.total, `${path}.total`),
  };
};

export const decodeGoalDetail = (value: unknown): GoalDetailV1 => {
  const body = record(value, 'response');
  const goal = record(body.goal, 'response.goal');
  const hierarchy = record(body.hierarchy, 'response.hierarchy');
  const stats = record(body.stats, 'response.stats');
  const pullRequests = record(stats.pullRequests, 'response.stats.pullRequests');
  const tokens = record(stats.tokens, 'response.stats.tokens');
  const time = record(stats.time, 'response.stats.time');
  const recovery = record(body.recovery, 'response.recovery');
  return {
    goal: { ...decodeGoalRecord(goal, 'response.goal'), terminalReason: nullableString(goal.terminalReason, 'response.goal.terminalReason') },
    hierarchy: {
      nodes: array(hierarchy.nodes, 'response.hierarchy.nodes').map((item, index) => decodeHierarchyNode(item, `response.hierarchy.nodes[${index}]`)),
      dependencies: array(hierarchy.dependencies, 'response.hierarchy.dependencies').map((item, index) => {
        const path = `response.hierarchy.dependencies[${index}]`; const dependency = record(item, path);
        return { nodeId: string(dependency.nodeId, `${path}.nodeId`), dependsOnNodeId: string(dependency.dependsOnNodeId, `${path}.dependsOnNodeId`) };
      }),
    },
    providerTodos: array(body.providerTodos, 'response.providerTodos').map((item, index) => {
      const path = `response.providerTodos[${index}]`; const todo = record(item, path);
      return {
        todoId: string(todo.todoId, `${path}.todoId`), provider: string(todo.provider, `${path}.provider`),
        content: string(todo.content, `${path}.content`), status: enumValue(todo.status, ['pending', 'in_progress', 'completed'], `${path}.status`),
        updatedAt: timestamp(todo.updatedAt, `${path}.updatedAt`),
      };
    }),
    messages: array(body.messages, 'response.messages').map((item, index) => decodeGoalMessage(item, `response.messages[${index}]`)),
    stats: {
      issues: decodeIssues(stats.issues, 'response.stats.issues'),
      pullRequests: {
        open: count(pullRequests, 'open', 'response.stats.pullRequests'), reviewPending: count(pullRequests, 'reviewPending', 'response.stats.pullRequests'),
        ultrafixPending: count(pullRequests, 'ultrafixPending', 'response.stats.pullRequests'), mergeReady: count(pullRequests, 'mergeReady', 'response.stats.pullRequests'),
        merged: count(pullRequests, 'merged', 'response.stats.pullRequests'),
      },
      tokens: { total: count(tokens, 'total', 'response.stats.tokens'), byModel: array(tokens.byModel, 'response.stats.tokens.byModel').map((item, index) => decodeTokenBreakdown(item, `response.stats.tokens.byModel[${index}]`)) },
      time: {
        elapsedSeconds: count(time, 'elapsedSeconds', 'response.stats.time'), activeSeconds: count(time, 'activeSeconds', 'response.stats.time'),
        pausedSeconds: count(time, 'pausedSeconds', 'response.stats.time'), recoverySeconds: count(time, 'recoverySeconds', 'response.stats.time'),
      },
    },
    recovery: { state: enumValue(recovery.state, ['healthy', 'recovering', 'offline'], 'response.recovery.state'), attempt: integer(recovery.attempt, 'response.recovery.attempt'), reason: nullableString(recovery.reason, 'response.recovery.reason') },
    epicPrUrl: nullableString(body.epicPrUrl, 'response.epicPrUrl'),
    completionBlockers: array(body.completionBlockers, 'response.completionBlockers').map((item, index) => string(item, `response.completionBlockers[${index}]`)),
    latestSequence: integer(body.latestSequence, 'response.latestSequence'),
  };
};

export const decodeGoalEvent = (value: unknown, path = 'event'): GoalEventV1 => {
  const event = record(value, path);
  return {
    goalId: string(event.goalId, `${path}.goalId`), sequence: integer(event.sequence, `${path}.sequence`),
    type: enumValue(event.type, GOAL_EVENT_TYPES, `${path}.type`), source: string(event.source, `${path}.source`),
    timestamp: timestamp(event.timestamp, `${path}.timestamp`), turnId: nullableString(event.turnId, `${path}.turnId`),
    content: plainString(event.content, `${path}.content`), payload: decodeJsonValue(event.payload, `${path}.payload`),
  };
};

export const decodeEventsPage = (value: unknown): GoalEventsPageV1 => {
  const body = record(value, 'response');
  return {
    events: array(body.events, 'response.events').map((item, index) => decodeGoalEvent(item, `response.events[${index}]`)),
    previousCursor: body.previousCursor === null ? null : integer(body.previousCursor, 'response.previousCursor'),
    nextCursor: body.nextCursor === null ? null : integer(body.nextCursor, 'response.nextCursor'),
    hasMoreBefore: bool(body.hasMoreBefore, 'response.hasMoreBefore'),
  };
};

export const decodeListResponse = (value: unknown): GoalsListResponseV1 => {
  const body = record(value, 'response');
  const goals = array(body.goals, 'response.goals');
  if (body.nextCursor !== null && (typeof body.nextCursor !== 'string' || !isBoundedCursor(body.nextCursor))) {
    throw new GoalContractError('response.nextCursor', 'null or a bounded base64url cursor');
  }
  return { goals: goals.map((goal, index) => decodeGoalSummary(goal, `response.goals[${index}]`)), nextCursor: body.nextCursor as string | null };
};
