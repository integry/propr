import type { Response } from 'express';
import type { FlatRequest } from '../requestTypes.js';
import {
  EpicQueueActionError, InvalidBlockedEventCursorError, listEpicQueueBlockedEvents, retryEpicQueueIssue, skipEpicQueueIssue,
  type EpicQueueIssueState,
} from '@propr/core';
import type { PlanIssueDeps } from './planIssueHandlers.js';

/**
 * Blocked events and the skip/retry actions of a plan's epic execution. Each action names the
 * execution it acts on (`executionId` from the execution queue) and is refused for a stale one.
 */
const ISSUE_STATES: EpicQueueIssueState[] = ['pending', 'dispatched', 'done', 'blocked', 'skipped'];

function sendQueueActionError(res: Response, error: unknown, fallback: string): void {
  if (error instanceof EpicQueueActionError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
  if (error instanceof InvalidBlockedEventCursorError) { res.status(400).json({ error: error.message }); return; }
  console.error(`${fallback}:`, error);
  res.status(500).json({ error: fallback });
}

type ActionBody = { executionId: string; issueNumber: number; expectedState?: EpicQueueIssueState; satisfiesDependents?: boolean };

/** Validates the shared action input; returns an error message when it is invalid. */
function parseAction(req: FlatRequest, { allowSatisfies }: { allowSatisfies: boolean }): ActionBody | string {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const issueNumber = Number(req.params.issueNumber);
  if (!Number.isInteger(issueNumber) || issueNumber < 1) return 'issueNumber must be a positive integer';
  if (typeof body.executionId !== 'string' || !body.executionId) return 'executionId is required; read it from the execution queue';
  if (body.expectedState !== undefined && !ISSUE_STATES.includes(body.expectedState as EpicQueueIssueState)) {
    return `expectedState must be one of ${ISSUE_STATES.join(', ')}`;
  }
  if (body.satisfiesDependents !== undefined && (!allowSatisfies || typeof body.satisfiesDependents !== 'boolean')) {
    return allowSatisfies ? 'satisfiesDependents must be a boolean' : 'satisfiesDependents applies only to skip';
  }
  return { executionId: body.executionId, issueNumber, expectedState: body.expectedState as EpicQueueIssueState | undefined,
    satisfiesDependents: body.satisfiesDependents as boolean | undefined };
}

/** Lists the execution's blocked and resolved events after a cursor, oldest first. */
export function createListBlockedEventsHandler(deps: PlanIssueDeps) {
  return async function listBlockedEvents(req: FlatRequest, res: Response): Promise<void> {
    try {
      const ownership = await deps.verifyOwnership(req.params.id, req.user!.id, ['user_id']);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }
      const { executionId, cursor, limit } = req.query as Record<string, unknown>;
      const parsedLimit = limit === undefined ? undefined : Number(limit);
      if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 200)) {
        res.status(400).json({ error: 'limit must be an integer from 1 to 200' }); return;
      }
      if ((executionId !== undefined && typeof executionId !== 'string') || (cursor !== undefined && typeof cursor !== 'string')) {
        res.status(400).json({ error: 'executionId and cursor must be strings' }); return;
      }
      res.json(await listEpicQueueBlockedEvents(req.params.id, { executionId: executionId || undefined, cursor, limit: parsedLimit }));
    } catch (error) {
      sendQueueActionError(res, error, 'Failed to list blocked events');
    }
  };
}

function createActionHandler(deps: PlanIssueDeps, action: 'skip' | 'retry') {
  return async function queueAction(req: FlatRequest, res: Response): Promise<void> {
    try {
      const ownership = await deps.verifyOwnership(req.params.id, req.user!.id, ['user_id']);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }
      const input = parseAction(req, { allowSatisfies: action === 'skip' });
      if (typeof input === 'string') { res.status(400).json({ error: input }); return; }
      const target = { draftId: req.params.id, executionId: input.executionId, issueNumber: input.issueNumber, expectedState: input.expectedState };
      res.json(action === 'skip'
        ? await skipEpicQueueIssue({ ...target, satisfiesDependents: input.satisfiesDependents })
        : await retryEpicQueueIssue(target));
    } catch (error) {
      sendQueueActionError(res, error, action === 'skip' ? 'Failed to skip the issue' : 'Failed to retry the issue');
    }
  };
}

/** Marks a pending or blocked issue skipped; the queue treats it as finished for scheduling. */
export const createSkipQueueIssueHandler = (deps: PlanIssueDeps) => createActionHandler(deps, 'skip');
/** Clears a blocked issue's blocker and dispatches it again under the normal guards. */
export const createRetryQueueIssueHandler = (deps: PlanIssueDeps) => createActionHandler(deps, 'retry');
