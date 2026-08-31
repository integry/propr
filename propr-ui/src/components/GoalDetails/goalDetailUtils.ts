import type { GoalEventV1 as GoalEvent, GoalHierarchyNodeV1 } from '../../api/goalContracts';

export const GOAL_TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);
export const GOAL_EVENT_RETENTION_LIMIT = 1_000;
const GOAL_EVENT_HISTORY_RESERVE = GOAL_EVENT_RETENTION_LIMIT / 2;

export const scopedGoalKey = (ownerId: string, repository: string, goalId: string): string =>
  JSON.stringify([ownerId, repository, goalId]);

export const mergeGoalEvents = (
  current: GoalEvent[],
  incoming: GoalEvent[],
  goalId: string,
  ingestion: 'tail' | 'older' = 'tail'
): GoalEvent[] => {
  const bySequence = new Map<number, GoalEvent>();
  for (const event of current) if (event.goalId === goalId) bySequence.set(event.sequence, event);
  for (const event of incoming) if (event.goalId === goalId) bySequence.set(event.sequence, event);
  const merged = [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
  if (merged.length <= GOAL_EVENT_RETENTION_LIMIT) return merged;
  if (ingestion === 'tail') return merged.slice(-GOAL_EVENT_RETENTION_LIMIT);

  // Backward pagination retains a bounded history window and the authoritative
  // live tail. The middle is intentionally evicted so loading old pages cannot
  // displace replay/gap recovery state or a concurrent live event.
  const history = merged.slice(0, GOAL_EVENT_HISTORY_RESERVE);
  const tail = merged.slice(-(GOAL_EVENT_RETENTION_LIMIT - history.length));
  return history.at(-1)?.sequence === tail[0]?.sequence
    ? [...history, ...tail.slice(1)]
    : [...history, ...tail];
};

export const hierarchyChildren = (
  nodes: GoalHierarchyNodeV1[]
): Map<string | null, GoalHierarchyNodeV1[]> => {
  const result = new Map<string | null, GoalHierarchyNodeV1[]>();
  for (const node of nodes) {
    const siblings = result.get(node.parentNodeId) ?? [];
    siblings.push(node);
    result.set(node.parentNodeId, siblings);
  }
  for (const siblings of result.values()) siblings.sort((left, right) => left.orderIndex - right.orderIndex);
  return result;
};

export const makeGoalIntentKey = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `goal-intent-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

export const eventSearchText = (event: GoalEvent): string =>
  `${event.type} ${event.source} ${event.turnId ?? ''} ${event.content}`.toLocaleLowerCase();

export const sanitizeTerminalText = (value: string): string => value
  .replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, '')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');

export const sanitizeTerminalLabel = (value: string): string => sanitizeTerminalText(value)
  .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim();
