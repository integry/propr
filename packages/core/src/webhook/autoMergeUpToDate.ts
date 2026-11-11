/**
 * `auto_merge.require_up_to_date`: merge-queue-like behaviour for ProPR's own
 * auto-merge. A candidate that passed every other gate but whose head does not
 * contain the latest base commit is updated through GitHub's update-branch API
 * instead of merged; the check-run and sweep paths re-evaluate it once CI has
 * run on the updated head.
 *
 * Per repository only one PR is brought up to date at a time (the oldest
 * eligible one holds a turn until its updated head merges, fails CI or the
 * turn expires), and each PR gets at most `max_branch_updates_per_hour`
 * updates per hour, so a busy base branch cannot cause an update loop.
 *
 * Independently of the update turn, {@link mergeWhenUpToDate} serialises
 * ProPR's comparison-through-merge per repository, so two current heads cannot
 * both be found up to date against the same base and then merge together.
 */
import { randomUUID } from 'node:crypto';
import logger from '../utils/logger.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { getCheckRunsStatusForRepo, getUltrafixStateRedis } from './checkRunHelpers.js';
import { recordAutoMergeDecisionEvent } from '../services/autoMergeGate.js';
import { describeAutoMergeDecision, type AutoMergeDecision, type AutoMergeUpToDateReason } from '../workflow/autoMergePolicy.js';

type Log = Pick<typeof logger, 'info' | 'warn' | 'debug'>;

export interface UpToDateRedis {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, secondsToken: 'EX', seconds: number, nx?: 'NX'): Promise<unknown>;
    del(key: string): Promise<unknown>;
    expire(key: string, seconds: number): Promise<unknown>;
    zadd(key: string, score: number, member: string): Promise<unknown>;
    zrange(key: string, start: number, stop: number): Promise<string[]>;
    zrem(key: string, member: string): Promise<unknown>;
}

export interface UpToDateOctokit {
    request(route: string, params?: Record<string, unknown>): Promise<{ data: unknown }>;
}

export interface UpToDateDependencies {
    redis?: UpToDateRedis;
    octokit?: UpToDateOctokit;
    now?: () => number;
    recordDecision?: typeof recordAutoMergeDecisionEvent;
    /** Queue the opt-in automatic conflict resolution; `queued` is false when it is disabled or refused. */
    queueConflictResolution?: (input: { owner: string; repo: string; prNumber: number }) => Promise<{ queued: boolean; reason?: string }>;
    /** Whether blocking checks failed on a head; defaults to the repository-aware check summary. */
    checksFailed?: (owner: string, repo: string, ref: string) => Promise<boolean>;
}

export interface UpToDateTarget {
    owner: string;
    repo: string;
    prNumber: number;
    headSha: string;
    baseRef: string;
    log?: Log;
}

/** `up_to_date`: the head contains the latest base commit and may merge. Anything else: do not merge this head. */
export type UpToDateOutcome = 'up_to_date' | 'updated' | 'waiting';

const KEY_PREFIX = 'auto-merge:up-to-date';
const HOUR_MS = 60 * 60_000;
/** A requested update that has not produced a new head yet is not requested again for this long. */
export const BRANCH_UPDATE_PENDING_MS = 10 * 60_000;
/** How long the repository's update turn survives without being refreshed. */
export const UPDATE_TURN_TTL_SECONDS = 60 * 60;
/** How long a behind PR stays eligible for the turn without being re-evaluated. */
export const ELIGIBLE_TTL_SECONDS = 10 * 60;
/**
 * How long the repository's comparison-through-merge ownership survives when
 * its holder dies mid-operation; a live holder releases it when the merge
 * attempt finishes.
 */
export const MERGE_OWNERSHIP_TTL_SECONDS = 5 * 60;
const MARKER_TTL_SECONDS = 24 * 60 * 60;
const LAST_DECISION_TTL_SECONDS = 24 * 60 * 60;

interface BranchUpdateMarker {
    fromHead: string;
    baseSha?: string;
    requestedAt: number;
}

