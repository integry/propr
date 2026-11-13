import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { getAuthenticatedOctokit } from '../../auth/githubAuth.js';
import { loadRepositoryPrStatusDisplay } from '../../config/repositoryPrStatusSetting.js';
import { loadUltrafixRatingGoal } from '../../config/configManagerUltrafix.js';
import { getNonBlockingChecksForRepository } from '../../daemon/configLoader.js';
import { db } from '../../db/connection.js';
import { getIssueQueue } from '../../queue/taskQueue.js';
import logger from '../../utils/logger.js';
import { findPRsForCommitCached, getUltrafixStateRedis } from '../../webhook/checkRunHelpers.js';
import { computePullRequestStatus } from './pullRequestStatus.js';
import { setPullRequestStatusCommitSyncRunner, setPullRequestStatusSyncRunner } from './pullRequestStatusSignal.js';
import {
    applyPullRequestStatusBlock,
    preservePullRequestStatusBlock,
    renderPullRequestStatusBlock,
    sameRenderedStatus,
} from './pullRequestStatusBlock.js';
import {
    countQueuedPullRequestJobs,
    loadPullRequestStatusFacts,
    type PullRequestStatusGitHub,
    type PullRequestStatusPull,
    type PullRequestStatusSources,
} from './pullRequestStatusFacts.js';

type LockRedis = Pick<Redis, 'set' | 'eval' | 'get' | 'del'>;

