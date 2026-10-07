import type { Redis } from 'ioredis';
import type { UltrafixCommandMeta } from '@propr/core';
import type { UltrafixAction } from './ultrafixOrchestrationService.js';
import {
    getUltrafixAutomaticWorkEpochKey,
    getUltrafixDeferredKey,
    saveDeferredContinuationIfCurrent,
    ULTRAFIX_DEFERRED_KEY_PREFIX,
} from './ultrafixAutomaticWorkEpoch.js';
import {
    getUltrafixRearmRetryKey,
    indexUltrafixResumeCandidate,
    pruneUltrafixResumeCandidate,
    REARM_RETRY_KEY_PREFIX,
} from './ultrafixResumeIndex.js';

export { getUltrafixRearmRetryKey };

export interface UltrafixDeferredContinuation {
    owner: string;
    repo: string;
    pr: number;
    nextAction: UltrafixAction;
    savedAt: string;
    reason: string;
    userId?: string;
    ultrafixMeta?: UltrafixCommandMeta;
    workEpoch?: number;
}

export async function saveDeferredContinuation(
    redis: Redis,
    deferred: UltrafixDeferredContinuation,
): Promise<boolean> {
    const expectedEpoch = deferred.workEpoch ?? deferred.ultrafixMeta?.workEpoch ?? 0;
    const identity = { owner: deferred.owner, repo: deferred.repo, pr: deferred.pr };
    const saved = await saveDeferredContinuationIfCurrent(redis, identity, expectedEpoch, JSON.stringify(deferred));
    if (saved) await indexUltrafixResumeCandidate(redis, identity);
    return saved;
}

export async function loadDeferredContinuation(
    redis: Redis,
    owner: string,
    repo: string,
    pr: number,
): Promise<UltrafixDeferredContinuation | null> {
    const raw = await redis.get(getUltrafixDeferredKey(owner, repo, pr));
    return raw ? JSON.parse(raw) as UltrafixDeferredContinuation : null;
}

export async function claimDeferredContinuation(
    redis: Redis,
    owner: string,
    repo: string,
    pr: number,
): Promise<UltrafixDeferredContinuation | null> {
    const raw = await redis.getdel(getUltrafixDeferredKey(owner, repo, pr));
    return raw ? JSON.parse(raw) as UltrafixDeferredContinuation : null;
}

// Compare-and-delete; the same shape as the resume-claim release script.
const DELETE_IF_EQUALS_SCRIPT = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";

/** The deferred record together with the exact serialized value it was parsed from. */
export interface UltrafixDeferredSnapshot {
    raw: string;
    deferred: UltrafixDeferredContinuation;
}

export async function loadDeferredContinuationSnapshot(
    redis: Redis,
    owner: string,
    repo: string,
    pr: number,
): Promise<UltrafixDeferredSnapshot | null> {
    const raw = await redis.get(getUltrafixDeferredKey(owner, repo, pr));
    return raw ? { raw, deferred: JSON.parse(raw) as UltrafixDeferredContinuation } : null;
}

/**
 * Claim (remove) the deferred record only while it is still exactly
 * `expectedRaw`, so the step a caller recorded before claiming is the step it
 * removed.
 */
export async function claimDeferredContinuationIfUnchanged(
    redis: Redis,
    identity: { owner: string; repo: string; pr: number },
    expectedRaw: string,
): Promise<boolean> {
    const claimed = await redis.eval(
        DELETE_IF_EQUALS_SCRIPT,
        1,
        getUltrafixDeferredKey(identity.owner, identity.repo, identity.pr),
        expectedRaw,
    );
    return Number(claimed) === 1;
}

export async function clearDeferredContinuation(
    redis: Redis,
    owner: string,
    repo: string,
    pr: number,
): Promise<void> {
    await redis.del(getUltrafixDeferredKey(owner, repo, pr));
}

export async function listDeferredContinuationKeys(redis: Redis): Promise<string[]> {
    return scanKeys(redis, `${ULTRAFIX_DEFERRED_KEY_PREFIX}:*`);
}

export function parseDeferredKey(key: string): { owner: string; repo: string; pr: number } | null {
    return parsePrKey(key, ULTRAFIX_DEFERRED_KEY_PREFIX);
}

// --- Stranded-loop retry obligations ---