const repoKey = (owner: string, repo: string) => `${owner}/${repo}`.toLowerCase();
const keys = (owner: string, repo: string, prNumber?: number) => {
    const scope = repoKey(owner, repo);
    return {
        turn: `${KEY_PREFIX}:turn:${scope}`,
        merging: `${KEY_PREFIX}:merging:${scope}`,
        eligible: `${KEY_PREFIX}:eligible:${scope}`,
        seen: (pr: number | string) => `${KEY_PREFIX}:seen:${scope}#${pr}`,
        updates: `${KEY_PREFIX}:updates:${scope}#${prNumber}`,
        marker: `${KEY_PREFIX}:marker:${scope}#${prNumber}`,
        last: `${KEY_PREFIX}:last:${scope}#${prNumber}`,
    };
};

function defaultRedis(deps: UpToDateDependencies): UpToDateRedis {
    return deps.redis ?? (getUltrafixStateRedis() as unknown as UpToDateRedis);
}

async function defaultOctokit(deps: UpToDateDependencies): Promise<UpToDateOctokit> {
    return deps.octokit ?? (await getAuthenticatedOctokit() as unknown as UpToDateOctokit);
}

async function defaultQueueConflictResolution(input: { owner: string; repo: string; prNumber: number }): Promise<{ queued: boolean; reason?: string }> {
    // Loaded lazily: the detector pulls in queue and settings modules the merge path does not otherwise need.
    const { maybeQueueConflictResolution } = await import('./mergeConflictAutoResolve.js');
    const result = await maybeQueueConflictResolution({
        owner: input.owner, repoName: input.repo, prNumber: input.prNumber, trigger: 'auto_merge',
        redisClient: getUltrafixStateRedis() as never, correlationId: randomUUID(),
    });
    // A resolution already queued for this conflict state is as good as a new one.
    return { queued: result.outcome === 'queued' || result.reason === 'already_queued', reason: result.reason };
}

async function defaultChecksFailed(owner: string, repo: string, ref: string): Promise<boolean> {
    return (await getCheckRunsStatusForRepo(owner, repo, ref)).anyFailed;
}

