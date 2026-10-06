import logger, { generateCorrelationId } from '../utils/logger.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { loadValidTriggerLabels } from '../config/configManager.js';
import { getConfig } from '../config/configStore.js';
import type { RepoToMonitor } from '../config/configManager.js';
import {
    loadEffectiveAutoResolveMergeConflicts,
    loadInstanceAutoResolveMergeConflicts,
    resolveAutoResolveMergeConflicts,
    type EffectiveAutoResolveMergeConflicts,
} from '../config/mergeConflictSettings.js';
import { getIssueQueue } from '../queue/taskQueue.js';
import { getMergeConflictAttemptsKey, getMergeConflictIdempotencyKey } from '../utils/constants.js';
import type { MergeConflictJobData } from '../queue/taskQueue.types.js';

/**
 * Automatic merge-conflict detection.
 *
 * Every decision not to resolve is logged with a reason code so a quiet PR can
 * always be explained from the logs:
 * - auto_resolve_disabled: the effective repository/instance setting is off
 * - pull_request_closed: the PR is no longer open
 * - draft_pull_request: drafts are left alone until they are ready for review
 * - fork_pull_request: the head repository no longer exists, so nothing can be pushed
 * - not_propr_pull_request: no pr_label, processing label, llm-* label or tasks row
 * - mergeability_unknown: GitHub still had not computed mergeability after polling
 * - not_conflicted: GitHub reports the PR as mergeable
 * - already_queued: this exact head+base conflict state was already queued
 * - attempt_limit: too many automatic attempts for this PR in the last 24h
 */
export type ConflictSkipReason =
    | 'auto_resolve_disabled'
    | 'pull_request_closed'
    | 'draft_pull_request'
    | 'fork_pull_request'
    | 'not_propr_pull_request'
    | 'mergeability_unknown'
    | 'not_conflicted'
    | 'already_queued'
    | 'attempt_limit';

export type ConflictTrigger = Exclude<MergeConflictJobData['triggerSource'], 'auto_merge'>;

export interface ConflictDetectionResult {
    outcome: 'queued' | 'skipped';
    reason?: ConflictSkipReason;
    prNumber: number;
    repository: string;
    jobId?: string;
}

export type Mergeability = 'conflicted' | 'clean' | 'unknown';

/** Minimal PR shape read from `GET /pulls/{n}` and `GET /pulls`. */
export interface ConflictPullRequest {
    number: number;
    state: string;
    draft?: boolean | null;
    mergeable?: boolean | null;
    mergeable_state?: string | null;
    labels?: unknown;
    head: { ref: string; sha: string; repo?: { full_name?: string } | null };
    base: { ref: string; sha: string };
}

export interface MergeConflictRedis {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, secondsToken: 'EX', seconds: number, nx?: 'NX'): Promise<unknown>;
    del(key: string): Promise<unknown>;
    incr(key: string): Promise<number>;
    decr(key: string): Promise<number>;
    expire(key: string, seconds: number): Promise<unknown>;
    eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

/** Mergeability is re-read after each delay while GitHub reports `mergeable: null`. */
export const MERGEABILITY_POLL_DELAYS_MS: readonly number[] = [2000, 5000, 10000, 20000];
export const CONFLICT_DEDUP_TTL_SECONDS = 30 * 60;
export const CONFLICT_ATTEMPT_WINDOW_SECONDS = 24 * 3600;
export const MAX_CONFLICT_ATTEMPTS_PER_WINDOW = 3;
/** Open PRs evaluated per base-branch push or sweep, per repository. */
export const MAX_PULL_REQUESTS_PER_FANOUT = 30;
/** How long a fan-out page cursor survives without being advanced. */
export const FANOUT_CURSOR_TTL_SECONDS = 7 * 24 * 3600;

