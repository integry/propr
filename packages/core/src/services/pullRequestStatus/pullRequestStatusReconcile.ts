import type { Knex } from 'knex';
import logger from '../../utils/logger.js';
import { isProprCreatedPullRequest, type PullRequestStatusGitHub, type PullRequestStatusPull } from './pullRequestStatusFacts.js';

/**
 * Status updates no single pull request event asks for: a push to a base
 * branch, which can make every pull request into it conflict, and the open
 * pull requests that already existed when this process started. Both list
 * open pull requests from GitHub within a fixed page budget, keep the ones
 * ProPR created, and schedule their updates spaced apart.
 */

/** Open pull requests read per page, and pages read per repository or base branch. */
const PULL_LIST_PAGE = 100;
const MAX_PULL_LIST_PAGES = 3;
/** Repositories one startup backfill reads. */
export const MAX_STATUS_BACKFILL_REPOSITORIES = 100;
/** Updates one enumeration schedules start this far apart, so a fan-out never bursts GitHub. */
const DEFAULT_SPACING_MS = 250;

export interface PullRequestStatusScheduleOptions {
    /** Extra delay before the update starts. */
    delayMs?: number;
    /**
     * The tip a push just gave the pull request's base branch. The update is
     * read again, on a bounded schedule, until GitHub reports having compared
     * the pull request against it.
     */
    baseSha?: string;
    /**
     * No change is known: an update already running or pending covers it. The
     * update is retried on a bounded schedule when it fails, because no later
     * transition may come to retry it.
     */
    reconcile?: boolean;
}

export interface PullRequestStatusReconcileDeps {
    github: PullRequestStatusGitHub;
    db: Knex;
    schedule: (repository: string, prNumber: number, options: PullRequestStatusScheduleOptions) => void;
    spacingMs?: number;
}

type ListedPull = { number: number; head: PullRequestStatusPull['head'] };

async function listOpenPullRequests(
    github: PullRequestStatusGitHub, repository: string, base?: string,
): Promise<{ pulls: ListedPull[]; truncated: boolean }> {
    const [owner, repo] = repository.split('/');
    const pulls = new Map<number, ListedPull>();
    for (let page = 1; page <= MAX_PULL_LIST_PAGES; page++) {
        // Oldest first keeps pages stable while pull requests are opened.
        const { data } = await github.request('GET /repos/{owner}/{repo}/pulls', {
            owner, repo, state: 'open', sort: 'created', direction: 'asc', per_page: PULL_LIST_PAGE, page, ...(base ? { base } : {}),
        });
        const listed = Array.isArray(data) ? data as ListedPull[] : [];
        for (const pull of listed) if (typeof pull?.number === 'number' && pull.head) pulls.set(pull.number, pull);
        if (listed.length < PULL_LIST_PAGE) return { pulls: [...pulls.values()], truncated: false };
    }
    return { pulls: [...pulls.values()], truncated: true };
}

async function proprCreatedPullRequests(db: Knex, repository: string, pulls: ListedPull[]): Promise<number[]> {
    const numbers: number[] = [];
    for (const pull of pulls) if (await isProprCreatedPullRequest(db, repository, pull)) numbers.push(pull.number);
    return numbers;
}

/**
 * A push to `branch` changes what every open pull request into it is merged
 * with, so each may now conflict without any event of its own: schedules the
 * status update of the ones ProPR created. Returns their numbers.
 */
export async function schedulePullRequestStatusForBasePush(
    deps: PullRequestStatusReconcileDeps, push: { repository: string; branch: string; sha: string },
): Promise<number[]> {
    const { repository, branch, sha } = push;
    const { pulls, truncated } = await listOpenPullRequests(deps.github, repository, branch);
    if (truncated) {
        logger.warn({ repository, branch, listed: pulls.length },
            'More open pull requests target the pushed branch than one status refresh reads; the rest update on their next transition');
    }
    const numbers = await proprCreatedPullRequests(deps.db, repository, pulls);
    const spacing = deps.spacingMs ?? DEFAULT_SPACING_MS;
    numbers.forEach((prNumber, index) => deps.schedule(repository, prNumber, { baseSha: sha, delayMs: index * spacing }));
    return numbers;
}

function distinctRepositories(names: readonly string[]): string[] {
    const seen = new Map<string, string>();
    for (const name of names) {
        const trimmed = typeof name === 'string' ? name.trim() : '';
        if (/^[^/\s]+\/[^/\s]+$/.test(trimmed) && !seen.has(trimmed.toLowerCase())) seen.set(trimmed.toLowerCase(), trimmed);
    }
    return [...seen.values()];
}

/**
 * Brings the status block of every open pull request ProPR created up to
 * date once, in each repository ProPR monitors: pull requests that existed
 * before this process started get no transition of their own. Bounded by
 * MAX_STATUS_BACKFILL_REPOSITORIES and the page budget per repository. A
 * repository that cannot be read is returned in `failed`, for a retry.
 */
export async function schedulePullRequestStatusBackfill(
    deps: PullRequestStatusReconcileDeps & { listRepositories: () => Promise<string[]> },
): Promise<{ repositories: number; scheduled: number; failed: string[] }> {
    const all = distinctRepositories(await deps.listRepositories());
    if (all.length > MAX_STATUS_BACKFILL_REPOSITORIES) {
        logger.warn({ repositories: all.length, read: MAX_STATUS_BACKFILL_REPOSITORIES },
            'More monitored repositories than one status backfill reads; the rest update on their next transition');
    }
    const repositories = all.slice(0, MAX_STATUS_BACKFILL_REPOSITORIES);
    const numbersByRepository: Array<[string, number[]]> = [];
    const failed: string[] = [];
    for (const repository of repositories) {
        try {
            const { pulls, truncated } = await listOpenPullRequests(deps.github, repository);
            if (truncated) logger.warn({ repository, listed: pulls.length }, 'More open pull requests than one status backfill reads; the rest update on their next transition');
            numbersByRepository.push([repository, await proprCreatedPullRequests(deps.db, repository, pulls)]);
        } catch (error) {
            failed.push(repository);
            logger.warn({ repository, error: (error as Error).message }, 'Failed to list the open pull requests of a repository for the status backfill');
        }
    }
    // One spacing across repositories, so the backfill's updates start spread out.
    const spacing = deps.spacingMs ?? DEFAULT_SPACING_MS;
    let index = 0;
    for (const [repository, numbers] of numbersByRepository) {
        for (const prNumber of numbers) deps.schedule(repository, prNumber, { reconcile: true, delayMs: index++ * spacing });
    }
    logger.info({ repositories: repositories.length, scheduled: index, failed: failed.length }, 'Scheduled the status update of open ProPR pull requests');
    return { repositories: repositories.length, scheduled: index, failed };
}
