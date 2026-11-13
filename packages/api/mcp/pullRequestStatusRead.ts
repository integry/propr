import {
  countQueuedPullRequestJobs,
  getNonBlockingChecksForRepository,
  loadPullRequestStatus,
  loadUltrafixRatingGoal,
  type PullRequestStatus,
  type PullRequestStatusPull,
} from '@propr/core';
import type { McpPrincipal } from './policy.js';
import type { ToolDeps } from './tools.js';

/** At most this many pull requests get a computed status per list call; the rest read null. */
export const STATUS_LIMIT = 20;
const STATUS_CONCURRENCY = 4;

/**
 * The computed ProPR status of one pull request: the same computation the PR
 * body block shows, read with the caller's own GitHub credential. Supplementary:
 * null when it cannot be read, so it never fails the pull request read itself.
 */
export async function readPullRequestStatus(
  deps: Pick<ToolDeps, 'db' | 'redisClient' | 'taskQueue'>,
  principal: McpPrincipal,
  target: { repository: string; pullRequest: number; pull?: PullRequestStatusPull },
): Promise<PullRequestStatus | null> {
  try {
    return await loadPullRequestStatus(target.repository, target.pullRequest, {
      github: principal.github as unknown as Parameters<typeof loadPullRequestStatus>[2]['github'],
      db: deps.db,
      redis: deps.redisClient ? { get: async (key: string) => await deps.redisClient.get(key) as string | null } : null,
      loadRatingGoal: loadUltrafixRatingGoal,
      loadNonBlockingChecks: getNonBlockingChecksForRepository,
      countQueuedJobs: deps.taskQueue
        ? async (repository, prNumber) => await countQueuedPullRequestJobs(deps.taskQueue as never, repository, prNumber)
        : undefined,
    }, target.pull);
  } catch {
    return null;
  }
}

/**
 * Adds `proprStatus` to the first `STATUS_LIMIT` items that are open; closed and
 * merged pull requests are `none` without a GitHub read. Returns whether the
 * limit left items without a computed status.
 */
export async function attachPullRequestStatuses(
  deps: Pick<ToolDeps, 'db' | 'redisClient' | 'taskQueue'>,
  principal: McpPrincipal,
  items: Array<{ item: Record<string, unknown>; repository: string; number: number; open: boolean }>,
): Promise<boolean> {
  const open = items.filter(entry => entry.open);
  const selected = open.slice(0, STATUS_LIMIT);
  for (const entry of items) {
    if (!entry.open) entry.item.proprStatus = { state: 'none' };
    else if (!selected.includes(entry)) entry.item.proprStatus = null;
  }
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(STATUS_CONCURRENCY, selected.length) }, async () => {
    while (cursor < selected.length) {
      const entry = selected[cursor++];
      entry.item.proprStatus = await readPullRequestStatus(deps, principal, { repository: entry.repository, pullRequest: entry.number });
    }
  }));
  return open.length > selected.length;
}
