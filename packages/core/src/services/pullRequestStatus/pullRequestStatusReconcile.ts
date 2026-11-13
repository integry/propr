import type { Knex } from 'knex';
import logger from '../../utils/logger.js';
import { isProprCreatedPullRequest, type PullRequestStatusGitHub, type PullRequestStatusPull } from './pullRequestStatusFacts.js';

/**
 * Status updates no single pull request event asks for: a push to a base
 * branch, which can make every pull request into it conflict, and the open
 * pull requests that already existed when this process started. Both list
 * open pull requests from GitHub in bounded batches (a page budget per
 * repository, a repository budget per backfill batch), keep the ones ProPR
 * created, and schedule their updates spaced apart. A batch the budget cuts
 * short returns where it stopped, and the caller resumes there: the budget
 * defers pull requests, it never drops them.
 */

/** Open pull requests read per page, and pages one batch reads per repository or base branch. */
const PULL_LIST_PAGE = 100;
const MAX_PULL_LIST_PAGES = 3;
/** Repositories one startup backfill batch reads. */
export const MAX_STATUS_BACKFILL_REPOSITORIES = 100;
/** Updates one enumeration schedules start this far apart, so a fan-out never bursts GitHub. */
const DEFAULT_SPACING_MS = 250;
/** The least time between two batches of one enumeration, so batches that schedule nothing do not list back to back. */
const MIN_RESUME_DELAY_MS = 2_000;

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

/**
 * Where a listing the page budget cut short resumes. Open pull requests are
 * listed oldest first, and pull request numbers rise with creation, so a
 * number marks a place in the listing however its pages shift.
 */
export interface PullRequestListCursor {
    /** The last page the batch read; the next batch starts there. */
    page: number;
    /** The highest pull request number the listing has covered. */
    after: number;
}

/** A repository the backfill still has to list: from the start, or from where a batch stopped. */
export interface PullRequestStatusBackfillWork {
    repository: string;
    from: PullRequestListCursor | null;
}

export interface PullRequestStatusBasePushResult {
    /** The ProPR pull requests this batch scheduled. */
    scheduled: number[];
    /** Where the listing resumes; null once every open pull request into the branch was listed. */
    next: PullRequestListCursor | null;
    /** When the next batch may start: after this batch's updates have started. */
    resumeAfterMs: number;
}

export interface PullRequestStatusBackfillResult {
    /** Repositories this batch listed. */
    repositories: number;
    scheduled: number;
    /** Work whose listing failed, for a retry from where it was. */
    failed: PullRequestStatusBackfillWork[];
    /** Work the batch budget left: repositories not listed yet, and listings cut short. */
    remaining: PullRequestStatusBackfillWork[];
    resumeAfterMs: number;
}

type ListedPull = { number: number; head: PullRequestStatusPull['head'] };

/** Every pull request past `after` is on this page or a later one: the first page, or one that starts at or before it. */
function holdsCursor(listed: ListedPull[], page: number, after: number): boolean {
    const first = listed[0]?.number;
    return page === 1 || (typeof first === 'number' && first <= after);
}

/** Adds the listed pull requests numbered past `after`; returns the highest number listed. */
function collectAfter(listed: ListedPull[], after: number, pulls: Map<number, ListedPull>): number {
    let highest = after;
    for (const pull of listed) {
        if (typeof pull?.number !== 'number' || !pull.head || pull.number <= after) continue;
        pulls.set(pull.number, pull);
        highest = Math.max(highest, pull.number);
    }
    return highest;
}

/**
 * One batch of the open pull requests of a repository (into `base`), at most
 * MAX_PULL_LIST_PAGES pages, from the start or from `from`. Pull requests
 * closed since the previous batch move later ones to earlier pages, so a
 * resumed batch first steps back to a page that holds the cursor (holdsCursor)
 * and lists on from there, skipping the pull requests it already covered.
 */
async function listOpenPullRequests(
    github: PullRequestStatusGitHub, repository: string, options: { base?: string; from?: PullRequestListCursor | null } = {},
): Promise<{ pulls: ListedPull[]; next: PullRequestListCursor | null }> {
    const [owner, repo] = repository.split('/');
    const after = options.from?.after ?? 0;
    const pulls = new Map<number, ListedPull>();
    let page = options.from?.page ?? 1;
    let located = !options.from;
    let covered = after;
    for (let reads = 0; reads < MAX_PULL_LIST_PAGES; reads++) {
        const { data } = await github.request('GET /repos/{owner}/{repo}/pulls', {
            owner, repo, state: 'open', sort: 'created', direction: 'asc', per_page: PULL_LIST_PAGE, page, ...(options.base ? { base: options.base } : {}),
        });
        const listed = Array.isArray(data) ? data as ListedPull[] : [];
        if (!located && !holdsCursor(listed, page, after)) {
            page--;
            continue;
        }
        located = true;
        covered = Math.max(covered, collectAfter(listed, after, pulls));
        if (listed.length < PULL_LIST_PAGE) return { pulls: [...pulls.values()], next: null };
        page++;
    }
    // Resume on the last page read, or where the search for the cursor got to.
    return { pulls: [...pulls.values()], next: { page: located ? page - 1 : page, after: covered } };
}

