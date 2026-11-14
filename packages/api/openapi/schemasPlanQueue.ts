import { z } from 'zod';
import { apiQuerySets, apiSchemas } from './schemas.js';

/** Schemas of a plan's epic execution queue: blocked events and the skip and retry actions. */
function component<T extends z.ZodType>(id: string, schema: T, description?: string): T {
  const described = (description ? schema.describe(description) : schema) as T;
  apiSchemas.add(described, { id });
  return described;
}

const ISSUE_STATES = ['pending', 'dispatched', 'done', 'blocked', 'skipped'] as const;
const BLOCKED_KINDS = ['closed_unmerged', 'missing_from_plan', 'dispatch_failed', 'agent_blocked', 'awaiting_human_merge',
  'label_handoff', 'setup_not_ready'] as const;

export const EpicQueueBlockedEvent = component('EpicQueueBlockedEvent', z.object({
  id: z.number().int().positive().describe('Monotonic event id; also the list cursor.'),
  draftId: z.string().describe('The plan.'),
  executionId: z.string(),
  issueNumber: z.number().int().positive(),
  position: z.number().int().nonnegative().describe('The occurrence: a requeued issue starts a new one at a new position.'),
  type: z.enum(['blocked', 'resolved']),
  blockedKind: z.enum(BLOCKED_KINDS),
  reason: z.string(),
  blockedEventId: z.number().int().positive().nullable().describe('For a resolved event: the blocked event it resolves.'),
  resolution: z.enum(['cleared', 'replaced', 'retried', 'skipped', 'settled']).nullable()
    .describe('How the blocker ended: cleared by the queue, replaced by another blocker, retried or skipped by a person, or settled with the issue.'),
  createdAt: z.number().int().describe('Epoch milliseconds.'),
}), 'One blocked transition of an issue in an epic execution, or the resolution of one.');

export const EpicQueueBlockedEventPage = component('EpicQueueBlockedEventPage', z.object({
  executionId: z.string().nullable().describe('The listed execution; null when the plan never queued work.'),
  events: z.array(EpicQueueBlockedEvent),
  nextCursor: z.string().nullable().describe('Pass as `cursor` to read the events after this page; unchanged when the page is empty.'),
  hasMore: z.boolean(),
}));

export const EpicQueueBlockedEventsQuery = (() => {
  const schema = z.object({
    executionId: z.string().optional().describe('Defaults to the plan\'s current execution.'),
    cursor: z.string().optional().describe('`nextCursor` of an earlier page; omit to read from the first event.'),
    limit: z.number().int().min(1).max(200).optional().describe('Page size; defaults to 50.'),
  });
  apiQuerySets.add(schema, { id: 'EpicQueueBlockedEventsQuery' });
  return schema;
})();

export const EpicQueueSkipRequest = component('EpicQueueSkipRequest', z.object({
  executionId: z.string().describe('The execution read from the execution queue; a newer or finished one refuses the skip.'),
  expectedState: z.enum(ISSUE_STATES).optional().describe('Refuse with `STATE_CHANGED` unless the issue is still in this state.'),
  satisfiesDependents: z.boolean().optional().describe('Graph executions: treat the skipped issue as a met prerequisite, so its dependents can start. Skipping again with the other value changes only this option.'),
}));

export const EpicQueueRetryRequest = component('EpicQueueRetryRequest', z.object({
  executionId: z.string().describe('The execution read from the execution queue; a newer or finished one refuses the retry.'),
  expectedState: z.enum(ISSUE_STATES).optional().describe('Refuse with `STATE_CHANGED` unless the issue is still in this state.'),
}));

export const EpicQueueActionResult = component('EpicQueueActionResult', z.object({
  outcome: z.enum(['skipped', 'already_skipped', 'retried', 'already_retried']),
  executionId: z.string(),
  issueNumber: z.number().int().positive(),
  queue: z.object({}).loose().nullable().describe('The execution queue after the action.'),
}));

export const EpicQueueActionError = component('EpicQueueActionError', z.object({
  error: z.string(),
  code: z.enum(['NOT_FOUND', 'STALE_EXECUTION', 'IN_FLIGHT', 'ALREADY_DONE', 'STATE_CHANGED', 'NOT_BLOCKED', 'NOT_RETRYABLE']),
}), 'A refused queue action.');