function parseJson<T>(raw: string | null): T | null {
    if (!raw) return null;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

async function readMarker(redis: UpToDateRedis, key: string): Promise<BranchUpdateMarker | null> {
    const marker = parseJson<BranchUpdateMarker>(await redis.get(key));
    return marker && typeof marker.fromHead === 'string' && Number.isFinite(marker.requestedAt) ? marker : null;
}

async function recentUpdates(redis: UpToDateRedis, key: string, now: number): Promise<number[]> {
    const stored = parseJson<unknown>(await redis.get(key));
    return Array.isArray(stored) ? stored.filter((at): at is number => typeof at === 'number' && now - at < HOUR_MS && at <= now) : [];
}

async function countUpdate(redis: UpToDateRedis, key: string, now: number): Promise<void> {
    const updates = [...await recentUpdates(redis, key, now), now];
    await redis.set(key, JSON.stringify(updates), 'EX', HOUR_MS / 1000);
}

/** Give up the repository turn if this PR holds it, and leave the eligible set. */
async function leaveTurn(redis: UpToDateRedis, target: UpToDateTarget): Promise<void> {
    const k = keys(target.owner, target.repo, target.prNumber);
    if (await redis.get(k.turn) === String(target.prNumber)) await redis.del(k.turn);
    await redis.zrem(k.eligible, String(target.prNumber));
    await redis.del(k.seen(target.prNumber));
}

/** The oldest (lowest-numbered) PR that was recently found eligible for an update. */
async function oldestEligible(redis: UpToDateRedis, owner: string, repo: string): Promise<number | null> {
    const k = keys(owner, repo);
    for (const member of await redis.zrange(k.eligible, 0, -1)) {
        if (await redis.get(k.seen(member))) return Number(member);
        await redis.zrem(k.eligible, member);
    }
    return null;
}

async function isPullRequestOpen(octokit: UpToDateOctokit, owner: string, repo: string, prNumber: number): Promise<boolean> {
    try {
        const { data } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', { owner, repo, pull_number: prNumber });
        return (data as { state?: string }).state === 'open';
    } catch {
        // Unknown: keep the turn rather than let two updates race.
        return true;
    }
}

interface DecisionOptions {
    action: 'branch_updated' | 'waiting';
    detail?: string;
    baseSha?: string;
    comment?: boolean;
}

/**
 * Record a `require_up_to_date` decision with the auto-merge decision event.
 * The check-run and sweep paths re-evaluate a waiting PR often, so a decision
 * repeated for the same head and base is recorded (and commented) only once.
 */
async function recordDecision(
    target: Omit<UpToDateTarget, 'baseRef'> & { baseRef?: string },
    reason: AutoMergeUpToDateReason,
    options: DecisionOptions,
    deps: UpToDateDependencies,
): Promise<void> {
    const { owner, repo, prNumber, headSha } = target;
    const log = target.log ?? logger;
    const redis = defaultRedis(deps);
    const lastKey = keys(owner, repo, prNumber).last;
    const fingerprint = `${reason}:${headSha}:${options.baseSha ?? ''}:${options.detail ?? ''}`;
    if (await redis.get(lastKey) === fingerprint) return;
    await redis.set(lastKey, fingerprint, 'EX', LAST_DECISION_TTL_SECONDS);
    const decision: AutoMergeDecision = { arm: false, reason, opportunity: 'check_merge', ...(options.detail ? { detail: options.detail } : {}) };
    log.info({ owner, repo, prNumber, headSha, reason, detail: options.detail }, 'Auto-merge up-to-date decision');
    await (deps.recordDecision ?? recordAutoMergeDecisionEvent)({
        repository: `${owner}/${repo}`, prNumber, opportunity: 'check_merge', decision, action: options.action,
        headSha, ...(target.baseRef ? { baseRef: target.baseRef } : {}), ...(options.baseSha ? { baseSha: options.baseSha } : {}),
    }, {}, log);
    if (!options.comment) return;
    const body = describeAutoMergeDecision(decision)
        .replace('**Auto-merge not armed**', '**Auto-merge waiting**')
        .replace(/The `auto-merge` label stays in place.*$/,
            `\`auto_merge.require_up_to_date\` is enabled, so ProPR merges only a head that contains the latest \`${target.baseRef ?? 'base'}\` commit. `
            + 'Resolve the conflicts (or enable automatic merge-conflict resolution); auto-merge continues once CI passes on the updated head.');
    try {
        await (await defaultOctokit(deps)).request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', { owner, repo, issue_number: prNumber, body });
    } catch (error) {
        log.warn({ owner, repo, prNumber, error: (error as Error).message }, 'Failed to post auto-merge waiting comment');
    }
}

async function compareWithBase(octokit: UpToDateOctokit, target: UpToDateTarget): Promise<{ behindBy: number; baseSha?: string }> {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/compare/{basehead}', {
        owner: target.owner, repo: target.repo, basehead: `${target.baseRef}...${target.headSha}`,
    });
    const comparison = data as { behind_by?: unknown; base_commit?: { sha?: unknown } };
    if (typeof comparison.behind_by !== 'number' || !Number.isInteger(comparison.behind_by) || comparison.behind_by < 0) {
        throw new Error('comparison did not report behind_by');
    }
    return { behindBy: comparison.behind_by, ...(typeof comparison.base_commit?.sha === 'string' ? { baseSha: comparison.base_commit.sha } : {}) };
}

/** Whether this PR may take (or already holds) the repository's update turn; returns the PR it waits for otherwise. */
async function claimTurn(
    redis: UpToDateRedis, octokit: UpToDateOctokit, target: UpToDateTarget,
): Promise<{ claimed: true } | { claimed: false; waitingFor: string }> {
    const k = keys(target.owner, target.repo, target.prNumber);
    const me = String(target.prNumber);
    const holder = await redis.get(k.turn);
    if (holder === me) {
        await redis.expire(k.turn, UPDATE_TURN_TTL_SECONDS);
        return { claimed: true };
    }
    if (holder) {
        if (await isPullRequestOpen(octokit, target.owner, target.repo, Number(holder))) return { claimed: false, waitingFor: `PR #${holder}` };
        // The holder was merged or closed outside ProPR; its turn is over.
        if (await redis.get(k.turn) === holder) await redis.del(k.turn);
        await redis.zrem(k.eligible, holder);
        await redis.del(k.seen(holder));
    }
    const oldest = await oldestEligible(redis, target.owner, target.repo);
    if (oldest !== null && oldest !== target.prNumber) return { claimed: false, waitingFor: `PR #${oldest} (older)` };
    const acquired = await redis.set(k.turn, me, 'EX', UPDATE_TURN_TTL_SECONDS, 'NX');
    if (!acquired) return { claimed: false, waitingFor: `PR #${await redis.get(k.turn) ?? '?'}` };
    // The holder is no longer waiting for a turn.
    await redis.zrem(k.eligible, me);
    return { claimed: true };
}

