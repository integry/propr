import type { Redis } from 'ioredis';
import { hasStatusSlot, PR_BODY_MAX_LENGTH, readStatusSlot } from '@propr/shared';
import { getAuthenticatedOctokit } from '../../auth/githubAuth.js';
import { loadMonitoredRepos } from '../../config/configManager.js';
import { loadUltrafixRatingGoal } from '../../config/configManagerUltrafix.js';
import { loadRepositoryPrTitleStatus } from '../../config/repositoryPrTitleStatusSetting.js';
import { getNonBlockingChecksForRepository } from '../../daemon/configLoader.js';
import { db } from '../../db/connection.js';
import { getIssueQueue } from '../../queue/taskQueue.js';
import logger from '../../utils/logger.js';
import { findPRsForCommitCached, getUltrafixStateRedis } from '../../webhook/checkRunHelpers.js';
import { computePullRequestStatus, isUndeterminedPullRequestStatus, type EpicStatusFacts, type PullRequestStatus } from './pullRequestStatus.js';
import {
    epicSyncNotes, startEpicSyncRunner, stopEpicSyncRunner, syncEpicSideOfStatus, undeterminedEpicUpdate, withEpicChildReadContinuation, type EpicSyncNotes,
} from './pullRequestStatusEpicSync.js';
import { pullRequestBodyKey as prKey, PullRequestBodyLockLostError, withPullRequestBodyLock } from './pullRequestBodyLock.js';
import { recordPullRequestStatusWrite } from './pullRequestStatusProvenance.js';
import { decidePullRequestTitleForSync, recordPendingPullRequestTitleSlot, recordPullRequestTitleSlot } from './pullRequestStatusTitle.js';
import {
    setPullRequestStatusBaseSyncRunner, setPullRequestStatusCommitSyncRunner, setPullRequestStatusRedisProvider, setPullRequestStatusSyncRunner,
} from './pullRequestStatusSignal.js';
import {
    schedulePullRequestStatusBackfill,
    schedulePullRequestStatusForBasePush,
    type PullRequestListCursor,
    type PullRequestStatusBackfillResult,
    type PullRequestStatusBackfillWork,
    type PullRequestStatusBasePushResult,
    type PullRequestStatusReconcileDeps,
    type PullRequestStatusScheduleOptions,
} from './pullRequestStatusReconcile.js';
import {
    schedulePullRequestStatusBaseListing,
    startPullRequestStatusBackfillRun,
    stopPullRequestStatusReconcileRuns,
    type PullRequestStatusReconcileRunner,
} from './pullRequestStatusReconcileRuns.js';
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
    isProprCreatedPullRequest,
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
    /** Repositories the startup backfill reads: the ones ProPR monitors. */
    listRepositories: () => Promise<string[]>;
    /** The prTitleStatus setting of a repository; rejects when it cannot be read, and the title is then left unchanged. */
    loadTitleStatusSetting: (repository: string) => Promise<boolean>;
}

export type PullRequestStatusSyncResult = 'updated' | 'removed' | 'unchanged' | 'skipped';

/**
 * Status maintenance runs only in processes that opted in (worker, daemon,
 * API webhook intake). Library users and tests never write PR bodies, open
 * Redis connections or read GitHub through it unless they enable it.
 */
let runtimeEnabled = false;
let runtimeDeps: Partial<PullRequestStatusSyncDeps> = {};
let backfillStarted = false;

/**
 * `backfill` also schedules, once per process, the update of every open pull
 * request ProPR created (backfillPullRequestStatus): those that existed
 * before this process started get no transition of their own.
 */
export function enablePullRequestStatusSync(deps: Partial<PullRequestStatusSyncDeps> = {}, options: { backfill?: boolean } = {}): void {
    runtimeEnabled = true;
    runtimeDeps = deps;
    setPullRequestStatusSyncRunner(schedulePullRequestStatusSync);
    setPullRequestStatusCommitSyncRunner(schedulePullRequestStatusSyncForCommit);
    setPullRequestStatusBaseSyncRunner(schedulePullRequestStatusSyncForBase);
    setPullRequestStatusRedisProvider(() => resolveDeps({}).redis);
    startEpicSyncRunner({
        github: () => resolveDeps({}).github(), db: resolveDeps({}).sources.db, schedule: (repository, prNumber) => schedulePullRequestStatusSync(repository, prNumber),
        enabled: () => runtimeEnabled,
    });
    if (options.backfill && !backfillStarted) {
        backfillStarted = true;
        startPullRequestStatusBackfillRun(reconcileRunner);
    }
}