/** Long enough to outlive any CI wait; a loop that is still stranded re-records it. */
export const REARM_RETRY_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * A durable request to re-examine a stranded loop whose recovery could not
 * finish (outstanding or unreadable work, failed enqueue, superseded record).
 * It only asks for another resume attempt; every action that attempt takes is
 * fenced by the loop's work epoch and state snapshot.
 */
export interface UltrafixRearmRetry {
    owner: string;
    repo: string;
    pr: number;
    /** Automatic-work epoch current when the obligation was recorded. */
    workEpoch: number;
    reason: string;
    savedAt: string;
    /** The sweep leaves the obligation alone until then (check events still run it). */
    notBefore?: string;
    /**
     * The deferred step a resume removed from Redis to run it. A process lost
     * before that attempt settled leaves this as the only copy of an
     * already-authorized step (e.g. a permitted final fix); recovery puts it
     * back while the loop is still at `stateDigest` under the step's epoch.
     */
    claimedStep?: UltrafixClaimedStep;
    /**
     * Bumped by every exhausted-step notification, so the obligation a resume
     * recorded for its handoff no longer matches once its step failed for
     * good, and settling that handoff cannot release it.
     */
    failureVersion?: number;
}

export interface UltrafixClaimedStep {
    deferred: UltrafixDeferredContinuation;
    /** SHA-256 of the serialized loop state the step was claimed against. */
    stateDigest: string;
}

export async function loadRearmRetry(redis: Redis, owner: string, repo: string, pr: number): Promise<UltrafixRearmRetry | null> {
    const raw = await loadRearmRetryRaw(redis, owner, repo, pr);
    return raw ? JSON.parse(raw) as UltrafixRearmRetry : null;
}

/** The obligation exactly as stored, for releasing that one obligation and no newer one. */
export async function loadRearmRetryRaw(redis: Redis, owner: string, repo: string, pr: number): Promise<string | null> {
    return redis.get(getUltrafixRearmRetryKey(owner, repo, pr));
}

// Marked so test doubles can tell them apart from the resume-claim scripts.
const CLEAR_REARM_RETRY_IF_CLAIM_HELD_SCRIPT = `
-- clear rearm retry if claim held
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
    return 0
end
if ARGV[2] ~= '' and (redis.call('GET', KEYS[3]) or '0') ~= ARGV[2] then
    return -1
end
if ARGV[4] == '1' and (redis.call('GET', KEYS[2]) or '') ~= ARGV[3] then
    return -2
end
redis.call('DEL', KEYS[2])
return 1
`;

const SAVE_REARM_RETRY_UNLESS_CLAIM_TAKEN_SCRIPT = `
-- save rearm retry unless claim taken
local holder = redis.call('GET', KEYS[1])
if holder and holder ~= ARGV[1] then
    return 0
end
if ARGV[5] == '1' and (redis.call('GET', KEYS[2]) or '') ~= ARGV[4] then
    return -2
end
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
return 1
`;

export type RearmRetryClearOutcome = 'cleared' | 'claim_not_held' | 'superseded' | 'retry_changed';
export type RearmRetrySaveOutcome = 'saved' | 'claim_taken' | 'retry_changed';

/**
 * An expected stored obligation: its exact serialized value, or `null` for
 * none at all. `undefined` places no condition on it.
 */
export type ExpectedRearmRetry = string | null | undefined;

/**
 * Release the retry obligation only while `claimToken` still holds the resume
 * claim at `claimKey`. A holder whose claim expired (and may have been taken
 * over) acts on stale evidence and must not erase its successor's obligation.
 *
 * With `workEpoch`, the release is also bound to the automatic-work epoch the
 * attempt handed the loop to (its queued step or deferred record): work
 * invalidated since then (e.g. a manual command) will be rejected or was
 * removed, so the obligation is kept for the sweep.
 *
 * With `raw`, only that exact obligation is released (`null`: only while
 * none is recorded): one recorded after the caller read or wrote it, such as
 * an exhausted-step notification, is newer evidence and survives.
 */