async function handleUpdateFailure(
    error: unknown, target: UpToDateTarget, baseSha: string | undefined, deps: UpToDateDependencies,
): Promise<UpToDateOutcome> {
    const log = target.log ?? logger;
    const redis = defaultRedis(deps);
    const err = error as { status?: number; message?: string; response?: { data?: { message?: string } } };
    const message = err.response?.data?.message || err.message || 'unknown error';
    await leaveTurn(redis, target);
    if (err.status === 422 && /expected head sha|head ref/i.test(message)) {
        // The head moved; its own CI and the sweep re-evaluate the new head.
        log.info({ owner: target.owner, repo: target.repo, prNumber: target.prNumber, error: message }, 'PR head moved before the branch update; skipping');
        return 'waiting';
    }
    if (err.status === 422 && /conflict/i.test(message)) {
        let resolution: { queued: boolean; reason?: string } = { queued: false };
        try {
            resolution = await (deps.queueConflictResolution ?? defaultQueueConflictResolution)(target);
        } catch (queueError) {
            log.warn({ owner: target.owner, repo: target.repo, prNumber: target.prNumber, error: (queueError as Error).message }, 'Failed to queue conflict resolution for a behind PR');
        }
        const detail = resolution.queued
            ? 'automatic merge-conflict resolution was queued'
            : `automatic merge-conflict resolution did not start${resolution.reason ? ` (${resolution.reason})` : ''}`;
        await recordDecision(target, 'waiting_branch_update_conflict', { action: 'waiting', detail, baseSha, comment: !resolution.queued }, deps);
        return 'waiting';
    }
    await recordDecision(target, 'waiting_branch_update_failed', { action: 'waiting', detail: message, baseSha }, deps);
    return 'waiting';
}

/**
 * Called when an auto-merge candidate passed every other gate and the policy
 * requires an up-to-date branch. Only `up_to_date` allows merging this head.
 * The comparison is only as fresh as the base it saw: callers that go on to
 * merge must hold the repository's merge ownership, as {@link mergeWhenUpToDate} does.
 */
export async function ensureUpToDateBeforeMerge(
    target: UpToDateTarget,
    settings: { maxBranchUpdatesPerHour: number },
    deps: UpToDateDependencies = {},
): Promise<UpToDateOutcome> {
    const { owner, repo, prNumber, headSha } = target;
    const redis = defaultRedis(deps);
    const octokit = await defaultOctokit(deps);
    const now = (deps.now ?? Date.now)();
    const k = keys(owner, repo, prNumber);

    let comparison: { behindBy: number; baseSha?: string };
    try {
        comparison = await compareWithBase(octokit, target);
    } catch (error) {
        await recordDecision(target, 'waiting_base_comparison_unavailable', { action: 'waiting', detail: (error as Error).message }, deps);
        return 'waiting';
    }
    const { baseSha } = comparison;
    if (comparison.behindBy === 0) {
        await leaveTurn(redis, target);
        await redis.del(k.marker);
        return 'up_to_date';
    }

    const marker = await readMarker(redis, k.marker);
    if (marker && marker.fromHead === headSha && now - marker.requestedAt < BRANCH_UPDATE_PENDING_MS) {
        await recordDecision(target, 'waiting_branch_update_pending', { action: 'waiting', baseSha: marker.baseSha }, deps);
        return 'waiting';
    }

    // A rate-limited PR is not eligible, so it cannot hold up younger PRs.
    if ((await recentUpdates(redis, k.updates, now)).length >= settings.maxBranchUpdatesPerHour) {
        await leaveTurn(redis, target);
        await recordDecision(target, 'waiting_branch_update_rate_limited', {
            action: 'waiting', baseSha, detail: `at most ${settings.maxBranchUpdatesPerHour} branch update(s) per hour`,
        }, deps);
        return 'waiting';
    }

    await redis.zadd(k.eligible, prNumber, String(prNumber));
    await redis.set(k.seen(prNumber), String(now), 'EX', ELIGIBLE_TTL_SECONDS);
    const turn = await claimTurn(redis, octokit, target);
    if (!turn.claimed) {
        await recordDecision(target, 'waiting_branch_update_serialized', { action: 'waiting', baseSha, detail: `waiting for ${turn.waitingFor}` }, deps);
        return 'waiting';
    }

    try {
        await octokit.request('PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch', {
            owner, repo, pull_number: prNumber, expected_head_sha: headSha,
        });
    } catch (error) {
        await countUpdate(redis, k.updates, now);
        return handleUpdateFailure(error, target, baseSha, deps);
    }
    await countUpdate(redis, k.updates, now);
    await redis.set(k.marker, JSON.stringify({ fromHead: headSha, baseSha, requestedAt: now } satisfies BranchUpdateMarker), 'EX', MARKER_TTL_SECONDS);
    await recordDecision(target, 'updated_branch', {
        action: 'branch_updated', baseSha, detail: `head was ${comparison.behindBy} commit(s) behind ${target.baseRef}`,
    }, deps);
    return 'updated';
}

