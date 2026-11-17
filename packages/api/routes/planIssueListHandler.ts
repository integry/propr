import type { Response } from 'express';
import type { FlatRequest } from '../requestTypes.js';
import {
  db, getEpicExecutionQueue, getPlanIssuesByDraft, getPlanIssuesByDraftPaginated, PlanIssueStatus,
  reconcileDraftPlanIssueRefinement, summarizeEpicQueue, type PlanIssue,
} from '@propr/core';
import { resolveIssueForResponse } from './planIssueRouteUtils.js';
import { withRecordedPullRequestActivity } from './planIssuePullRequestActivity.js';
import type { PlanIssueDeps } from './planIssueHandlers.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_PAGE = 1_000_000;

type IssueState = NonNullable<ReturnType<typeof summarizeEpicQueue>>['issueStates'][number];
type PlanIssueExecution = Omit<IssueState, 'issue'> & { executionId: string; executionMode: string; queueStatus: string };

/** A non-negative decimal integer, or null when the value is not one (a sign, fraction, exponent or garbage). */
function parseCount(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** `page` is zero-based; `limit` is 1 or more, capped at 100. Absent values take their defaults. */
export function parseIssuePaging(query: Record<string, unknown>): { page: number; limit: number } | { error: string } {
  const page = query.page === undefined ? 0 : parseCount(query.page);
  if (page === null || page > MAX_PAGE) return { error: `page must be an integer from 0 to ${MAX_PAGE}` };
  const limit = query.limit === undefined ? DEFAULT_LIMIT : parseCount(query.limit);
  if (limit === null || limit < 1) return { error: 'limit must be a positive integer' };
  return { page, limit: Math.min(limit, MAX_LIMIT) };
}

/**
 * Each issue's standing in the plan's epic execution, exactly as GET …/execution-queue reports it:
 * the queue state (a skipped issue is `skipped` there while its plan status stays as it was), the
 * schedule, and the execution's dependency edges (`dependsOn`: the chain in a sequential execution,
 * the plan edges in a graph) with the unfinished prerequisites it waits on. Null outside the execution.
 */
export async function executionStatesByIssue(draftId: string): Promise<Map<number, PlanIssueExecution>> {
  const summary = summarizeEpicQueue(await getEpicExecutionQueue(draftId));
  const states = new Map<number, PlanIssueExecution>();
  for (const { issue, ...state } of summary?.issueStates ?? []) {
    states.set(issue, { ...state, executionId: summary!.executionId, executionMode: summary!.executionMode, queueStatus: summary!.status });
  }
  return states;
}

/**
 * GET /api/planner/drafts/:id/issues. Without `page`/`limit` it answers a bare array of every issue: the
 * released CLI (`listPlanIssues`) and the UI's `getPlanIssues` read that form, so it stays. With either one
 * it answers `{ issues, total, page, limit, hasMore }`. Every issue carries the same `execution` object in both.
 */
export function createGetIssuesHandler(deps: PlanIssueDeps) {
  return async function getIssues(req: FlatRequest, res: Response): Promise<void> {
    try {
      const ownership = await deps.verifyOwnership(req.params.id, req.user!.id, ['user_id']);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }
      const query = (req.query ?? {}) as Record<string, unknown>;
      const hasPagination = query.page !== undefined || query.limit !== undefined;
      const paging = hasPagination ? parseIssuePaging(query) : null;
      if (paging && 'error' in paging) { res.status(400).json({ error: paging.error }); return; }
      // Settle refinement whose follow-up work ended before filtering, counting or paging.
      await reconcileDraftPlanIssueRefinement(req.params.id);
      const executions = await executionStatesByIssue(req.params.id);
      const present = async (issues: PlanIssue[]) =>
        (await withRecordedPullRequestActivity(db, issues)).map(issue =>
          ({ ...resolveIssueForResponse(issue), execution: executions.get(issue.issue_number) ?? null }));
      if (!paging) { res.json(await present(await getPlanIssuesByDraft(req.params.id))); return; }
      const options: { page: number; limit: number; status?: PlanIssueStatus } = { ...paging };
      const { status } = query;
      if (status && (Object.values(PlanIssueStatus) as unknown[]).includes(status)) options.status = status as PlanIssueStatus;
      const result = await getPlanIssuesByDraftPaginated(req.params.id, options);
      res.json({ ...result, issues: await present(result.issues) });
    } catch (error) {
      console.error('Get issues error:', error);
      res.status(500).json({ error: 'Failed to fetch issues' });
    }
  };
}
