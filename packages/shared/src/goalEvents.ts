import type { GoalJsonValue } from './goals.js';

export const GOAL_EVENT_SCHEMA_VERSION = 1 as const;
export const GOAL_EVENT_KINDS = ['lifecycle', 'output', 'domain'] as const;
export type GoalEventKind = (typeof GOAL_EVENT_KINDS)[number];

export const GOAL_EVENT_TYPES = [
  'provider.output',
  'provider.assistant',
  'provider.tool',
  'provider.plan',
  'provider.todo',
  'provider.status',
  'provider.model',
  'provider.completed',
  'usage.reported',
  'checkpoint.saved',
  'lifecycle.state_changed',
  'message.enqueued',
  'message.claimed',
  'message.delivered',
  'message.acknowledged',
  'message.failed',
  'message.cancelled',
  'github.entity_changed',
] as const;
export type GoalEventType = (typeof GOAL_EVENT_TYPES)[number];

/**
 * Canonical replay envelope. `cursor` is deliberately opaque; `sequence` is
 * only the monotonic event position used for ordering and projection fencing.
 * Payloads remain provider/control-plane DTOs and are never rewritten for UI.
 */
export interface GoalEventEnvelope {
  schemaVersion: typeof GOAL_EVENT_SCHEMA_VERSION;
  goalId: string;
  sequence: number;
  eventType: GoalEventType;
  kind: GoalEventKind;
  payload: GoalJsonValue;
  createdAt: string;
  cursor: string;
}

export const GOAL_DETAIL_REFRESH_EVENT_TYPES: readonly GoalEventType[] = [
  'provider.plan', 'provider.todo', 'provider.status', 'provider.model',
  'usage.reported', 'provider.completed', 'checkpoint.saved', 'lifecycle.state_changed',
  'message.enqueued', 'message.claimed', 'message.delivered',
  'message.acknowledged', 'message.failed', 'message.cancelled',
  'github.entity_changed',
];
