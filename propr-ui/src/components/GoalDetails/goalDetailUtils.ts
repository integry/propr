import type { GoalEventV1 as GoalEvent, GoalJsonValue } from '../../api/goalContracts';

export const GOAL_TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);
export const GOAL_EVENT_RETENTION_LIMIT = 1_000;
const GOAL_EVENT_HISTORY_RESERVE = GOAL_EVENT_RETENTION_LIMIT / 2;
const GOAL_EVENT_OLDER_FRONTIER_RESERVE = 200;

export interface GoalViewportAnchor {
  sequence: number;
  viewportOffset: number;
}

export interface GoalEventRetention {
  ingestion?: 'tail' | 'older';
  viewportAnchorSequence?: number | null;
}

export const scopedGoalKey = (ownerId: string, repository: string, goalId: string): string =>
  JSON.stringify([ownerId, repository, goalId]);

export const mergeGoalEvents = (
  current: GoalEvent[],
  incoming: GoalEvent[],
  goalId: string,
  retention: GoalEventRetention = {}
): GoalEvent[] => {
  const bySequence = new Map<number, GoalEvent>();
  for (const event of current) if (event.goalId === goalId) bySequence.set(event.sequence, event);
  for (const event of incoming) if (event.goalId === goalId) bySequence.set(event.sequence, event);
  const merged = [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
  if (merged.length <= GOAL_EVENT_RETENTION_LIMIT) return merged;
  const ingestion = retention.ingestion ?? 'tail';
  const anchorIndex = retention.viewportAnchorSequence === null || retention.viewportAnchorSequence === undefined
    ? -1
    : merged.findIndex(event => event.sequence === retention.viewportAnchorSequence);
  if (anchorIndex < 0 && ingestion === 'tail') return merged.slice(-GOAL_EVENT_RETENTION_LIMIT);

  // Backward pagination retains a bounded history window and the authoritative
  // live tail. With a historical viewport anchor, retention also keeps that
  // row and the mounted rows after it. Older ingestion reserves one full page
  // at the pagination frontier, so repeated loads remain useful without ever
  // evicting the operator's visible row.
  const selected = new Map<number, GoalEvent>();
  const retain = (events: GoalEvent[]) => {
    for (const event of events) {
      if (selected.size >= GOAL_EVENT_RETENTION_LIMIT) break;
      selected.set(event.sequence, event);
    }
  };
  retain(merged.slice(-GOAL_EVENT_HISTORY_RESERVE));
  if (anchorIndex >= 0) {
    retain([merged[anchorIndex]]);
    if (ingestion === 'older') retain(merged.slice(0, GOAL_EVENT_OLDER_FRONTIER_RESERVE));
    retain(merged.slice(anchorIndex, anchorIndex + GOAL_EVENT_HISTORY_RESERVE));
    retain(merged.slice(Math.max(0, anchorIndex - GOAL_EVENT_HISTORY_RESERVE), anchorIndex).reverse());
  } else {
    retain(merged.slice(0, GOAL_EVENT_HISTORY_RESERVE));
  }
  retain(ingestion === 'older' ? merged : [...merged].reverse());
  return [...selected.values()].sort((left, right) => left.sequence - right.sequence);
};

export const makeGoalIntentKey = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `goal-intent-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const payloadRecord = (payload: GoalJsonValue): Record<string, GoalJsonValue> | null =>
  payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;

export const eventContent = (event: GoalEvent): string => {
  const payload = payloadRecord(event.payload);
  for (const field of ['chunk', 'content', 'text', 'message', 'detail']) {
    if (typeof payload?.[field] === 'string') return payload[field] as string;
  }
  if (event.payload === null) return '';
  if (typeof event.payload === 'string') return event.payload;
  return JSON.stringify(event.payload, null, 2);
};

export const eventSource = (event: GoalEvent): string => {
  const payload = payloadRecord(event.payload);
  return typeof payload?.provider === 'string' ? payload.provider
    : typeof payload?.source === 'string' ? payload.source
      : event.kind;
};

export const eventTurnId = (event: GoalEvent): string | null => {
  const payload = payloadRecord(event.payload);
  return typeof payload?.turnId === 'string' ? payload.turnId : null;
};

export const eventSearchText = (event: GoalEvent): string =>
  `${event.eventType} ${event.kind} ${eventSource(event)} ${eventTurnId(event) ?? ''} ${eventContent(event)}`.toLocaleLowerCase();

export const sanitizeTerminalText = (value: string): string => value
  .replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, '')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');

export const sanitizeTerminalLabel = (value: string): string => sanitizeTerminalText(value)
  .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim();
