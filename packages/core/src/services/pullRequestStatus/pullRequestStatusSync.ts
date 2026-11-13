import type { Redis } from 'ioredis';
import { PR_BODY_MAX_LENGTH } from '@propr/shared';
import { getAuthenticatedOctokit } from '../../auth/githubAuth.js';
import { loadUltrafixRatingGoal } from '../../config/configManagerUltrafix.js';
import { getNonBlockingChecksForRepository } from '../../daemon/configLoader.js';
import { db } from '../../db/connection.js';
import { getIssueQueue } from '../../queue/taskQueue.js';
import logger from '../../utils/logger.js';
import { findPRsForCommitCached, getUltrafixStateRedis } from '../../webhook/checkRunHelpers.js';
import { computePullRequestStatus, type PullRequestStatus } from './pullRequestStatus.js';
import { pullRequestBodyKey as prKey, PullRequestBodyLockLostError, withPullRequestBodyLock } from './pullRequestBodyLock.js';
import { setPullRequestStatusCommitSyncRunner, setPullRequestStatusSyncRunner } from './pullRequestStatusSignal.js';
import {
    applyPullRequestStatusBlock,
    extractPullRequestStatusBlock,
    preservePullRequestStatusBlock,
    renderCompactPullRequestStatusBlock,
    renderPullRequestStatusBlock,
    sameRenderedStatus,
    stripPullRequestStatusBlock,
} from './pullRequestStatusBlock.js';
import {
    countQueuedPullRequestJobs,
    loadPullRequestStatusFacts,
    type PullRequestStatusGitHub,
    type PullRequestStatusPull,
    type PullRequestStatusSources,
} from './pullRequestStatusFacts.js';

/** The body lock needs set/eval; the status facts read Ultrafix state with get. */
type LockRedis = Pick<Redis, 'set' | 'eval' | 'get'>;

export interface PullRequestStatusSyncDeps {
    github: PullRequestStatusGitHub;
    redis: LockRedis | null;
    sources: Omit<PullRequestStatusSources, 'github'>;
    now: () => Date;
    /** Open pull requests a commit belongs to, for checks reported against a commit. */
    findPullRequestsForCommit: (repository: string, sha: string) => Promise<number[]>;
}

export type PullRequestStatusSyncResult = 'updated' | 'removed' | 'unchanged' | 'skipped';

/**
 * Status maintenance runs only in processes that opted in (worker, daemon,
 * API webhook intake). Library users and tests never write PR bodies, open
 * Redis connections or read GitHub through it unless they enable it.
 */
let runtimeEnabled = false;
let runtimeDeps: Partial<PullRequestStatusSyncDeps> = {};

export function enablePullRequestStatusSync(deps: Partial<PullRequestStatusSyncDeps> = {}): void {
    runtimeEnabled = true;
    runtimeDeps = deps;
    setPullRequestStatusSyncRunner(schedulePullRequestStatusSync);
    setPullRequestStatusCommitSyncRunner(schedulePullRequestStatusSyncForCommit);
}

export function disablePullRequestStatusSync(): void {
    runtimeEnabled = false;
    runtimeDeps = {};
    setPullRequestStatusSyncRunner(null);
    setPullRequestStatusCommitSyncRunner(null);
    for (const entry of scheduled.values()) if (entry.timer) clearTimeout(entry.timer);
    scheduled.clear();
    for (const timer of commitLookups.values()) clearTimeout(timer);
    commitLookups.clear();
}

export function isPullRequestStatusSyncEnabled(): boolean {
    return runtimeEnabled;
}

async function countQueuedJobs(repository: string, prNumber: number): Promise<number> {
    return await countQueuedPullRequestJobs(await getIssueQueue(), repository, prNumber);
}

type ResolvedDeps = Omit<PullRequestStatusSyncDeps, 'github'> & { github: () => Promise<PullRequestStatusGitHub> };

