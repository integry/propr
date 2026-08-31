import type { GoalEventV1 as GoalEvent, GoalHierarchyNodeV1 } from '../../api/goalContracts';

export const GOAL_TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);

export const scopedGoalKey = (ownerId: string, repository: string, goalId: string): string =>
  JSON.stringify([ownerId, repository, goalId]);

export const mergeGoalEvents = (current: GoalEvent[], incoming: GoalEvent[], goalId: string): GoalEvent[] => {
  const bySequence = new Map<number, GoalEvent>();
  for (const event of current) if (event.goalId === goalId) bySequence.set(event.sequence, event);
  for (const event of incoming) if (event.goalId === goalId) bySequence.set(event.sequence, event);
  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
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