function resumeDelayMs(scheduled: number, spacing: number): number {
    return Math.max(MIN_RESUME_DELAY_MS, scheduled * spacing);
}

async function proprCreatedPullRequests(db: Knex, repository: string, pulls: ListedPull[]): Promise<number[]> {
    const numbers: number[] = [];
    for (const pull of pulls) if (await isProprCreatedPullRequest(db, repository, pull)) numbers.push(pull.number);
    return numbers;
}

/**
 * A push to `branch` changes what every open pull request into it is merged
 * with, so each may now conflict without any event of its own: schedules the
 * status update of the ones ProPR created, one batch from `from` (the start
 * when absent). A cut-short listing returns `next` for the caller to resume.
 */
export async function schedulePullRequestStatusForBasePush(
    deps: PullRequestStatusReconcileDeps, push: { repository: string; branch: string; sha: string; from?: PullRequestListCursor | null },
): Promise<PullRequestStatusBasePushResult> {
    const { repository, branch, sha } = push;
    const { pulls, next } = await listOpenPullRequests(deps.github, repository, { base: branch, from: push.from });
    const numbers = await proprCreatedPullRequests(deps.db, repository, pulls);
    const spacing = deps.spacingMs ?? DEFAULT_SPACING_MS;
    numbers.forEach((prNumber, index) => deps.schedule(repository, prNumber, { baseSha: sha, delayMs: index * spacing }));
    if (next) {
        logger.info({ repository, branch, listed: pulls.length, next },
            'More open pull requests target the pushed branch than one status refresh batch reads; the next batch reads on');
    }
    return { scheduled: numbers, next, resumeAfterMs: resumeDelayMs(numbers.length, spacing) };
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
 * before this process started get no transition of their own. One call is one
 * batch: at most MAX_STATUS_BACKFILL_REPOSITORIES repositories of `work` (every
 * monitored repository, from the start, when absent) and the page budget in
 * each. What the budget leaves is returned in `remaining` and a repository
 * that cannot be read in `failed`, each for the caller to run next.
 */
export async function schedulePullRequestStatusBackfill(
    deps: PullRequestStatusReconcileDeps & { listRepositories: () => Promise<string[]> },
    work?: readonly PullRequestStatusBackfillWork[],
): Promise<PullRequestStatusBackfillResult> {
    const pending = work ? [...work] : distinctRepositories(await deps.listRepositories()).map(repository => ({ repository, from: null }));
    const batch = pending.slice(0, MAX_STATUS_BACKFILL_REPOSITORIES);
    const remaining = pending.slice(MAX_STATUS_BACKFILL_REPOSITORIES);
    if (remaining.length > 0) {
        logger.info({ repositories: pending.length, read: batch.length }, 'More repositories than one status backfill batch reads; the next batch reads on');
    }
    const numbersByRepository: Array<[string, number[]]> = [];
    const failed: PullRequestStatusBackfillWork[] = [];
    for (const item of batch) {
        const { repository } = item;
        try {
            const { pulls, next } = await listOpenPullRequests(deps.github, repository, { from: item.from });
            numbersByRepository.push([repository, await proprCreatedPullRequests(deps.db, repository, pulls)]);
            if (next) {
                remaining.push({ repository, from: next });
                logger.info({ repository, listed: pulls.length, next }, 'More open pull requests than one status backfill batch reads; the next batch reads on');
            }
        } catch (error) {
            failed.push(item);
            logger.warn({ repository, error: (error as Error).message }, 'Failed to list the open pull requests of a repository for the status backfill');
        }
    }
    // One spacing across repositories, so the backfill's updates start spread out.
    const spacing = deps.spacingMs ?? DEFAULT_SPACING_MS;
    let index = 0;
    for (const [repository, numbers] of numbersByRepository) {
        for (const prNumber of numbers) deps.schedule(repository, prNumber, { reconcile: true, delayMs: index++ * spacing });
    }
    logger.info({ repositories: batch.length, scheduled: index, failed: failed.length, remaining: remaining.length },
        'Scheduled the status update of open ProPR pull requests');
    return { repositories: batch.length, scheduled: index, failed, remaining, resumeAfterMs: resumeDelayMs(index, spacing) };
}