export function disablePullRequestStatusSync(): void {
    runtimeEnabled = false;
    runtimeDeps = {};
    backfillStarted = false;
    stopPullRequestStatusReconcileRuns();
    setPullRequestStatusSyncRunner(null);
    setPullRequestStatusCommitSyncRunner(null);
    setPullRequestStatusBaseSyncRunner(null);
    setPullRequestStatusRedisProvider(null);
    stopEpicSyncRunner();
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
        listRepositories: merged.listRepositories ?? loadMonitoredRepos,
        loadTitleStatusSetting: merged.loadTitleStatusSetting ?? loadRepositoryPrTitleStatus,
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

/**
 * The status to write, whether a GitHub check read rejected while its facts
 * were read (PullRequestStatusChecks.readFailed), and whether ProPR created the
 * pull request (only its title is ever changed).
 */
interface DesiredStatus { status: PullRequestStatus | null; checksReadFailed: boolean; isProprPullRequest: boolean; epic: EpicStatusFacts | null }

async function desiredStatus(
    deps: PullRequestStatusSyncDeps, target: { repository: string; prNumber: number; pull: PullRequestStatusPull },
): Promise<DesiredStatus> {
    const { repository, prNumber, pull } = target;
    if (pull.state !== 'open' || pull.merged) {
        // Ownership decides only whether a slot left in the title is removed; a title without one is never read for it.
        const isPropr = hasStatusSlot(pull.title) && await isProprCreatedPullRequest(deps.sources.db, repository, { number: prNumber, head: pull.head });
        return { status: null, checksReadFailed: false, isProprPullRequest: isPropr, epic: null };
    }
    const facts = await loadPullRequestStatusFacts(repository, prNumber, { ...deps.sources, github: deps.github }, pull);
    return {
        status: computePullRequestStatus(facts), checksReadFailed: facts.checks.readFailed === true, isProprPullRequest: facts.isProprPullRequest, epic: facts.epic,
    };
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

interface SyncOutcome {
    result: PullRequestStatusSyncResult;
    awaitingMergeability: boolean;
    open: boolean;
    /** The base tip GitHub last compared the pull request against. */
    baseSha: string | null;
    /** The written status says the checks could not be read because a GitHub read rejected, not because of the page budget. */
    checksReadFailed: boolean;
    /**
     * Update again after this many milliseconds: the title waits for a ⚠️ or ✅ to settle (pullRequestStatusTitle),
     * or an epic has sub-PRs still to read (withEpicChildReadContinuation).
     */
    titleSettleInMs: number | null;
}


/** Times the facts are read again because the pull request changed (sameStatusSubject) while they were read. */
const MAX_STATUS_READS = 3;

/**
 * The pull request changed on every facts read (sameStatusSubject): the status is
 * left unwritten and the update runs again.
 */
export class PullRequestChangedDuringStatusSyncError extends Error {
    constructor() {
        super('The pull request kept changing while its status was read');
        this.name = 'PullRequestChangedDuringStatusSyncError';
    }
}

function mergeability(pull: PullRequestStatusPull): boolean | null {
    return typeof pull.mergeable === 'boolean' ? pull.mergeable : null;
}

/**
 * The facts read for `read` still describe `latest`: same state, head, base
 * and mergeability. A push to the base branch changes neither the head nor
 * the state, but can make the pull request conflict: GitHub then reports a
 * different mergeability (or base tip), and a status computed from the old
 * value, such as ready, must not be written.
 */
function sameStatusSubject(read: PullRequestStatusPull, latest: PullRequestStatusPull): boolean {
    return read.state === latest.state && (read.merged === true) === (latest.merged === true) && read.head.sha === latest.head.sha
        && mergeability(read) === mergeability(latest)
        && read.base?.ref === latest.base?.ref && read.base?.sha === latest.base?.sha;
}

/**
 * The status of the pull request and the pull request as GitHub has it after
 * the facts were read. People edit the description without ProPR's body lock,
 * and the facts read takes a while (database, Redis, queue and GitHub checks),
 * so the body read before it may already be stale: the block is applied to
 * the body read after it. A change of state, head, base or mergeability
 * meanwhile reads the facts again. A person can still save, or the base
 * branch move, between this read and the PATCH; GitHub offers no conditional
 * body update, so that window stays.
 */
async function statusForLatestPull(
    deps: PullRequestStatusSyncDeps, repository: string, prNumber: number,
): Promise<DesiredStatus & { pull: PullRequestStatusPull }> {
    let read = await readPull(deps.github, repository, prNumber);
    for (let attempt = 1; attempt <= MAX_STATUS_READS; attempt++) {
        const desired = await desiredStatus(deps, { repository, prNumber, pull: read });
        const latest = await readPull(deps.github, repository, prNumber);
        if (sameStatusSubject(read, latest)) return { ...desired, pull: latest };
        read = latest;
    }
    throw new PullRequestChangedDuringStatusSyncError();
}


async function syncPullRequestStatusOnce(
    repository: string, prNumber: number, overrides: Partial<PullRequestStatusSyncDeps>,
): Promise<SyncOutcome> {
    const resolved = resolveDeps(overrides);
    const deps: PullRequestStatusSyncDeps = { ...resolved, github: await resolved.github() };
    const { notes, ...outcome } = await syncUnderBodyLock(deps, repository, prNumber);
    await syncEpicSideOfStatus(deps.github, deps.redis, { repository, prNumber }, notes);
    return outcome;
}

async function syncUnderBodyLock(deps: PullRequestStatusSyncDeps, repository: string, prNumber: number): Promise<SyncOutcome & { notes: EpicSyncNotes }> {
    return await withPullRequestBodyLock(repository, prNumber, deps.redis, async lease => {
        const desired = await statusForLatestPull(deps, repository, prNumber);
        const { status, pull, checksReadFailed } = desired;
        const current = pull.body ?? '';
        const decideTitle = async (titleStatus: PullRequestStatus | null) => await decidePullRequestTitleForSync({
            repository, prNumber, pull, status: titleStatus, isProprPullRequest: desired.isProprPullRequest, loadSetting: deps.loadTitleStatusSetting, redis: deps.redis,
        });
        // Sub-PRs left unread may be working: the published state stays, with its merged count updated (undeterminedEpicUpdate).
        // Whatever the state, they are read soon: a working epic has no settle that would read them.
        const { body: next, title } = isUndeterminedPullRequestStatus(status)
            ? await undeterminedEpicUpdate({ pull, status: status! }, deps.now(), decideTitle)
            : { body: bodyWithStatus(current, status, deps.now(), { repository, prNumber }), title: await decideTitle(status) };
        const written = extractPullRequestStatusBlock(next) !== null;
        const bodyChanged = !(next === current || sameRenderedStatus(next, current));
        const read = {
            awaitingMergeability: awaitsMergeability(status), open: status !== null, baseSha: pull.base?.sha ?? null, checksReadFailed,
            titleSettleInMs: withEpicChildReadContinuation(title.settleInMs, desired),
            notes: await epicSyncNotes(deps.redis, { repository, prNumber, lease }, desired, bodyChanged || title.title !== null),
        };
        if (!bodyChanged && title.title === null) return { result: written ? 'unchanged' : 'skipped', ...read };
        // The facts read can outlast the lease; a writer that took the lock
        // since may have changed the body, so this read must not be written.
        await lease.assertHeld();
        // Recorded before the PATCH, so the edited webhook it causes is recognised as ProPR's own however fast it arrives.
        if (bodyChanged) await recordPullRequestStatusWrite(deps.redis, repository, prNumber, extractPullRequestStatusBlock(next));
        // The title slot stays pending until GitHub accepts the rename: a rejected one is no slot a person removed.
        const titleSlot = title.title !== null ? readStatusSlot(title.title) : null;
        if (title.title !== null) await recordPendingPullRequestTitleSlot(deps.redis, repository, prNumber, titleSlot);
        const [owner, repo] = repository.split('/');
        // Body and title change in one write, so one transition costs one edited event.
        await deps.github.request('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', {
            owner, repo, pull_number: prNumber, ...(bodyChanged ? { body: next } : {}), ...(title.title !== null ? { title: title.title } : {}),
        });
        if (title.title !== null) await recordPullRequestTitleSlot(deps.redis, repository, prNumber, titleSlot);
        logger.debug({ repository, prNumber, removed: bodyChanged && !written, title: title.title !== null }, 'Updated the pull request status');
        if (!bodyChanged) return { result: written ? 'unchanged' : 'skipped', ...read };
        return { result: written ? 'updated' : 'removed', ...read };
    });
}

/**
 * Brings the status block of one pull request up to date: writes it on every
 * open ProPR PR, in every repository, and removes it once the PR is closed or
 * merged. There is no setting for it. The title slot (prTitleStatus) changes
 * in the same write. Sends no PATCH when the rendered status and the title
 * are unchanged.
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
 * webhook when it finishes; after a push to the base branch it also compares
 * the pull request with the new tip in the background. Until GitHub has
 * settled the pull request the status is re-read on this schedule, then left
 * to the next transition.
 */
const SETTLE_REFRESH_DELAYS_MS = [3_000, 10_000, 30_000, 60_000];
interface ScheduledSync {
    timer: NodeJS.Timeout | null;
    /** When the pending timer fires; a request moves it earlier, never later. */
    dueAt: number;
    running: boolean;
    rerun: boolean;
    /** Refreshes already run for this entry while GitHub had not settled the pull request. */
    refreshes: number;
    /** A pushed base tip GitHub has not yet reported comparing the pull request against. */
    awaitedBaseSha: string | null;
    /** A reconciliation read (startup backfill), which no later transition may come to retry. */
    reconcile: boolean;
}
interface ScheduleTarget { repository: string; prNumber: number; key: string }
const scheduled = new Map<string, ScheduledSync>();
let settleRefreshDelaysMs: readonly number[] = SETTLE_REFRESH_DELAYS_MS;

/** Test hook: shortens the settle refresh schedule (mergeability, pushed base); null restores it. */
export function setPullRequestStatusMergeabilityRefreshDelaysForTests(delays: readonly number[] | null): void {
    settleRefreshDelaysMs = delays ?? SETTLE_REFRESH_DELAYS_MS;
}

function arm(entry: ScheduledSync, target: ScheduleTarget, delayMs: number): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.dueAt = Date.now() + delayMs;
    entry.timer = setTimeout(() => runScheduled(target), delayMs);
    entry.timer.unref?.();
}

function runScheduled(target: ScheduleTarget): void {
    const { repository, prNumber, key } = target;
    const entry = scheduled.get(key);
    if (!entry) return;
    entry.timer = null;
    entry.running = true;
    const awaitedBaseSha = entry.awaitedBaseSha;
    let unsettled = false;
    let titleSettleInMs: number | null = null;
    void syncPullRequestStatusOnce(repository, prNumber, {})
        .then(outcome => {
            titleSettleInMs = outcome.titleSettleInMs;
            // A read from before GitHub compared the pull request with the pushed
            // base may still report the old mergeability, so it settles nothing.
            unsettled = outcome.awaitingMergeability || (awaitedBaseSha !== null && outcome.open && outcome.baseSha !== awaitedBaseSha);
            // A rejected check read wrote "checks could not be read", which no
            // later transition may come to refresh after a base push or a backfill;
            // checks left unread by the page budget are no reason to read again.
            if (outcome.checksReadFailed && (awaitedBaseSha !== null || entry.reconcile)) {
                unsettled = true;
                logger.warn({ repository, prNumber, retry: 'scheduled' }, 'The pull request checks could not be read for the status block');
            }
        })
        .catch(error => {
            // Another writer took the body lock mid-update, or the pull request
            // kept changing while it was read: re-read and write again.
            if (error instanceof PullRequestBodyLockLostError || error instanceof PullRequestChangedDuringStatusSyncError) entry.rerun = true;
            // A failed read settles nothing; a base push or a backfill has no later transition to retry it.
            else unsettled = awaitedBaseSha !== null || entry.reconcile;
            logger.warn({ repository, prNumber, error: (error as Error).message, retry: entry.rerun || unsettled ? 'scheduled' : 'next_transition' },
                'Failed to update the pull request status block');
        })
        .finally(() => finishScheduled(entry, target, { unsettled, awaitedBaseSha, titleSettleInMs }));
}

function finishScheduled(
    entry: ScheduledSync, target: ScheduleTarget, run: { unsettled: boolean; awaitedBaseSha: string | null; titleSettleInMs: number | null },
): void {
    entry.running = false;
    if (!run.unsettled) {
        entry.refreshes = 0;
        entry.reconcile = false;
        // A push during the run awaits its own, newer tip.
        if (entry.awaitedBaseSha === run.awaitedBaseSha) entry.awaitedBaseSha = null;
    }
    const refreshDelay = run.unsettled ? settleRefreshDelaysMs[entry.refreshes] : undefined;
    if (!runtimeEnabled || (!entry.rerun && refreshDelay === undefined && run.titleSettleInMs === null)) {
        scheduled.delete(target.key);
        return;
    }
    if (entry.rerun) {
        entry.rerun = false;
        arm(entry, target, DEFAULT_DEBOUNCE_MS);
        return;
    }
    if (refreshDelay !== undefined) {
        entry.refreshes++;
        arm(entry, target, refreshDelay);
        return;
    }
    // A ⚠️ or ✅ waits to settle; a transition before then reads again sooner.
    arm(entry, target, run.titleSettleInMs as number);
}

/**
 * Bursts of transitions coalesce into one update; a failure is logged and
 * retried on the next transition. Until GitHub settles the pull request
 * (mergeability, a pushed base) the update is repeated on a bounded schedule
 * (SETTLE_REFRESH_DELAYS_MS), which a transition does not wait for.
 */
function schedulePullRequestStatusSync(repository: string, number: number, options: PullRequestStatusScheduleOptions = {}): void {
    if (!runtimeEnabled) return;
    const target = { repository, prNumber: number, key: prKey(repository, number) };
    let entry = scheduled.get(target.key);
    if (!entry) {
        entry = { timer: null, dueAt: 0, running: false, rerun: false, refreshes: 0, awaitedBaseSha: null, reconcile: false };
        scheduled.set(target.key, entry);
    }
    if (options.baseSha) {
        // A new base tip restarts the bounded wait for GitHub to compare against it.
        entry.awaitedBaseSha = options.baseSha;
        entry.refreshes = 0;
    }
    if (options.reconcile) entry.reconcile = true;
    if (entry.running) {
        // The running read may predate this change; a reconciliation read it covers.
        if (!options.reconcile) entry.rerun = true;
        return;
    }
    const delayMs = DEFAULT_DEBOUNCE_MS + (options.delayMs ?? 0);
    if (!entry.timer || Date.now() + delayMs < entry.dueAt) arm(entry, target, delayMs);
}

// --- Reconciliation: pushes to a base branch, open pull requests at startup ---

async function reconcileDeps(overrides: Partial<PullRequestStatusSyncDeps>): Promise<PullRequestStatusReconcileDeps & { listRepositories: () => Promise<string[]> }> {
    const resolved = resolveDeps(overrides);
    return { github: await resolved.github(), db: resolved.sources.db, schedule: schedulePullRequestStatusSync, listRepositories: resolved.listRepositories };
}

/**
 * Schedules the status update of the open ProPR pull requests into `branch`,
 * which was pushed to `sha`: one batch, from `from` (the start when absent).
 */
export async function refreshPullRequestStatusForBasePush(
    push: { repository: string; branch: string; sha: string; from?: PullRequestListCursor | null }, overrides: Partial<PullRequestStatusSyncDeps> = {},
): Promise<PullRequestStatusBasePushResult> {
    return await schedulePullRequestStatusForBasePush(await reconcileDeps(overrides), push);
}

/** Schedules the status update of open ProPR pull requests in the monitored repositories: one batch of `work` (all of them when absent). */
export async function backfillPullRequestStatus(
    overrides: Partial<PullRequestStatusSyncDeps> = {}, work?: PullRequestStatusBackfillWork[],
): Promise<PullRequestStatusBackfillResult> {
    return await schedulePullRequestStatusBackfill(await reconcileDeps(overrides), work);
}

/** Runs the enumerations above batch by batch, with this process's maintenance state and retry schedule. */
const reconcileRunner: PullRequestStatusReconcileRunner = {
    enabled: () => runtimeEnabled,
    retryDelaysMs: () => settleRefreshDelaysMs,
    debounceMs: DEFAULT_DEBOUNCE_MS,
    backfill: work => backfillPullRequestStatus({}, work),
    refreshForBasePush: push => refreshPullRequestStatusForBasePush(push),
};

function schedulePullRequestStatusSyncForBase(repository: string, branch: string, sha: string): void {
    if (runtimeEnabled) schedulePullRequestStatusBaseListing(reconcileRunner, { repository, branch, sha });
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

export { initialPullRequestStatusBlock } from './pullRequestStatusInitialBlock.js';