export interface PullRequestStatusSyncDeps {
    github: PullRequestStatusGitHub;
    redis: LockRedis | null;
    loadEnabled: (repository: string) => Promise<boolean>;
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

/** GitHub is resolved lazily: a repository with the setting off and no block costs no GitHub call. */
function resolveDeps(overrides: Partial<PullRequestStatusSyncDeps> = {}): ResolvedDeps {
    const merged = { ...runtimeDeps, ...overrides };
    const redis = merged.redis !== undefined ? merged.redis : getUltrafixStateRedis();
    return {
        github: async () => merged.github ?? await getAuthenticatedOctokit() as unknown as PullRequestStatusGitHub,
        redis,
        loadEnabled: merged.loadEnabled ?? loadRepositoryPrStatusDisplay,
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

// --- Per-PR serialization ---

const LOCK_TTL_MS = 30_000;
const LOCK_WAIT_MS = 20_000;
const LOCK_POLL_MS = 150;
const RELEASE_SCRIPT = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';
const localChains = new Map<string, Promise<unknown>>();
/** A PR left open untouched this long keeps its block if the setting is turned off meanwhile. */
const BLOCK_MARKER_TTL_SECONDS = 180 * 24 * 60 * 60;

function prKey(repository: string, prNumber: number): string {
    return `${repository.toLowerCase()}#${prNumber}`;
}

/** Redis marker: ProPR wrote a block on this PR, so turning the setting off must remove it. */
function blockMarkerKey(repository: string, prNumber: number): string {
    return `propr:pr-status:block:${repository.toLowerCase()}:${prNumber}`;
}

/**
 * Runs `work` while holding the pull request's body lock, so two transitions
 * (or a transition and another body writer) cannot interleave their
 * read-modify-write of the body. Serialized in-process and across processes.
 */
export async function withPullRequestBodyLock<T>(repository: string, prNumber: number, redis: LockRedis | null, work: () => Promise<T>): Promise<T> {
    const key = prKey(repository, prNumber);
    const previous = localChains.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
        if (!redis) return await work();
        const lockKey = `propr:pr-status:lock:${key}`;
        const token = randomUUID();
        const deadline = Date.now() + LOCK_WAIT_MS;
        while (await redis.set(lockKey, token, 'PX', LOCK_TTL_MS, 'NX') !== 'OK') {
            if (Date.now() > deadline) throw new Error(`Timed out waiting for the pull request body lock of ${key}`);
            await new Promise(resolve => setTimeout(resolve, LOCK_POLL_MS));
        }
        try {
            return await work();
        } finally {
            await redis.eval(RELEASE_SCRIPT, 1, lockKey, token).catch(() => undefined);
        }
    });
    localChains.set(key, run);
    try {
        return await run;
    } finally {
        if (localChains.get(key) === run) localChains.delete(key);
    }
}

// --- Body sync ---

async function readPull(github: PullRequestStatusGitHub, repository: string, prNumber: number): Promise<PullRequestStatusPull> {
    const [owner, repo] = repository.split('/');
    return (await github.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', { owner, repo, pull_number: prNumber })).data as PullRequestStatusPull;
}

async function desiredBlock(
    deps: PullRequestStatusSyncDeps, target: { repository: string; prNumber: number; pull: PullRequestStatusPull; enabled: boolean },
): Promise<string | null> {
    const { repository, prNumber, pull, enabled } = target;
    if (!enabled || pull.state !== 'open' || pull.merged) return null;
    const facts = await loadPullRequestStatusFacts(repository, prNumber, { ...deps.sources, github: deps.github }, pull);
    return renderPullRequestStatusBlock(computePullRequestStatus(facts), deps.now());
}

/**
 * Brings the status block of one pull request up to date: writes it when the
 * repository shows the status and the PR is an open ProPR PR, removes it
 * otherwise (closed, merged, or the setting was turned off). Sends no PATCH
 * when the rendered status is unchanged.
 */
export async function syncPullRequestStatus(
    repository: string, prNumber: number, overrides: Partial<PullRequestStatusSyncDeps> = {},
): Promise<PullRequestStatusSyncResult> {
    const resolved = resolveDeps(overrides);
    const enabled = await resolved.loadEnabled(repository);
    const marker = blockMarkerKey(repository, prNumber);
    // With the setting off, only a PR ProPR wrote a block on needs a read.
    if (!enabled && resolved.redis && !await resolved.redis.get(marker)) return 'skipped';
    const deps: PullRequestStatusSyncDeps = { ...resolved, github: await resolved.github() };
    return await withPullRequestBodyLock(repository, prNumber, deps.redis, async () => {
        const pull = await readPull(deps.github, repository, prNumber);
        const block = await desiredBlock(deps, { repository, prNumber, pull, enabled });
        const current = pull.body ?? '';
        const next = applyPullRequestStatusBlock(current, block);
        if (next === current || sameRenderedStatus(next, current)) {
            // The block already in the body (e.g. the one the PR was created
            // with) is ProPR's too: record it so turning the setting off removes it.
            if (block) await deps.redis?.set(marker, '1', 'EX', BLOCK_MARKER_TTL_SECONDS);
            else await deps.redis?.del(marker);
            return block ? 'unchanged' : 'skipped';
        }
        const [owner, repo] = repository.split('/');
        await deps.github.request('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', { owner, repo, pull_number: prNumber, body: next });
        if (block) await deps.redis?.set(marker, '1', 'EX', BLOCK_MARKER_TTL_SECONDS);
        else await deps.redis?.del(marker);
        logger.debug({ repository, prNumber, removed: !block }, 'Updated the pull request status block');
        return block ? 'updated' : 'removed';
    });
}

// --- Scheduling from transitions ---

const DEFAULT_DEBOUNCE_MS = 1_000;
interface ScheduledSync { timer: NodeJS.Timeout | null; running: boolean; rerun: boolean }
const scheduled = new Map<string, ScheduledSync>();

function runScheduled(repository: string, prNumber: number, key: string): void {
    const entry = scheduled.get(key);
    if (!entry) return;
    entry.timer = null;
    entry.running = true;
    void syncPullRequestStatus(repository, prNumber)
        .catch(error => logger.warn({ repository, prNumber, error: (error as Error).message },
            'Failed to update the pull request status block; the next transition retries'))
        .finally(() => {
            entry.running = false;
            if (entry.rerun && runtimeEnabled) {
                entry.rerun = false;
                entry.timer = setTimeout(() => runScheduled(repository, prNumber, key), DEFAULT_DEBOUNCE_MS);
                entry.timer.unref?.();
            } else {
                scheduled.delete(key);
            }
        });
}

/** Bursts of transitions coalesce into one update; a failure is logged and retried on the next transition. */
function schedulePullRequestStatusSync(repository: string, number: number): void {
    if (!runtimeEnabled) return;
    const key = prKey(repository, number);
    const entry = scheduled.get(key);
    if (entry) {
        if (entry.running) entry.rerun = true;
        return;
    }
    const created: ScheduledSync = { timer: null, running: false, rerun: false };
    scheduled.set(key, created);
    created.timer = setTimeout(() => runScheduled(repository, number, key), DEFAULT_DEBOUNCE_MS);
    created.timer.unref?.();
}

/**
 * Records that a pull request carries a ProPR status block it was created
 * with, so turning the setting off removes that block on the next transition
 * even when no update ever rewrote it. Never throws.
 */
export async function recordPullRequestStatusBlock(
    repository: string, prNumber: number, options: { redis?: LockRedis | null } = {},
): Promise<void> {
    if (!runtimeEnabled && options.redis === undefined) return;
    const redis = options.redis !== undefined ? options.redis : resolveDeps().redis;
    try {
        await redis?.set(blockMarkerKey(repository, prNumber), '1', 'EX', BLOCK_MARKER_TTL_SECONDS);
    } catch (error) {
        logger.warn({ repository, prNumber, error: (error as Error).message }, 'Failed to record the pull request status block; the next update records it');
    }
}

// --- Checks reported against a commit ---

const commitLookups = new Map<string, NodeJS.Timeout>();

/**
 * Open pull requests whose status a commit's check change can alter. Legacy
 * commit statuses name only the commit, so its pull requests are looked up;
 * a repository that does not show the status costs no GitHub call.
 */
export async function resolvePullRequestsForCommitStatus(
    repository: string, sha: string, overrides: Partial<PullRequestStatusSyncDeps> = {},
): Promise<number[]> {
    const resolved = resolveDeps(overrides);
    if (!await resolved.loadEnabled(repository)) return [];
    return await resolved.findPullRequestsForCommit(repository, sha);
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
    return await withPullRequestBodyLock(`${owner}/${repo}`, pullNumber, redis, async () => {
        const current = (await github.request<{ data: { body?: string | null } }>('GET /repos/{owner}/{repo}/pulls/{pull_number}', { owner, repo, pull_number: pullNumber })).data?.body ?? '';
        const next = preservePullRequestStatusBlock(body, current);
        if (next === current) return { data: { body: current } } as T;
        return await patch(next);
    });
}

/**
 * The block a new ProPR pull request is created with, so the status is in the
 * body from the first moment: the creating task is still running. Null when
 * the repository does not show the status.
 */
export async function initialPullRequestStatusBlock(
    repository: string,
    options: { activity?: 'implementing' | 'follow_up'; loadEnabled?: (repository: string) => Promise<boolean>; now?: () => Date } = {},
): Promise<string | null> {
    if (!runtimeEnabled && !options.loadEnabled) return null;
    try {
        if (!await (options.loadEnabled ?? runtimeDeps.loadEnabled ?? loadRepositoryPrStatusDisplay)(repository)) return null;
    } catch (error) {
        logger.warn({ repository, error: (error as Error).message }, 'Failed to read the pull request status setting; creating the pull request without the block');
        return null;
    }
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
