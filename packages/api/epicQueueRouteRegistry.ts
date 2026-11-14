import type { createPlannerRoutes } from './routes/index.js';
import type { RequestHandler } from 'express';

type EpicQueueHandlers = 'getExecutionQueue' | 'queueRemaining' | 'listBlockedEvents' | 'skipQueueIssue' | 'retryQueueIssue';

export interface EpicQueueRouteDeps {
  plannerRoutes: Pick<ReturnType<typeof createPlannerRoutes>, EpicQueueHandlers>;
}

type RouteEntry = ['get' | 'post', string, ...RequestHandler<never>[]];

/** Epic execution queue: per-issue state, blocked events, and skip/retry actions. */
export function createEpicQueueRouteEntries({ plannerRoutes }: EpicQueueRouteDeps): RouteEntry[] {
  return [
    ['get', '/api/planner/drafts/:id/execution-queue', plannerRoutes.getExecutionQueue],
    ['post', '/api/planner/drafts/:id/execution-queue', plannerRoutes.queueRemaining],
    ['get', '/api/planner/drafts/:id/execution-queue/blocked-events', plannerRoutes.listBlockedEvents],
    ['post', '/api/planner/drafts/:id/execution-queue/issues/:issueNumber/skip', plannerRoutes.skipQueueIssue],
    ['post', '/api/planner/drafts/:id/execution-queue/issues/:issueNumber/retry', plannerRoutes.retryQueueIssue],
  ];
}
