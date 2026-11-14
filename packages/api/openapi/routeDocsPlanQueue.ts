import { EpicQueueActionError, EpicQueueActionResult, EpicQueueBlockedEventPage, EpicQueueBlockedEventsQuery, EpicQueueRetryRequest,
  EpicQueueSkipRequest } from './schemasPlanQueue.js';
import type { RouteDoc } from './types.js';

const PLAN_ID = 'The plan (draft) id.';
const ISSUE = 'GitHub issue number of an issue in the execution.';
const refusals = {
  400: { description: 'The body or issue number is invalid.' },
  404: { description: 'The issue is not part of the execution.', schema: EpicQueueActionError },
  409: { description: 'Refused: a stale execution (`STALE_EXECUTION`), an issue in flight (`IN_FLIGHT`) or already done (`ALREADY_DONE`), a changed state (`STATE_CHANGED`), or, for retry, an issue that is not blocked (`NOT_BLOCKED`) or waits for setup (`NOT_RETRYABLE`).', schema: EpicQueueActionError },
};

export const PLAN_QUEUE_ROUTE_DOCS: Record<string, RouteDoc> = {
  'GET /api/planner/drafts/:id/execution-queue/blocked-events': {
    operationId: 'listPlanExecutionBlockedEvents',
    summary: 'List the blocked events of a plan\'s epic execution',
    description: 'Every time an issue of the execution became blocked (with its reason kind and text), and every resolution of such a blocker, oldest first. A repeated observation of the same blocked state is recorded once. Page with `cursor`; poll with the last `nextCursor` to read only new events.',
    tags: ['Planner'],
    pathParams: { id: PLAN_ID },
    query: EpicQueueBlockedEventsQuery,
    responses: {
      200: { description: 'A page of events.', schema: EpicQueueBlockedEventPage },
      400: { description: 'The cursor or limit is invalid.' },
    },
  },
  'POST /api/planner/drafts/:id/execution-queue/issues/:issueNumber/skip': {
    operationId: 'skipPlanExecutionIssue',
    summary: 'Skip a pending or blocked issue of an epic execution',
    description: 'The queue treats the issue as finished for scheduling: a sequential execution moves on to the next issue; in a graph execution its dependents wait on the skipped prerequisite unless `satisfiesDependents` is true. The GitHub issue is never closed or edited. Idempotent: skipping a skipped issue answers `already_skipped`.',
    tags: ['Planner'],
    pathParams: { id: PLAN_ID, issueNumber: ISSUE },
    requestBody: { schema: EpicQueueSkipRequest },
    responses: { 200: { description: 'The issue is skipped.', schema: EpicQueueActionResult }, ...refusals },
  },
  'POST /api/planner/drafts/:id/execution-queue/issues/:issueNumber/retry': {
    operationId: 'retryPlanExecutionIssue',
    summary: 'Retry a blocked issue of an epic execution',
    description: 'Clears the blocker and dispatches the issue again under the queue\'s normal guards (a paused plan holds it; a graph starts it once ready within its limit). An issue closed without merge is reopened first; one whose run reported a blocker is put back to pending. A wait for a human merge or a label handoff keeps its claim and is re-evaluated. Works for issues started through MCP `implement_plan`. Idempotent: repeating it answers `already_retried`.',
    tags: ['Planner'],
    pathParams: { id: PLAN_ID, issueNumber: ISSUE },
    requestBody: { schema: EpicQueueRetryRequest },
    responses: { 200: { description: 'The blocker is cleared and the issue is dispatched under the normal guards.', schema: EpicQueueActionResult }, ...refusals },
  },
};
