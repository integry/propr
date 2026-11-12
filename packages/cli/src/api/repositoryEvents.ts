/**
 * Repository events API
 *
 * Cursor reads and bounded waits on a repository's durable change-event
 * journal: `GET /api/repository-events` and `GET /api/repository-events/wait`.
 */

import {
  REPOSITORY_EVENT_WAIT_MAX_TIMEOUT_SECONDS,
  type RepositoryEventDomain,
  type RepositoryEventListResult,
  type RepositoryEventWaitResult,
} from "@propr/shared";
import { ApiClient, createApiClient } from "./index.js";

export type { RepositoryEventListResult, RepositoryEventWaitResult, RepositoryEventView } from "@propr/shared";

export interface RepositoryEventQuery {
  repository: string;
  afterCursor?: string;
  fromStart?: boolean;
  domains?: RepositoryEventDomain[];
  types?: string[];
  pullRequest?: number;
  planId?: string;
  limit?: number;
}

/** Extra time the HTTP request may take beyond the server-side wait. */
const WAIT_REQUEST_GRACE_MS = 15_000;

function params(query: RepositoryEventQuery): Record<string, string | number | undefined> {
  return {
    repository: query.repository,
    afterCursor: query.afterCursor,
    fromStart: query.fromStart ? "true" : undefined,
    domains: query.domains?.length ? query.domains.join(",") : undefined,
    types: query.types?.length ? query.types.join(",") : undefined,
    pullRequest: query.pullRequest,
    planId: query.planId,
    limit: query.limit,
  };
}

/**
 * Events after a cursor; without one, the current cursor and no history (unless `fromStart`).
 * A request without a cursor or `fromStart` establishes the server's current
 * end, so a retry after a lost response could move that boundary past events
 * appended meanwhile: it is sent exactly once, and a failure surfaces instead.
 * Requests with a cursor or `fromStart` are replayable and keep retries.
 */
export async function listRepositoryEvents(query: RepositoryEventQuery, client?: ApiClient): Promise<RepositoryEventListResult> {
  const apiClient = client ?? (await createApiClient());
  const replayable = query.afterCursor !== undefined || query.fromStart === true;
  return (await apiClient.get<RepositoryEventListResult>("/api/repository-events", { params: params(query), retry: replayable })).data;
}

/**
 * One bounded wait request (at most {@link REPOSITORY_EVENT_WAIT_MAX_TIMEOUT_SECONDS} seconds).
 * A request without a cursor starts at the server's current end, so it is
 * sent exactly once; a request with a cursor is replayable and keeps retries.
 */
export async function waitRepositoryEvents(
  query: RepositoryEventQuery & { timeoutSeconds: number },
  options: { client?: ApiClient; signal?: AbortSignal } = {},
): Promise<RepositoryEventWaitResult> {
  const apiClient = options.client ?? (await createApiClient());
  const timeoutSeconds = Math.min(Math.max(0, query.timeoutSeconds), REPOSITORY_EVENT_WAIT_MAX_TIMEOUT_SECONDS);
  const response = await apiClient.get<RepositoryEventWaitResult>("/api/repository-events/wait", {
    params: { ...params(query), timeoutSeconds },
    timeout: timeoutSeconds * 1000 + WAIT_REQUEST_GRACE_MS,
    signal: options.signal,
    retry: query.afterCursor !== undefined,
  });
  return response.data;
}