/**
 * Compare the head with the latest base and, when it is current, run `merge`,
 * all while holding the repository's merge ownership: another ProPR candidate
 * in this repository can neither compare nor merge until this merge attempt
 * finished, so it compares against the base this merge produced. A candidate
 * that finds the ownership taken waits for the next check event or sweep.
 * Returns `up_to_date` only when `merge` ran.
 */
export async function mergeWhenUpToDate(
    target: UpToDateTarget,
    settings: { maxBranchUpdatesPerHour: number },
    merge: () => Promise<void>,
    deps: UpToDateDependencies = {},
): Promise<UpToDateOutcome> {
    const redis = defaultRedis(deps);
    const k = keys(target.owner, target.repo, target.prNumber);
    const token = `${target.prNumber}:${randomUUID()}`;
    if (!await redis.set(k.merging, token, 'EX', MERGE_OWNERSHIP_TTL_SECONDS, 'NX')) {
        const holder = (await redis.get(k.merging))?.split(':')[0];
        (target.log ?? logger).debug({ owner: target.owner, repo: target.repo, prNumber: target.prNumber, holder },
            'Another auto-merge in this repository is comparing or merging; waiting');
        await recordDecision(target, 'waiting_branch_update_serialized', {
            action: 'waiting', detail: `waiting for the auto-merge of ${holder ? `PR #${holder}` : 'another PR'} to finish`,
        }, deps);
        return 'waiting';
    }
    try {
        const outcome = await ensureUpToDateBeforeMerge(target, settings, deps);
        if (outcome === 'up_to_date') await merge();
        return outcome;
    } finally {
        // Only our own ownership is released; an expired one may have been taken over.
        try {
            if (await redis.get(k.merging) === token) await redis.del(k.merging);
        } catch (error) {
            (target.log ?? logger).warn({ owner: target.owner, repo: target.repo, prNumber: target.prNumber, error: (error as Error).message },
                'Failed to release auto-merge ownership; it expires on its own');
        }
    }
}

/**
 * Called when CI does not allow merging yet. For a PR whose branch ProPR
 * updated, records that it waits for CI on the updated head and keeps its turn;
 * failed blocking checks end the turn so the next PR can be updated.
 */
export async function noteCiWaitAfterBranchUpdate(
    target: Omit<UpToDateTarget, 'baseRef'>,
    deps: UpToDateDependencies = {},
): Promise<void> {
    const log = target.log ?? logger;
    try {
        const redis = defaultRedis(deps);
        const k = keys(target.owner, target.repo, target.prNumber);
        const marker = await readMarker(redis, k.marker);
        // No update, or the update has not produced a new head yet.
        if (!marker || marker.fromHead === target.headSha) return;
        if (await (deps.checksFailed ?? defaultChecksFailed)(target.owner, target.repo, target.headSha)) {
            await leaveTurn(redis, { ...target, baseRef: '' });
            await redis.del(k.marker);
            await recordDecision(target, 'waiting_for_ci_updated_head', {
                action: 'waiting', baseSha: marker.baseSha, detail: 'blocking checks failed on the updated head',
            }, deps);
            return;
        }
        if (await redis.get(k.turn) === String(target.prNumber)) await redis.expire(k.turn, UPDATE_TURN_TTL_SECONDS);
        await recordDecision(target, 'waiting_for_ci_updated_head', { action: 'waiting', baseSha: marker.baseSha }, deps);
    } catch (error) {
        log.warn({ owner: target.owner, repo: target.repo, prNumber: target.prNumber, error: (error as Error).message }, 'Failed to note CI wait after a branch update');
    }
}