export interface MergeConflictDetectionDeps {
    sleep?: (ms: number) => Promise<void>;
    pollDelaysMs?: readonly number[];
    /** Whether a ProPR task row exists for this repository + PR number. */
    hasTaskForPullRequest?: (repository: string, prNumber: number) => Promise<boolean>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** GitHub reports a conflicted PR as `mergeable: false` or `mergeable_state: "dirty"`. */
export function classifyMergeability(pr: Pick<ConflictPullRequest, 'mergeable' | 'mergeable_state'>): Mergeability {
    if (pr.mergeable === false || pr.mergeable_state === 'dirty') return 'conflicted';
    if (pr.mergeable === true) return 'clean';
    return 'unknown';
}

export function normalizeLabelNames(labels: unknown): string[] {
    if (!Array.isArray(labels)) return [];
    return labels
        .map(label => (typeof label === 'string' ? label : (label as { name?: unknown } | null)?.name))
        .filter((name): name is string => typeof name === 'string' && name.length > 0);
}

function modelLabelRegex(): RegExp {
    try {
        return new RegExp(process.env.MODEL_LABEL_PATTERN || '^llm-(.+)$');
    } catch {
        return /^llm-(.+)$/;
    }
}

async function defaultHasTaskForPullRequest(repository: string, prNumber: number): Promise<boolean> {
    const { db } = await import('../db/connection.js');
    const row = await db('tasks')
        .whereRaw('lower(repository) = ?', [repository.toLowerCase()])
        .andWhere({ pr_number: prNumber })
        .first('task_id');
    return Boolean(row);
}

/**
 * A PR is ProPR-managed when it carries the PR label, a processing label (or the
 * AI primary tag), an `llm-*` model label, or ProPR has a task row for it.
 * Human pull requests have none of these and stay untouched.
 */
export async function isProprManagedPullRequest(
    options: { repository: string; prNumber: number; labels: unknown },
    deps: MergeConflictDetectionDeps = {}
): Promise<boolean> {
    const labelNames = normalizeLabelNames(options.labels);
    if (labelNames.length > 0) {
        const triggerLabels = await loadValidTriggerLabels();
        if (labelNames.some(name => triggerLabels.includes(name))) return true;
        const modelLabel = modelLabelRegex();
        if (labelNames.some(name => modelLabel.test(name))) return true;
    }
    try {
        return await (deps.hasTaskForPullRequest ?? defaultHasTaskForPullRequest)(options.repository, options.prNumber);
    } catch (error) {
        logger.warn({ repository: options.repository, pullNumber: options.prNumber, error: (error as Error).message }, 'Merge conflict detection: task lookup failed; treating PR as not ProPR-managed');
        return false;
    }
}

type Octokit = Awaited<ReturnType<typeof getAuthenticatedOctokit>>;

async function fetchPullRequest(octokit: Octokit, owner: string, repoName: string, prNumber: number): Promise<ConflictPullRequest> {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner, repo: repoName, pull_number: prNumber,
    });
    return data as unknown as ConflictPullRequest;
}

/**
 * GitHub computes mergeability lazily: right after a push it answers
 * `mergeable: null`. Re-read on a bounded schedule instead of treating null as
 * "no conflict".
 */
export async function pollMergeability(
    read: () => Promise<ConflictPullRequest>,
    deps: MergeConflictDetectionDeps = {},
    initial?: ConflictPullRequest
): Promise<{ pr: ConflictPullRequest; mergeability: Mergeability }> {
    const sleep = deps.sleep ?? defaultSleep;
    let pr = initial ?? await read();
    let mergeability = classifyMergeability(pr);
    for (const delay of deps.pollDelaysMs ?? MERGEABILITY_POLL_DELAYS_MS) {
        if (mergeability !== 'unknown' || pr.state !== 'open') break;
        await sleep(delay);
        pr = await read();
        mergeability = classifyMergeability(pr);
    }
    return { pr, mergeability };
}

export interface MaybeQueueConflictResolutionOptions {
    owner: string;
    repoName: string;
    prNumber: number;
    trigger: ConflictTrigger;
    redisClient: MergeConflictRedis;
    correlationId: string;
    /** Pre-evaluated setting (fan-out evaluates it once per repository). */
    setting?: EffectiveAutoResolveMergeConflicts;
    /** A PR read that already happened (e.g. the priming read of a fan-out). */
    pullRequest?: ConflictPullRequest;
    octokit?: Octokit;
    deps?: MergeConflictDetectionDeps;
}

function skip(
    log: ReturnType<typeof logger.withCorrelation>,
    context: { repository: string; pullNumber: number; trigger: ConflictTrigger },
    reason: ConflictSkipReason,
    details: Record<string, unknown> = {}
): ConflictDetectionResult {
    const entry = { ...context, reason, outcome: 'skipped', ...details };
    if (reason === 'mergeability_unknown' || reason === 'attempt_limit') {
        log.warn(entry, `Merge conflict auto-resolve skipped: ${reason}`);
    } else {
        log.info(entry, `Merge conflict auto-resolve skipped: ${reason}`);
    }
    return { outcome: 'skipped', reason, prNumber: context.pullNumber, repository: context.repository };
}