function resolveDeps(overrides: Partial<PullRequestStatusSyncDeps> = {}): ResolvedDeps {
    const merged = { ...runtimeDeps, ...overrides };
    const redis = merged.redis !== undefined ? merged.redis : getUltrafixStateRedis();
    return {
        github: async () => merged.github ?? await getAuthenticatedOctokit() as unknown as PullRequestStatusGitHub,
        redis,
        sources: merged.sources ?? {
            db,
            redis,
            loadRatingGoal: loadUltrafixRatingGoal,
            loadNonBlockingChecks: getNonBlockingChecksForRepository,
            countQueuedJobs,
        },
        now: merged.now ?? (() => new Date()),
        findPullRequestsForCommit: merged.findPullRequestsForCommit ?? findOpenPullRequestsForCommit,
    };
}

async function findOpenPullRequestsForCommit(repository: string, sha: string): Promise<number[]> {
    const [owner, repo] = repository.split('/');
    return (await findPRsForCommitCached(owner, repo, sha)).map(pull => pull.number);
}

// --- Body sync ---

async function readPull(github: PullRequestStatusGitHub, repository: string, prNumber: number): Promise<PullRequestStatusPull> {
    const [owner, repo] = repository.split('/');
    return (await github.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', { owner, repo, pull_number: prNumber })).data as PullRequestStatusPull;
}

async function desiredStatus(
    deps: PullRequestStatusSyncDeps, target: { repository: string; prNumber: number; pull: PullRequestStatusPull },
): Promise<PullRequestStatus | null> {
    const { repository, prNumber, pull } = target;
    if (pull.state !== 'open' || pull.merged) return null;
    const facts = await loadPullRequestStatusFacts(repository, prNumber, { ...deps.sources, github: deps.github }, pull);
    return computePullRequestStatus(facts);
}

/**
 * The body with the status block for `status`, within GitHub's body limit.
 * Text outside the block is never shortened: when the full block does not fit,
 * the compact one is used, and when neither fits the block is left out.
 */
function bodyWithStatus(current: string, status: PullRequestStatus | null, now: Date, target: { repository: string; prNumber: number }): string {
    if (!status) return applyPullRequestStatusBlock(current, null);
    for (const block of [renderPullRequestStatusBlock(status, now), renderCompactPullRequestStatusBlock(status, now)]) {
        const next = applyPullRequestStatusBlock(current, block);
        if (next.length <= PR_BODY_MAX_LENGTH) return next;
    }
    logger.warn(target, 'The pull request body leaves no room for the status block; it is left out until the body is shorter');
    return applyPullRequestStatusBlock(current, null);
}

/** GitHub is still computing mergeability, so the status cannot settle yet. */
function awaitsMergeability(status: PullRequestStatus | null): boolean {
    return status?.state === 'working' && status.detail.activity === 'checking_mergeability';
}

interface SyncOutcome { result: PullRequestStatusSyncResult; awaitingMergeability: boolean }

async function syncPullRequestStatusOnce(
    repository: string, prNumber: number, overrides: Partial<PullRequestStatusSyncDeps>,
): Promise<SyncOutcome> {
    const resolved = resolveDeps(overrides);
    const deps: PullRequestStatusSyncDeps = { ...resolved, github: await resolved.github() };
    return await withPullRequestBodyLock(repository, prNumber, deps.redis, async lease => {
        const pull = await readPull(deps.github, repository, prNumber);
        const status = await desiredStatus(deps, { repository, prNumber, pull });
        const awaitingMergeability = awaitsMergeability(status);
        const current = pull.body ?? '';
        const next = bodyWithStatus(current, status, deps.now(), { repository, prNumber });
        const written = extractPullRequestStatusBlock(next) !== null;
        if (next === current || sameRenderedStatus(next, current)) return { result: written ? 'unchanged' : 'skipped', awaitingMergeability };
        // The facts read above can outlast the lease; a writer that took the
        // lock since may have changed the body, so this read must not be written.
        await lease.assertHeld();
        const [owner, repo] = repository.split('/');
        await deps.github.request('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', { owner, repo, pull_number: prNumber, body: next });
        logger.debug({ repository, prNumber, removed: !written }, 'Updated the pull request status block');
        return { result: written ? 'updated' : 'removed', awaitingMergeability };
    });
}

/**
 * Brings the status block of one pull request up to date: writes it on every
 * open ProPR PR, in every repository, and removes it once the PR is closed or
 * merged. There is no setting for it. Sends no PATCH when the rendered status
 * is unchanged.
 */
export async function syncPullRequestStatus(
    repository: string, prNumber: number, overrides: Partial<PullRequestStatusSyncDeps> = {},
): Promise<PullRequestStatusSyncResult> {
    return (await syncPullRequestStatusOnce(repository, prNumber, overrides)).result;
}

// --- Scheduling from transitions ---

const DEFAULT_DEBOUNCE_MS = 1_000;
/**
 * GitHub computes mergeability in the background after a read, and sends no
 * webhook when it finishes. While it is unknown the status is re-read on this
 * schedule, then left to the next transition.
 */
const MERGEABILITY_REFRESH_DELAYS_MS = [3_000, 10_000, 30_000, 60_000];
interface ScheduledSync {
    timer: NodeJS.Timeout | null;
    running: boolean;
    rerun: boolean;
    /** Mergeability refreshes already run for this entry. */
    mergeabilityRefreshes: number;
    /** The pending timer is a mergeability refresh, which a transition may bring forward. */
    refreshPending: boolean;
}
const scheduled = new Map<string, ScheduledSync>();
let mergeabilityRefreshDelaysMs: readonly number[] = MERGEABILITY_REFRESH_DELAYS_MS;

/** Test hook: shortens the mergeability refresh schedule; null restores it. */
export function setPullRequestStatusMergeabilityRefreshDelaysForTests(delays: readonly number[] | null): void {
    mergeabilityRefreshDelaysMs = delays ?? MERGEABILITY_REFRESH_DELAYS_MS;
}

function runScheduled(repository: string, prNumber: number, key: string): void {
    const entry = scheduled.get(key);
    if (!entry) return;
    entry.timer = null;
    entry.refreshPending = false;
    entry.running = true;
    let awaitingMergeability = false;
    void syncPullRequestStatusOnce(repository, prNumber, {})
        .then(outcome => { awaitingMergeability = outcome.awaitingMergeability; })
        .catch(error => {
            // Another writer took the body lock mid-update: re-read and write again.
            if (error instanceof PullRequestBodyLockLostError) entry.rerun = true;
            logger.warn({ repository, prNumber, error: (error as Error).message },
                'Failed to update the pull request status block; the next transition retries');
        })
        .finally(() => {
            entry.running = false;
            if (!awaitingMergeability) entry.mergeabilityRefreshes = 0;
            const refreshDelay = awaitingMergeability ? mergeabilityRefreshDelaysMs[entry.mergeabilityRefreshes] : undefined;
            if (!runtimeEnabled || (!entry.rerun && refreshDelay === undefined)) {
                scheduled.delete(key);
                return;
            }
            if (!entry.rerun) {
                entry.mergeabilityRefreshes++;
                entry.refreshPending = true;
            }
            const delay = entry.rerun ? DEFAULT_DEBOUNCE_MS : refreshDelay as number;
            entry.rerun = false;
            entry.timer = setTimeout(() => runScheduled(repository, prNumber, key), delay);
            entry.timer.unref?.();
        });
}

/**
 * Bursts of transitions coalesce into one update; a failure is logged and
 * retried on the next transition. While mergeability is unknown the update is
 * repeated on a bounded schedule (MERGEABILITY_REFRESH_DELAYS_MS).
 */
function schedulePullRequestStatusSync(repository: string, number: number): void {
    if (!runtimeEnabled) return;
    const key = prKey(repository, number);
    const entry = scheduled.get(key);
    if (entry) {
        if (entry.running) entry.rerun = true;
        else if (entry.refreshPending && entry.timer) {
            // A transition does not wait for a slow mergeability refresh.
            clearTimeout(entry.timer);
            entry.refreshPending = false;
            entry.timer = setTimeout(() => runScheduled(repository, number, key), DEFAULT_DEBOUNCE_MS);
            entry.timer.unref?.();
        }
        return;
    }
    const created: ScheduledSync = { timer: null, running: false, rerun: false, mergeabilityRefreshes: 0, refreshPending: false };
    scheduled.set(key, created);
    created.timer = setTimeout(() => runScheduled(repository, number, key), DEFAULT_DEBOUNCE_MS);
    created.timer.unref?.();
}

// --- Checks reported against a commit ---

const commitLookups = new Map<string, NodeJS.Timeout>();

/**
 * Open pull requests whose status a commit's check change can alter. Legacy
 * commit statuses name only the commit, so its pull requests are looked up.
 */
export async function resolvePullRequestsForCommitStatus(
    repository: string, sha: string, overrides: Partial<PullRequestStatusSyncDeps> = {},
): Promise<number[]> {
    return await resolveDeps(overrides).findPullRequestsForCommit(repository, sha);
}

/** A burst of status events for one commit costs one pull request lookup. */
function schedulePullRequestStatusSyncForCommit(repository: string, sha: string): void {
    if (!runtimeEnabled) return;
    const key = `${repository.toLowerCase()}@${sha.toLowerCase()}`;
    if (commitLookups.has(key)) return;
    const timer = setTimeout(() => {
        commitLookups.delete(key);
        void resolvePullRequestsForCommitStatus(repository, sha)
            .then(prNumbers => { for (const prNumber of prNumbers) schedulePullRequestStatusSync(repository, prNumber); })
            .catch(error => logger.warn({ repository, sha, error: (error as Error).message },
                'Failed to find the pull requests of a commit status change; the next transition updates their status'));
    }, DEFAULT_DEBOUNCE_MS);
    timer.unref?.();
    commitLookups.set(key, timer);
}

// --- Other body writers ---

/**
 * The one way other ProPR code rewrites a pull request body: re-reads the
 * current body under the body lock and carries the status block over, so the
 * writer neither drops nor duplicates it. Skips the PATCH when nothing changes.
 * Without status maintenance in this process the body is written as given.
 */
export async function updatePullRequestBody<T = { data: { body?: string | null } }>(
    github: { request: <R = unknown>(route: string, parameters: Record<string, unknown>) => Promise<R> },
    target: { owner: string; repo: string; pullNumber: number; body: string },
    options: { preserveStatusBlock?: boolean; redis?: LockRedis | null } = {},
): Promise<T> {
    const { owner, repo, pullNumber, body } = target;
    const patch = (nextBody: string) => github.request<T>('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', { owner, repo, pull_number: pullNumber, body: nextBody });
    if (!(options.preserveStatusBlock ?? runtimeEnabled)) return await patch(body);
    const redis = options.redis !== undefined ? options.redis : (runtimeDeps.redis !== undefined ? runtimeDeps.redis : getUltrafixStateRedis());
    return await withPullRequestBodyLock(`${owner}/${repo}`, pullNumber, redis, async lease => {
        const current = (await github.request<{ data: { body?: string | null } }>('GET /repos/{owner}/{repo}/pulls/{pull_number}', { owner, repo, pull_number: pullNumber })).data?.body ?? '';
        const preserved = preservePullRequestStatusBlock(body, current);
        // The writer's text wins over the block; the next status sync fits the block back in if it can.
        const next = preserved.length > PR_BODY_MAX_LENGTH ? stripPullRequestStatusBlock(body) : preserved;
        if (next === current) return { data: { body: current } } as T;
        await lease.assertHeld();
        return await patch(next);
    });
}

/**
 * The block a new ProPR pull request is created with, so the status is in the
 * body from the first moment: the creating task is still running. Null only
 * when this process does not maintain the status (library use and tests).
 */
export async function initialPullRequestStatusBlock(
    repository: string,
    options: { activity?: 'implementing' | 'follow_up'; now?: () => Date } = {},
): Promise<string | null> {
    if (!runtimeEnabled) return null;
    const type = options.activity === 'follow_up' ? 'pr-comment' : 'issue';
    const status = computePullRequestStatus({
        pullRequest: { state: 'open', merged: false, headSha: '', mergeable: null },
        isProprPullRequest: true,
        tasks: [{ type, mode: type === 'pr-comment' ? 'follow_up' : null, state: 'post_processing', createdAt: new Date().toISOString() }],
        queuedJobs: 0, ultrafix: null,
        checks: { complete: true, passed: 0, failed: 0, pending: 0, failedNames: [] },
        latestReviewScore: null, ratingGoal: 0, epic: null,
    });
    return renderPullRequestStatusBlock(status, (options.now ?? (() => new Date()))());
}
