import {
  GOAL_CANNED_ACTIONS,
  GOAL_CONTROL_APPLICATIONS,
  GOAL_EVENT_SCHEMA_VERSION,
  GOAL_EVENT_KINDS,
  GOAL_EVENT_TYPES,
  GOAL_MESSAGE_STATES,
  GOAL_STATES,
  type GoalControlCapability,
  type GoalDetailV1,
  type GoalEventV1,
  type GoalEventsPageV1,
  type GoalJsonValue,
  type GoalMessageV1,
  type GoalPlanProjection,
  type GoalProviderCapabilities,
  type GoalRecordV1,
  type GoalSummaryV1,
  type GoalsListResponseV1,
} from './goalContracts';
import { GoalContractError } from './goalApiErrors';

export const GOALS_CURSOR_MAX_LENGTH = 1024;

const record = (value: unknown, path: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GoalContractError(path, 'an object');
  return value as Record<string, unknown>;
};
const array = (value: unknown, path: string): unknown[] => {
  if (!Array.isArray(value)) throw new GoalContractError(path, 'an array');
  return value;
};
const string = (value: unknown, path: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new GoalContractError(path, 'a non-empty string');
  return value;
};
const plainString = (value: unknown, path: string): string => {
  if (typeof value !== 'string') throw new GoalContractError(path, 'a string');
  return value;
};
const nullableString = (value: unknown, path: string): string | null => value === null ? null : string(value, path);
const bool = (value: unknown, path: string): boolean => {
  if (typeof value !== 'boolean') throw new GoalContractError(path, 'a boolean');
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
export const boundedInteger = (value: unknown, path: string, minimum: number, maximum: number): number => {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new GoalContractError(path, `an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
};
const nullableInteger = (value: unknown, path: string): number | null => value === null ? null : integer(value, path);
const enumValue = <T extends string>(value: unknown, values: readonly T[], path: string): T => {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new GoalContractError(path, `one of ${values.join(', ')}`);
  return value as T;
};

/** Replay cursors are bounded transport tokens. Their encoding has no UI semantics. */
export const isBoundedCursor = (value: string): boolean => value.length > 0 && value.length <= GOALS_CURSOR_MAX_LENGTH;
const cursor = (value: unknown, path: string): string | null => {
  if (value === null) return null;
  if (typeof value !== 'string' || !isBoundedCursor(value)) throw new GoalContractError(path, 'null or a bounded opaque cursor');
  return value;
};

const decodeJsonValue = (value: unknown, path: string, depth = 0): GoalJsonValue => {
  if (depth > 24) throw new GoalContractError(path, 'bounded JSON data');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => decodeJsonValue(item, `${path}[${index}]`, depth + 1));
  const object = record(value, path);
  return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, decodeJsonValue(child, `${path}.${key}`, depth + 1)]));
};

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
    mergePolicy: enumValue(goal.mergePolicy, ['manual'] as const, `${path}.mergePolicy`),
    ultrafixEnabled: bool(goal.ultrafixEnabled, `${path}.ultrafixEnabled`),
    ultrafixGoal: goal.ultrafixGoal === null ? null : boundedInteger(goal.ultrafixGoal, `${path}.ultrafixGoal`, 1, 10),
    ultrafixMaxCycles: goal.ultrafixMaxCycles === null ? null : boundedInteger(goal.ultrafixMaxCycles, `${path}.ultrafixMaxCycles`, 1, 20),
    version: integer(goal.version, `${path}.version`),
    terminalReason: nullableString(goal.terminalReason, `${path}.terminalReason`),
    createdAt: timestamp(goal.createdAt, `${path}.createdAt`),
    updatedAt: timestamp(goal.updatedAt, `${path}.updatedAt`),
  };
};

const decodeControlCapability = (value: unknown, path: string): GoalControlCapability => {
  const capability = record(value, path);
  const supported = bool(capability.supported, `${path}.supported`);
  const application = capability.application === null
    ? null : enumValue(capability.application, GOAL_CONTROL_APPLICATIONS, `${path}.application`);
  if (supported !== (application !== null)) throw new GoalContractError(path, 'matching supported/application values');
  return {
    supported,
    application,
    ...(capability.description === undefined ? {} : { description: plainString(capability.description, `${path}.description`) }),
  };
};

const decodeCapabilities = (value: unknown, path: string): GoalProviderCapabilities => {
  const capabilities = record(value, path);
  return {
    nativeGoal: bool(capabilities.nativeGoal, `${path}.nativeGoal`),
    pause: decodeControlCapability(capabilities.pause, `${path}.pause`),
    resume: decodeControlCapability(capabilities.resume, `${path}.resume`),
    steer: decodeControlCapability(capabilities.steer, `${path}.steer`),
    modelChange: decodeControlCapability(capabilities.modelChange, `${path}.modelChange`),
  };
};

const decodePlan = (value: unknown, path: string): GoalPlanProjection => {
  const plan = record(value, path);
  if (plan.status === 'not-reported') return { status: 'not-reported' };
  if (plan.status !== 'reported') throw new GoalContractError(`${path}.status`, 'reported or not-reported');
  return {
    status: 'reported',
    provider: string(plan.provider, `${path}.provider`),
    sessionId: string(plan.sessionId, `${path}.sessionId`),
    generation: integer(plan.generation, `${path}.generation`),
    eventSequence: integer(plan.eventSequence, `${path}.eventSequence`),
    title: nullableString(plan.title, `${path}.title`),
    items: array(plan.items, `${path}.items`).map((item, index) => {
      const itemPath = `${path}.items[${index}]`;
      const todo = record(item, itemPath);
      return {
        itemId: string(todo.itemId, `${itemPath}.itemId`),
        text: string(todo.text, `${itemPath}.text`),
        status: enumValue(todo.status, ['pending', 'in_progress', 'completed', 'blocked', 'cancelled'] as const, `${itemPath}.status`),
        detail: nullableString(todo.detail, `${itemPath}.detail`),
      };
    }),
    updatedAt: timestamp(plan.updatedAt, `${path}.updatedAt`),
  };
};

const decodeArtifacts = (value: unknown, path: string) => {
  const artifacts = record(value, path);
  const issues = record(artifacts.issues, `${path}.issues`);
  const pullRequests = record(artifacts.pullRequests, `${path}.pullRequests`);
  let finalPullRequest = null;
  if (artifacts.finalPullRequest !== null) {
    const final = record(artifacts.finalPullRequest, `${path}.finalPullRequest`);
    finalPullRequest = {
      number: integer(final.number, `${path}.finalPullRequest.number`),
      url: string(final.url, `${path}.finalPullRequest.url`),
      draft: bool(final.draft, `${path}.finalPullRequest.draft`),
    };
  }
  return {
    issues: { total: integer(issues.total, `${path}.issues.total`), open: integer(issues.open, `${path}.issues.open`), closed: integer(issues.closed, `${path}.issues.closed`) },
    pullRequests: { total: integer(pullRequests.total, `${path}.pullRequests.total`), open: integer(pullRequests.open, `${path}.pullRequests.open`), merged: integer(pullRequests.merged, `${path}.pullRequests.merged`), draft: integer(pullRequests.draft, `${path}.pullRequests.draft`) },
    finalPullRequest,
  };
};

const decodeStats = (value: unknown, path: string) => {
  const stats = record(value, path);
  const tokens = record(stats.tokens, `${path}.tokens`);
  const time = record(stats.time, `${path}.time`);
  const messages = record(stats.messages, `${path}.messages`);
  return {
    tokens: {
      total: integer(tokens.total, `${path}.tokens.total`),
      byProviderModel: array(tokens.byProviderModel, `${path}.tokens.byProviderModel`).map((value, index) => {
        const itemPath = `${path}.tokens.byProviderModel[${index}]`;
        const item = record(value, itemPath);
        return {
          provider: string(item.provider, `${itemPath}.provider`), model: string(item.model, `${itemPath}.model`),
          input: integer(item.input, `${itemPath}.input`), output: integer(item.output, `${itemPath}.output`),
          cacheRead: integer(item.cacheRead, `${itemPath}.cacheRead`), cacheWrite: integer(item.cacheWrite, `${itemPath}.cacheWrite`),
          reasoning: integer(item.reasoning, `${itemPath}.reasoning`), total: integer(item.total, `${itemPath}.total`),
        };
      }),
    },
    time: {
      elapsedSeconds: integer(time.elapsedSeconds, `${path}.time.elapsedSeconds`),
      activeSeconds: integer(time.activeSeconds, `${path}.time.activeSeconds`),
      pausedSeconds: integer(time.pausedSeconds, `${path}.time.pausedSeconds`),
    },
    messages: {
      queued: integer(messages.queued, `${path}.messages.queued`),
      oldestQueuedSeconds: nullableInteger(messages.oldestQueuedSeconds, `${path}.messages.oldestQueuedSeconds`),
    },
    artifacts: decodeArtifacts(stats.artifacts, `${path}.artifacts`),
  };
};

export const decodeGoalMessage = (value: unknown, path: string): GoalMessageV1 => {
  const message = record(value, path);
  return {
    messageId: string(message.messageId, `${path}.messageId`),
    sequence: integer(message.sequence, `${path}.sequence`),
    body: plainString(message.body, `${path}.body`),
    cannedAction: message.cannedAction === null ? null : enumValue(message.cannedAction, GOAL_CANNED_ACTIONS, `${path}.cannedAction`),
    state: enumValue(message.state, GOAL_MESSAGE_STATES, `${path}.state`),
    error: nullableString(message.error, `${path}.error`),
    createdAt: timestamp(message.createdAt, `${path}.createdAt`),
    updatedAt: timestamp(message.updatedAt, `${path}.updatedAt`),
  };
};

export const decodeGoalDetail = (value: unknown): GoalDetailV1 => {
  const body = record(value, 'response');
  const provider = record(body.provider, 'response.provider');
  const infrastructure = record(body.infrastructure, 'response.infrastructure');
  const recovery = record(infrastructure.recovery, 'response.infrastructure.recovery');
  const checkpoint = provider.checkpoint === null ? null : record(provider.checkpoint, 'response.provider.checkpoint');
  return {
    goal: decodeGoalRecord(body.goal, 'response.goal'),
    provider: {
      sessionId: nullableString(provider.sessionId, 'response.provider.sessionId'),
      generation: integer(provider.generation, 'response.provider.generation'),
      eventSequence: integer(provider.eventSequence, 'response.provider.eventSequence'),
      status: nullableString(provider.status, 'response.provider.status'),
      statusDetail: nullableString(provider.statusDetail, 'response.provider.statusDetail'),
      updatedAt: provider.updatedAt === null ? null : timestamp(provider.updatedAt, 'response.provider.updatedAt'),
      checkpoint: checkpoint ? {
        checkpointId: string(checkpoint.checkpointId, 'response.provider.checkpoint.checkpointId'),
        label: nullableString(checkpoint.label, 'response.provider.checkpoint.label'),
        eventSequence: integer(checkpoint.eventSequence, 'response.provider.checkpoint.eventSequence'),
        updatedAt: timestamp(checkpoint.updatedAt, 'response.provider.checkpoint.updatedAt'),
      } : null,
      capabilities: decodeCapabilities(provider.capabilities, 'response.provider.capabilities'),
    },
    plan: decodePlan(body.plan, 'response.plan'),
    messages: array(body.messages, 'response.messages').map((item, index) => decodeGoalMessage(item, `response.messages[${index}]`)),
    stats: decodeStats(body.stats, 'response.stats'),
    infrastructure: {
      recovery: {
        state: enumValue(recovery.state, ['healthy', 'recovering', 'offline'] as const, 'response.infrastructure.recovery.state'),
        attempt: integer(recovery.attempt, 'response.infrastructure.recovery.attempt'),
        reason: nullableString(recovery.reason, 'response.infrastructure.recovery.reason'),
      },
      warnings: array(infrastructure.warnings, 'response.infrastructure.warnings').map((item, index) => string(item, `response.infrastructure.warnings[${index}]`)),
    },
    latestSequence: integer(body.latestSequence, 'response.latestSequence'),
    latestCursor: cursor(body.latestCursor, 'response.latestCursor'),
  };
};

export const decodeGoalEvent = (value: unknown, path = 'event'): GoalEventV1 => {
  const event = record(value, path);
  if (event.schemaVersion !== GOAL_EVENT_SCHEMA_VERSION) {
    throw new GoalContractError(`${path}.schemaVersion`, `the canonical schema version ${GOAL_EVENT_SCHEMA_VERSION}`);
  }
  return {
    schemaVersion: GOAL_EVENT_SCHEMA_VERSION,
    goalId: string(event.goalId, `${path}.goalId`),
    sequence: integer(event.sequence, `${path}.sequence`),
    eventType: enumValue(event.eventType, GOAL_EVENT_TYPES, `${path}.eventType`),
    kind: enumValue(event.kind, GOAL_EVENT_KINDS, `${path}.kind`),
    payload: decodeJsonValue(event.payload, `${path}.payload`),
    createdAt: timestamp(event.createdAt, `${path}.createdAt`),
    cursor: string(event.cursor, `${path}.cursor`),
  };
};

export const decodeEventsPage = (value: unknown): GoalEventsPageV1 => {
  const body = record(value, 'response');
  if (body.schemaVersion !== GOAL_EVENT_SCHEMA_VERSION) {
    throw new GoalContractError('response.schemaVersion', `the canonical schema version ${GOAL_EVENT_SCHEMA_VERSION}`);
  }
  return {
    schemaVersion: GOAL_EVENT_SCHEMA_VERSION,
    events: array(body.events, 'response.events').map((item, index) => decodeGoalEvent(item, `response.events[${index}]`)),
    previousCursor: cursor(body.previousCursor, 'response.previousCursor'),
    nextCursor: cursor(body.nextCursor, 'response.nextCursor'),
    hasMoreBefore: bool(body.hasMoreBefore, 'response.hasMoreBefore'),
    asOfSequence: integer(body.asOfSequence, 'response.asOfSequence'),
  };
};

const decodeSummary = (value: unknown, path: string): GoalSummaryV1 => {
  const summary = record(value, path);
  const goal = decodeGoalRecord({ ...summary, terminalReason: null }, path);
  const projectionValue = record(summary.projection, `${path}.projection`);
  let projection: GoalSummaryV1['projection'];
  if (projectionValue.status === 'not-yet-projected') projection = { status: 'not-yet-projected' };
  else if (projectionValue.status === 'ready') {
    const provider = record(projectionValue.provider, `${path}.projection.provider`);
    const plan = projectionValue.plan === null ? null : record(projectionValue.plan, `${path}.projection.plan`);
    projection = {
      status: 'ready',
      provider: {
        status: nullableString(provider.status, `${path}.projection.provider.status`),
        statusDetail: nullableString(provider.statusDetail, `${path}.projection.provider.statusDetail`),
        updatedAt: provider.updatedAt === null ? null : timestamp(provider.updatedAt, `${path}.projection.provider.updatedAt`),
      },
      plan: plan ? { total: integer(plan.total, `${path}.projection.plan.total`), completed: integer(plan.completed, `${path}.projection.plan.completed`) } : null,
      stats: decodeStats(projectionValue.stats, `${path}.projection.stats`),
      latestEvent: nullableString(projectionValue.latestEvent, `${path}.projection.latestEvent`),
      connectionState: enumValue(projectionValue.connectionState, ['connected', 'recovering', 'disconnected'] as const, `${path}.projection.connectionState`),
    };
  } else throw new GoalContractError(`${path}.projection.status`, 'ready or not-yet-projected');
  const { terminalReason: _terminalReason, ...publicSummary } = goal;
  return { ...publicSummary, latestSequence: integer(summary.latestSequence, `${path}.latestSequence`), projection };
};

export const decodeListResponse = (value: unknown): GoalsListResponseV1 => {
  const body = record(value, 'response');
  return {
    goals: array(body.goals, 'response.goals').map((goal, index) => decodeSummary(goal, `response.goals[${index}]`)),
    nextCursor: cursor(body.nextCursor, 'response.nextCursor'),
  };
};
