import type { GoalDetail, GoalEvent } from '../../api/goalsApi';
import type { GoalJsonValue, GoalPlanItem } from '../../api/goalContracts';

type Payload = Record<string, GoalJsonValue>;

const object = (value: GoalJsonValue): Payload | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
const string = (value: GoalJsonValue | undefined): string | null => typeof value === 'string' ? value : null;
const integer = (value: GoalJsonValue | undefined): number | null => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
const PLAN_STATUSES: readonly GoalPlanItem['status'][] = ['pending', 'in_progress', 'completed', 'blocked', 'cancelled'];

const planItem = (value: GoalJsonValue): GoalPlanItem | null => {
  const item = object(value);
  if (!item) return null;
  const itemId = string(item.id) ?? string(item.itemId);
  const text = string(item.text);
  const status = string(item.status) as GoalPlanItem['status'] | null;
  if (!itemId || !text || !status || !PLAN_STATUSES.includes(status)) return null;
  return {
    itemId,
    text,
    status,
    detail: item.detail === null || item.detail === undefined ? null : string(item.detail),
  };
};

const planItems = (value: GoalJsonValue | undefined): GoalPlanItem[] | null => {
  if (!Array.isArray(value)) return null;
  const items = value.map(planItem);
  return items.some(item => item === null) ? null : items as GoalPlanItem[];
};

const planIsCurrent = (detail: GoalDetail, generation: number, eventSequence: number): boolean => {
  if (generation < detail.provider.generation) return false;
  if (detail.plan.status !== 'reported') return true;
  if (generation > detail.plan.generation) return true;
  return generation === detail.plan.generation && eventSequence > detail.plan.eventSequence;
};

const projectPlan = (detail: GoalDetail, event: GoalEvent, payload: Payload): GoalDetail => {
  const provider = string(payload.provider) ?? detail.goal.agent;
  const sessionId = string(payload.sessionId) ?? detail.provider.sessionId;
  const generation = integer(payload.generation) ?? detail.provider.generation;
  const eventSequence = integer(payload.eventSequence) ?? event.sequence;
  const items = planItems(payload.items);
  if (!sessionId || !items || !planIsCurrent(detail, generation, eventSequence)) return detail;
  if (detail.provider.sessionId && sessionId !== detail.provider.sessionId) return detail;
  return {
    ...detail,
    plan: {
      status: 'reported', provider, sessionId, generation, eventSequence,
      title: payload.title === null ? null : string(payload.title),
      items,
      updatedAt: string(payload.updatedAt) ?? event.createdAt,
    },
  };
};

const providerEventIsCurrent = (
  detail: GoalDetail,
  sessionId: string,
  generation: number,
  eventSequence: number
): boolean => {
  if (detail.provider.sessionId && sessionId !== detail.provider.sessionId) return false;
  if (generation > detail.provider.generation) return true;
  return generation === detail.provider.generation && eventSequence > detail.provider.eventSequence;
};

const projectStatus = (detail: GoalDetail, event: GoalEvent, payload: Payload): GoalDetail => {
  const sessionId = string(payload.sessionId) ?? detail.provider.sessionId;
  const generation = integer(payload.generation) ?? detail.provider.generation;
  const eventSequence = integer(payload.eventSequence) ?? event.sequence;
  const status = string(payload.status);
  if (!sessionId || !status || !providerEventIsCurrent(detail, sessionId, generation, eventSequence)) return detail;
  return {
    ...detail,
    provider: {
      ...detail.provider,
      sessionId,
      generation,
      eventSequence,
      status,
      statusDetail: payload.statusDetail === null
        ? null
        : string(payload.statusDetail) ?? string(payload.detail) ?? string(payload.summary),
      updatedAt: string(payload.updatedAt) ?? event.createdAt,
    },
  };
};

const projectModel = (detail: GoalDetail, payload: Payload): GoalDetail => {
  const requestedModel = string(payload.requestedModel);
  const effectiveModel = string(payload.effectiveModel);
  if (!requestedModel || !effectiveModel) return detail;
  return { ...detail, goal: { ...detail.goal, requestedModel, effectiveModel } };
};

const projectCheckpoint = (detail: GoalDetail, event: GoalEvent, payload: Payload): GoalDetail => {
  const checkpointId = string(payload.checkpointId);
  if (!checkpointId) return detail;
  return {
    ...detail,
    provider: {
      ...detail.provider,
      checkpoint: {
        checkpointId,
        label: payload.label === undefined || payload.label === null ? null : string(payload.label),
        eventSequence: event.sequence,
        updatedAt: event.createdAt,
      },
    },
  };
};

const projectUsage = (detail: GoalDetail, payload: Payload): GoalDetail => {
  const provider = string(payload.provider);
  const model = string(payload.model);
  if (!provider || !model) return detail;
  const input = integer(payload.inputTokens) ?? 0;
  const output = integer(payload.outputTokens) ?? 0;
  const cacheRead = integer(payload.cacheReadTokens) ?? 0;
  const cacheWrite = integer(payload.cacheWriteTokens) ?? 0;
  const reasoning = integer(payload.reasoningTokens) ?? 0;
  const total = integer(payload.total) ?? input + output + cacheRead + cacheWrite + reasoning;
  const rows = [...detail.stats.tokens.byProviderModel];
  const index = rows.findIndex(row => row.provider === provider && row.model === model);
  const next = { provider, model, input, output, cacheRead, cacheWrite, reasoning, total };
  if (index >= 0) rows[index] = next;
  else rows.push(next);
  return {
    ...detail,
    stats: {
      ...detail.stats,
      tokens: { total: rows.reduce((sum, row) => sum + row.total, 0), byProviderModel: rows },
    },
  };
};

/** Apply only provider-authored projection fields; host lifecycle remains API-owned. */
export function projectGoalEvent(detail: GoalDetail, event: GoalEvent): GoalDetail {
  const payload = object(event.payload);
  if (!payload) return detail;
  if (event.eventType === 'provider.plan' || event.eventType === 'provider.todo') return projectPlan(detail, event, payload);
  if (event.eventType === 'provider.status' || event.eventType === 'provider.completed') return projectStatus(detail, event, payload);
  if (event.eventType === 'provider.model') return projectModel(detail, payload);
  if (event.eventType === 'checkpoint.saved') return projectCheckpoint(detail, event, payload);
  if (event.eventType === 'usage.reported') return projectUsage(detail, payload);
  return detail;
}