export async function clearRearmRetryIfClaimHeld(
    redis: Redis,
    identity: { owner: string; repo: string; pr: number },
    claim: { key: string; token: string },
    expected: { workEpoch?: number; raw?: ExpectedRearmRetry } = {},
): Promise<RearmRetryClearOutcome> {
    const { workEpoch, raw } = expected;
    const cleared = Number(await redis.eval(
        CLEAR_REARM_RETRY_IF_CLAIM_HELD_SCRIPT,
        3,
        claim.key,
        getUltrafixRearmRetryKey(identity.owner, identity.repo, identity.pr),
        getUltrafixAutomaticWorkEpochKey(identity.owner, identity.repo, identity.pr),
        claim.token,
        workEpoch === undefined ? '' : String(workEpoch),
        raw ?? '',
        raw === undefined ? '' : '1',
    ));
    if (cleared === 1) return 'cleared';
    if (cleared === -2) return 'retry_changed';
    return cleared === -1 ? 'superseded' : 'claim_not_held';
}

/**
 * Record the retry obligation unless another trigger holds the resume claim
 * at `claimKey`; that holder owns the obligation and may already have
 * recorded or released it. With `expectedRaw`, it replaces only that exact
 * obligation (`null`: only when none is recorded), so evidence recorded
 * meanwhile (a claimed step, an exhausted-step notification) is not lost.
 */
export async function saveRearmRetryUnlessClaimTaken(
    redis: Redis,
    retry: UltrafixRearmRetry,
    claim: { key: string; token: string },
    expectedRaw?: ExpectedRearmRetry,
): Promise<RearmRetrySaveOutcome> {
    const saved = Number(await redis.eval(
        SAVE_REARM_RETRY_UNLESS_CLAIM_TAKEN_SCRIPT,
        2,
        claim.key,
        getUltrafixRearmRetryKey(retry.owner, retry.repo, retry.pr),
        claim.token,
        JSON.stringify(retry),
        String(REARM_RETRY_TTL_SECONDS),
        expectedRaw ?? '',
        expectedRaw === undefined ? '' : '1',
    ));
    if (saved === -2) return 'retry_changed';
    if (saved !== 1) return 'claim_taken';
    await indexUltrafixResumeCandidate(redis, retry);
    return 'saved';
}

const COMMIT_STARTED_LOOP_STATE_SCRIPT = `
-- commit started loop state
if (redis.call('GET', KEYS[1]) or '0') ~= ARGV[1] then
    return 0
end
redis.call('SET', KEYS[2], ARGV[2])
redis.call('DEL', KEYS[3])
return 1
`;

/**
 * Commit a newly started loop's state while `workEpoch` is still current, and
 * drop any retry obligation left by the loop it replaces in the same step.
 * That obligation describes superseded work; left in place it would make the
 * new loop look stranded (a trigger could take it over before its initial
 * step is queued) and keep it a sweep candidate until it expired.
 */
export async function commitStartedLoopState(
    redis: Redis,
    identity: { owner: string; repo: string; pr: number },
    workEpoch: number,
    state: { key: string; serialized: string },
): Promise<boolean> {
    const { owner, repo, pr } = identity;
    const committed = await redis.eval(
        COMMIT_STARTED_LOOP_STATE_SCRIPT,
        3,
        getUltrafixAutomaticWorkEpochKey(owner, repo, pr),
        state.key,
        getUltrafixRearmRetryKey(owner, repo, pr),
        String(workEpoch),
        state.serialized,
    );
    if (Number(committed) !== 1) return false;
    // Only drops the index entry when no deferred record or obligation remains.
    await pruneUltrafixResumeCandidate(redis, identity);
    return true;
}

async function scanKeys(redis: Redis, pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
        const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', '100');
        cursor = nextCursor;
        keys.push(...batch);
    } while (cursor !== '0');
    return keys;
}

function parsePrKey(key: string, keyPrefix: string): { owner: string; repo: string; pr: number } | null {
    const prefix = `${keyPrefix}:`;
    if (!key.startsWith(prefix)) return null;
    const parts = key.slice(prefix.length).split(':');
    if (parts.length < 3) return null;
    const pr = parseInt(parts[parts.length - 1], 10);
    if (isNaN(pr)) return null;
    return { owner: parts[0], repo: parts.slice(1, -1).join(':'), pr };
}

export async function listRearmRetryKeys(redis: Redis): Promise<string[]> {
    return scanKeys(redis, `${REARM_RETRY_KEY_PREFIX}:*`);
}

export function parseRearmRetryKey(key: string): { owner: string; repo: string; pr: number } | null {
    return parsePrKey(key, REARM_RETRY_KEY_PREFIX);
}
