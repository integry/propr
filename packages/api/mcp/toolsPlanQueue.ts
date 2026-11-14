import { z } from 'zod';
import {
  EpicQueueActionError, InvalidBlockedEventCursorError, listEpicQueueBlockedEvents, retryEpicQueueIssue, skipEpicQueueIssue,
} from '@propr/core';
import { McpError } from './config.js';
import { type McpTool, type ToolDeps, idSchema, mutationShape, ok, planShape } from './tools.js';

/**
 * Blocked events of a plan's epic execution, and the skip and retry actions that move it on.
 * The actions name the execution they act on (`epicQueue.executionId` from get_plan) and are
 * refused for a stale one, an in-flight or done issue, or a state that changed since it was read.
 */

function queueError(error: unknown): never {
  if (error instanceof EpicQueueActionError) throw new McpError(error.code, error.message, error.status, { stage: 'precondition' });
  if (error instanceof InvalidBlockedEventCursorError) throw new McpError('INVALID_INPUT', error.message);
  throw error;
}

export function addPlanQueueTools(tools: McpTool[], deps: ToolDeps, target: McpTool['target']): void {
  const { db } = deps;
  // Built here, not at module load: tools.js imports this module while it is still initializing.
  const actionShape = {
    ...mutationShape, ...planShape,
    executionId: idSchema.describe('epicQueue.executionId from get_plan; a newer or finished execution refuses the action.'),
    issue: z.number().int().positive().describe('Issue number of an issue in the execution.'),
    expectedState: z.enum(['pending', 'dispatched', 'done', 'blocked', 'skipped']).optional()
      .describe('Refuse with STATE_CHANGED unless the issue is still in this state.'),
  };
  tools.push({ name: 'list_plan_blocked_events', description: 'List when issues of your plan\'s epic execution became blocked (reason kind and text) and when each blocker was resolved (cleared, replaced, retried, skipped or settled), oldest first. One event per blocked state: repeated observations are not repeated. Page with cursor; poll with the last nextCursor to read only new events instead of re-reading the plan.', scope: 'read', readOnly: true, target,
    schema: z.object({ ...planShape, executionId: idSchema.optional().describe('Defaults to the plan\'s current execution.'),
      cursor: z.string().max(32).optional().describe('nextCursor of an earlier page.'), limit: z.number().int().min(1).max(200).default(50) }).strict(),
    run: async ({ args }) => {
      try { return ok(await listEpicQueueBlockedEvents(args.planId, { executionId: args.executionId, cursor: args.cursor, limit: args.limit, database: db })); }
      catch (error) { return queueError(error); }
    } });
  tools.push({ name: 'skip_plan_issue', description: 'Skip a pending or blocked issue of your plan\'s epic execution; the queue treats it as finished for scheduling. A sequential execution moves on to the next issue. In a graph execution its dependents keep waiting on the skipped prerequisite unless satisfiesDependents is true (skip again with true to release them). The GitHub issue is never closed or edited. Refused for an issue in flight or already done. Idempotent.', scope: 'execute', target,
    schema: z.object({ ...actionShape, satisfiesDependents: z.boolean().default(false).describe('Graph executions: treat the skipped issue as a met prerequisite.') }).strict(),
    run: async ({ args }) => {
      try {
        return ok(await skipEpicQueueIssue({ draftId: args.planId, executionId: args.executionId, issueNumber: args.issue,
          expectedState: args.expectedState, satisfiesDependents: args.satisfiesDependents }, { database: db }));
      } catch (error) { return queueError(error); }
    } });
  tools.push({ name: 'retry_plan_issue', description: 'Retry a blocked issue of your plan\'s epic execution: its blocker is cleared and the issue is dispatched again under the queue\'s normal guards (a paused plan holds it; a graph starts it once ready within maxParallel). An issue closed without merge is reopened first; one whose run reported a blocker goes back to pending. A wait for a human merge or a label handoff keeps its claim and is re-evaluated. Works for issues started by implement_plan despite their implementation receipt. Refused for an issue in flight, done, not blocked, or waiting for setup. Idempotent.', scope: 'execute', target,
    schema: z.object(actionShape).strict(),
    run: async ({ args }) => {
      try {
        return ok(await retryEpicQueueIssue({ draftId: args.planId, executionId: args.executionId, issueNumber: args.issue,
          expectedState: args.expectedState }, { database: db }));
      } catch (error) { return queueError(error); }
    } });
}