/**
 * KEYS[1] = dedup key, KEYS[2] = per-PR attempts key;
 * ARGV = [dedup value, dedup TTL, attempt limit, attempt window].
 * Checking the dedup key and the per-PR allowance, then recording both, happens
 * in one script so concurrent detectors for different conflict states cannot
 * each read a stale count and exceed the limit.
 */
export const RESERVE_CONFLICT_ATTEMPT_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 'already_queued' end
local attempts = tonumber(redis.call('GET', KEYS[2]) or '0') or 0
if attempts >= tonumber(ARGV[3]) then return 'attempt_limit' end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
local count = redis.call('INCR', KEYS[2])
if count == 1 or redis.call('TTL', KEYS[2]) < 0 then redis.call('EXPIRE', KEYS[2], ARGV[4]) end
return 'reserved'
`;

/**
 * KEYS[1] = dedup key, KEYS[2] = per-PR attempts key. Returns the allowance only
 * while the counter still exists, so a release after the window expired cannot
 * leave a negative, TTL-less counter that grants extra attempts.
 */
export const RELEASE_CONFLICT_ATTEMPT_SCRIPT = `
redis.call('DEL', KEYS[1])
local attempts = tonumber(redis.call('GET', KEYS[2]) or '0') or 0
if attempts > 0 then redis.call('DECR', KEYS[2]) end
return 1
`;

/** Reserves a resolution attempt for one conflict state, atomically enforcing the per-PR allowance. */
async function reserveAttempt(
    redisClient: MergeConflictRedis,
    keys: { dedupKey: string; attemptsKey: string }
): Promise<'reserved' | 'already_queued' | 'attempt_limit'> {
    const result = await redisClient.eval(
        RESERVE_CONFLICT_ATTEMPT_SCRIPT, 2, keys.dedupKey, keys.attemptsKey,
        Date.now().toString(), CONFLICT_DEDUP_TTL_SECONDS, MAX_CONFLICT_ATTEMPTS_PER_WINDOW, CONFLICT_ATTEMPT_WINDOW_SECONDS,
    );
    if (result === 'reserved' || result === 'already_queued' || result === 'attempt_limit') return result;
    throw new Error(`Unexpected merge conflict reservation result: ${String(result)}`);
}

async function releaseAttempt(redisClient: MergeConflictRedis, keys: { dedupKey: string; attemptsKey: string }): Promise<void> {
    await redisClient.eval(RELEASE_CONFLICT_ATTEMPT_SCRIPT, 2, keys.dedupKey, keys.attemptsKey);
}

/**
 * Evaluates one PR and queues an automatic conflict resolution when it is
 * conflicted, ProPR-managed and the effective setting is on. The setting is
 * checked first so disabled repositories cost no GitHub calls.
 */
export async function maybeQueueConflictResolution(options: MaybeQueueConflictResolutionOptions): Promise<ConflictDetectionResult> {
    const { owner, repoName, prNumber, trigger, redisClient, correlationId, deps = {} } = options;
    const repository = `${owner}/${repoName}`;
    const log = logger.withCorrelation(correlationId);
    const context = { repository, pullNumber: prNumber, trigger };

    const setting = options.setting ?? await loadEffectiveAutoResolveMergeConflicts(repository);
    if (!setting.enabled) {
        return skip(log, context, 'auto_resolve_disabled', { source: setting.source });
    }

    const octokit = options.octokit ?? await getAuthenticatedOctokit();
    const read = () => fetchPullRequest(octokit, owner, repoName, prNumber);
    const first = options.pullRequest ?? await read();

    if (first.state !== 'open') return skip(log, context, 'pull_request_closed');
    if (first.draft) return skip(log, context, 'draft_pull_request');
    if (!first.head.repo) return skip(log, context, 'fork_pull_request', { headRef: first.head.ref });
    if (!await isProprManagedPullRequest({ repository, prNumber, labels: first.labels }, deps)) {
        return skip(log, context, 'not_propr_pull_request', { labels: normalizeLabelNames(first.labels) });
    }

    const { pr, mergeability } = await pollMergeability(read, deps, first);
    if (pr.state !== 'open') return skip(log, context, 'pull_request_closed');
    if (mergeability === 'unknown') {
        return skip(log, context, 'mergeability_unknown', { mergeableState: pr.mergeable_state ?? null, headSha: pr.head.sha, baseSha: pr.base.sha });
    }
    if (mergeability === 'clean') {
        return skip(log, context, 'not_conflicted', { mergeableState: pr.mergeable_state ?? null });
    }

    const keys = {
        dedupKey: getMergeConflictIdempotencyKey({ owner, repo: repoName, prNumber, headSha: pr.head.sha, baseSha: pr.base.sha }),
        attemptsKey: getMergeConflictAttemptsKey({ owner, repo: repoName, prNumber }),
    };
    const reservation = await reserveAttempt(redisClient, keys);
    if (reservation !== 'reserved') {
        return skip(log, context, reservation, { headSha: pr.head.sha, baseSha: pr.base.sha });
    }

    const jobData: MergeConflictJobData = {
        pullRequestNumber: prNumber,
        repoOwner: owner,
        repoName,
        headBranch: pr.head.ref,
        baseBranch: pr.base.ref,
        headSha: pr.head.sha,
        baseSha: pr.base.sha,
        triggerSource: trigger,
        correlationId: generateCorrelationId(),
        systemGenerated: true,
    };
    const jobId = `merge-conflict-${owner}-${repoName}-${prNumber}-${Date.now()}`;
    try {
        const queue = await getIssueQueue();
        await queue.add('processMergeConflict', jobData, { jobId });
    } catch (error) {
        await releaseAttempt(redisClient, keys).catch(releaseError => {
            log.warn({ ...context, error: (releaseError as Error).message }, 'Merge conflict auto-resolve: failed to release dedup key after enqueue failure');
        });
        log.error({ ...context, error: (error as Error).message }, 'Merge conflict auto-resolve: failed to enqueue resolution job');
        throw error;
    }

    log.info({
        ...context,
        outcome: 'queued',
        jobId,
        headBranch: pr.head.ref,
        baseBranch: pr.base.ref,
        headSha: pr.head.sha,
        baseSha: pr.base.sha,
        settingSource: setting.source,
    }, 'Merge conflict auto-resolve: enqueued conflict resolution job');
    return { outcome: 'queued', prNumber, repository, jobId };
}

function fanoutCursorKey(owner: string, repoName: string, baseBranch?: string): string {
    return `merge-conflict-fanout-cursor:${owner}/${repoName}:${baseBranch ?? '*'}`.toLowerCase();
}

/**
 * Lists one bounded page of open PRs. Successive fan-outs for the same
 * repository and base advance a stored page cursor and wrap to the first page
 * after the last, so every open PR is eventually evaluated even when there are
 * more than one page of them. Oldest-first ordering keeps pages stable as new
 * PRs are opened.
 */
async function listFanoutPage(
    octokit: Octokit,
    options: { owner: string; repoName: string; baseBranch?: string; redisClient: MergeConflictRedis },
    log: ReturnType<typeof logger.withCorrelation>
): Promise<Array<{ number: number }>> {
    const { owner, repoName, baseBranch, redisClient } = options;
    const cursorKey = fanoutCursorKey(owner, repoName, baseBranch);
    let page = 1;
    try {
        const stored = Number.parseInt(await redisClient.get(cursorKey) ?? '', 10);
        if (Number.isInteger(stored) && stored > 1) page = stored;
    } catch (error) {
        log.warn({ repository: `${owner}/${repoName}`, baseBranch, error: (error as Error).message }, 'Merge conflict auto-resolve: failed to read fan-out cursor; starting from the first page');
    }

    const listPage = async (pageNumber: number) => {
        const { data } = await octokit.request('GET /repos/{owner}/{repo}/pulls', {
            owner, repo: repoName, state: 'open', sort: 'created', direction: 'asc',
            per_page: MAX_PULL_REQUESTS_PER_FANOUT, page: pageNumber,
            ...(baseBranch ? { base: baseBranch } : {}),
        });
        return (data as Array<{ number: number }>).slice(0, MAX_PULL_REQUESTS_PER_FANOUT);
    };

    let prs = await listPage(page);
    if (prs.length === 0 && page > 1) {
        // The cursor ran past the end (PRs closed since); wrap within this fan-out.
        page = 1;
        prs = await listPage(page);
    }
    const nextPage = prs.length < MAX_PULL_REQUESTS_PER_FANOUT ? 1 : page + 1;
    try {
        await redisClient.set(cursorKey, String(nextPage), 'EX', FANOUT_CURSOR_TTL_SECONDS);
    } catch (error) {
        log.warn({ repository: `${owner}/${repoName}`, baseBranch, error: (error as Error).message }, 'Merge conflict auto-resolve: failed to advance fan-out cursor');
    }
    return prs;
}

/**
 * Evaluates one bounded page of open PRs targeting `baseBranch` (or every open
 * PR when omitted); repeated calls rotate through all pages. Every PR is read
 * once first so GitHub starts computing mergeability for all of them before any
 * one is polled.
 */
export async function evaluateOpenPullRequests(options: {
    owner: string;
    repoName: string;
    baseBranch?: string;
    trigger: ConflictTrigger;
    redisClient: MergeConflictRedis;
    correlationId: string;
    setting?: EffectiveAutoResolveMergeConflicts;
    deps?: MergeConflictDetectionDeps;
}): Promise<ConflictDetectionResult[]> {
    const { owner, repoName, baseBranch, trigger, redisClient, correlationId, deps } = options;
    const repository = `${owner}/${repoName}`;
    const log = logger.withCorrelation(correlationId);

    const setting = options.setting ?? await loadEffectiveAutoResolveMergeConflicts(repository);
    if (!setting.enabled) {
        log.info({ repository, baseBranch, trigger, reason: 'auto_resolve_disabled', source: setting.source }, 'Merge conflict auto-resolve skipped: auto_resolve_disabled');
        return [];
    }

    const octokit = await getAuthenticatedOctokit();
    const candidates = await listFanoutPage(octokit, { owner, repoName, baseBranch, redisClient }, log);
    log.info({ repository, baseBranch, trigger, prCount: candidates.length }, 'Merge conflict auto-resolve: evaluating open pull requests');

    const primed = new Map<number, ConflictPullRequest>();
    for (const candidate of candidates) {
        try {
            primed.set(candidate.number, await fetchPullRequest(octokit, owner, repoName, candidate.number));
        } catch (error) {
            log.warn({ repository, pullNumber: candidate.number, trigger, error: (error as Error).message }, 'Merge conflict auto-resolve: failed to prime mergeability');
        }
    }

    const results: ConflictDetectionResult[] = [];
    for (const candidate of candidates) {
        try {
            results.push(await maybeQueueConflictResolution({
                owner, repoName, prNumber: candidate.number, trigger, redisClient, correlationId,
                setting, octokit, deps, pullRequest: primed.get(candidate.number),
            }));
        } catch (error) {
            log.error({ repository, pullNumber: candidate.number, trigger, error: (error as Error).message }, 'Merge conflict auto-resolve: error evaluating pull request');
        }
    }
    return results;
}

/**
 * Safety net for missed or unsupported events (polling intake never sees push
 * events): evaluates open PRs of every enabled repository with the effective
 * setting on.
 */
export async function sweepConflictedPullRequests(options: {
    repositories: readonly string[];
    redisClient: MergeConflictRedis;
    correlationId?: string;
    deps?: MergeConflictDetectionDeps;
}): Promise<ConflictDetectionResult[]> {
    const correlationId = options.correlationId ?? generateCorrelationId();
    const log = logger.withCorrelation(correlationId);
    const [repos, instanceDefault] = await Promise.all([
        getConfig<RepoToMonitor[]>('repos_to_monitor', []),
        loadInstanceAutoResolveMergeConflicts(),
    ]);
    const results: ConflictDetectionResult[] = [];
    for (const repository of new Set(options.repositories.map(name => name.trim()).filter(Boolean))) {
        const [owner, repoName] = repository.split('/');
        if (!owner || !repoName) continue;
        const setting = resolveAutoResolveMergeConflicts({ repos: Array.isArray(repos) ? repos : [], repository, instanceDefault });
        if (!setting.enabled) {
            log.debug({ repository, trigger: 'sweep', reason: 'auto_resolve_disabled', source: setting.source }, 'Merge conflict sweep: repository disabled');
            continue;
        }
        try {
            results.push(...await evaluateOpenPullRequests({
                owner, repoName, trigger: 'sweep', redisClient: options.redisClient, correlationId, setting, deps: options.deps,
            }));
        } catch (error) {
            log.error({ repository, trigger: 'sweep', error: (error as Error).message }, 'Merge conflict sweep failed for repository');
        }
    }
    return results;
}

/** Sweep cadence: every 5 minutes in polling mode, every 15 minutes otherwise. */
export function getMergeConflictSweepIntervalMs(intakeMode: string, env: NodeJS.ProcessEnv = process.env): number {
    const configured = Number.parseInt(env.MERGE_CONFLICT_SWEEP_INTERVAL_MS ?? '', 10);
    if (Number.isFinite(configured) && configured > 0) return configured;
    return intakeMode === 'polling' ? 5 * 60 * 1000 : 15 * 60 * 1000;
}
