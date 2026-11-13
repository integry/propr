import { z } from 'zod';
import {
  REPOSITORY_EVENT_ALL_TYPES,
  REPOSITORY_EVENT_DOMAINS,
  REPOSITORY_EVENT_LIST_DEFAULT_LIMIT,
  REPOSITORY_EVENT_LIST_MAX_LIMIT,
  REPOSITORY_EVENT_WAIT_DEFAULT_TIMEOUT_SECONDS,
  REPOSITORY_EVENT_WAIT_MAX_TIMEOUT_SECONDS,
  REPOSITORY_EVENT_WAIT_OUTCOMES,
} from '@propr/shared';
import { component, querySet } from './schemas.js';

/** Schemas of the repository change-event journal reads (`/api/repository-events`). */

const listQueryShape = {
  repository: z.string().describe('`owner/repo`. The caller must be able to read it on GitHub, and it must be configured and enabled on this instance.'),
  afterCursor: z.string().max(512).optional().describe('Opaque cursor from an earlier response for this repository. Only events after it are returned.'),
  fromStart: z.enum(['true', 'false']).optional().describe('Without `afterCursor`: `true` starts at the oldest retained event. By default a call without a cursor starts at the current end of the journal and returns no history.'),
  domains: z.string().optional().describe(`Comma-separated domains: ${REPOSITORY_EVENT_DOMAINS.map(domain => `\`${domain}\``).join(', ')}.`),
  types: z.string().optional().describe(`Comma-separated event types: ${REPOSITORY_EVENT_ALL_TYPES.map(type => `\`${type}\``).join(', ')}.`),
  pullRequest: z.number().int().min(1).optional().describe('Only events of this pull request number.'),
  planId: z.string().max(255).optional().describe('Only events of this plan.'),
  limit: z.number().int().min(1).max(REPOSITORY_EVENT_LIST_MAX_LIMIT).optional().describe(`Most events returned; defaults to ${REPOSITORY_EVENT_LIST_DEFAULT_LIMIT}.`),
};

export const RepositoryEventsQuery = querySet('RepositoryEventsQuery', z.object(listQueryShape));
export const RepositoryEventsWaitQuery = querySet('RepositoryEventsWaitQuery', z.object({
  ...listQueryShape,
  timeoutSeconds: z.number().min(0).max(REPOSITORY_EVENT_WAIT_MAX_TIMEOUT_SECONDS).optional()
    .describe(`Seconds to block when no matching event exists yet; defaults to ${REPOSITORY_EVENT_WAIT_DEFAULT_TIMEOUT_SECONDS}.`),
}));

export const RepositoryEvent = component('RepositoryEvent', z.object({
  cursor: z.string().describe('Resumes immediately after this event.'),
  domain: z.enum(REPOSITORY_EVENT_DOMAINS),
  type: z.string().describe('Event type within the domain, for example `head_changed`, `review_scored`, `merged`, `advanced` or `status_changed`.'),
  repository: z.string(),
  pullRequest: z.number().int().optional(),
  issueNumber: z.number().int().optional(),
  planId: z.string().optional(),
  entityId: z.string().describe('PR number, epic execution id or plan issue id, as text.'),
  head: z.string().optional().describe('Head SHA the event was recorded for, when it concerns one.'),
  payload: z.record(z.string(), z.unknown()).describe('Identifiers and small scalars only; never PR bodies, comments, diffs or logs.'),
  occurredAt: z.string().meta({ format: 'date-time' }),
}), 'One durable repository change event.');

const listShape = {
  events: z.array(RepositoryEvent).describe('Matching events after the cursor, in journal order.'),
  cursor: z.string().describe('After the last returned event, or the starting position when none was returned. Pass it back as `afterCursor`.'),
  truncated: z.boolean().describe('More matching events exist after `cursor`.'),
};

export const RepositoryEventList = component('RepositoryEventList', z.object(listShape),
  'Repository change events after a cursor. Delivery is at-least-once and ordered.');

export const RepositoryEventWait = component('RepositoryEventWait', z.object({
  outcome: z.enum(REPOSITORY_EVENT_WAIT_OUTCOMES).describe('`events` when matching events were found; `timeout` otherwise, with the starting cursor unchanged.'),
  ...listShape,
  waitedMs: z.number().int().nonnegative(),
  timeoutSeconds: z.number(),
}), 'Outcome of a bounded wait for repository change events.');
