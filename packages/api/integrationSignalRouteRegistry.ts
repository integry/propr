import type { createPullRequestReadinessRoutes, createRepositoryEventRoutes } from './routes/index.js';
import type { RequestHandler } from 'express';

export interface IntegrationSignalRouteDeps {
  pullRequestReadinessRoutes: Pick<ReturnType<typeof createPullRequestReadinessRoutes>, 'getReadiness'>;
  repositoryEventRoutes: Pick<ReturnType<typeof createRepositoryEventRoutes>, 'listEvents' | 'waitEvents'>;
}

type RouteEntry = ['get', string, ...RequestHandler<never>[]];

/** Read-only coordinator signals: PR readiness verdicts and the repository change-event journal. */
export function createIntegrationSignalRouteEntries({
  pullRequestReadinessRoutes,
  repositoryEventRoutes,
}: IntegrationSignalRouteDeps): RouteEntry[] {
  return [
    ['get', '/api/pull-requests/:number/readiness', pullRequestReadinessRoutes.getReadiness],
    ['get', '/api/repository-events', repositoryEventRoutes.listEvents],
    ['get', '/api/repository-events/wait', repositoryEventRoutes.waitEvents],
  ];
}
