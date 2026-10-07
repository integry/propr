import type { Redis } from 'ioredis';
import type { UltrafixCommandMeta } from '@propr/core';
import type { UltrafixAction } from './ultrafixOrchestrationService.js';
import {
    getUltrafixAutomaticWorkEpochKey,
    getUltrafixDeferredKey,
    saveDeferredContinuationIfCurrent,
    ULTRAFIX_DEFERRED_KEY_PREFIX,
} from './ultrafixAutomaticWorkEpoch.js';
import { getUltrafixRearmRetryKey, indexUltrafixResumeCandidate, REARM_RETRY_KEY_PREFIX } from './ultrafixResumeIndex.js';

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
const REARM_RETRY_TTL_SECONDS = 7 * 24 * 60 * 60;

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
}

export interface UltrafixClaimedStep {
    deferred: UltrafixDeferredContinuation;
    /** SHA-256 of the serialized loop state the step was claimed against. */
    stateDigest: string;
}

export async function saveRearmRetry(redis: Redis, retry: UltrafixRearmRetry): Promise<void> {
    await redis.set(getUltrafixRearmRetryKey(retry.owner, retry.repo, retry.pr), JSON.stringify(retry), 'EX', REARM_RETRY_TTL_SECONDS);
    await indexUltrafixResumeCandidate(redis, retry);
}

/**
 * Record the obligation only when none is recorded yet: an existing one
 * already makes the loop a candidate, and may carry evidence (e.g. a claimed
 * step) this caller knows nothing about.
 */
export async function saveRearmRetryIfAbsent(redis: Redis, retry: UltrafixRearmRetry): Promise<boolean> {
    const saved = await redis.set(getUltrafixRearmRetryKey(retry.owner, retry.repo, retry.pr), JSON.stringify(retry), 'EX', REARM_RETRY_TTL_SECONDS, 'NX');
    if (saved !== 'OK') return false;
    await indexUltrafixResumeCandidate(redis, retry);
    return true;
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
if ARGV[3] ~= '' and redis.call('GET', KEYS[2]) ~= ARGV[3] then
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
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
return 1
`;

export type RearmRetryClearOutcome = 'cleared' | 'claim_not_held' | 'superseded' | 'retry_changed';

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
 * With `expectedRaw`, only that exact obligation is released: one recorded
 * after the caller read it is newer evidence and survives.
 */
export async function clearRearmRetryIfClaimHeld(
    redis: Redis,
    identity: { owner: string; repo: string; pr: number },
    claim: { key: string; token: string },
    expected: { workEpoch?: number; raw?: string } = {},
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
    ));
    if (cleared === 1) return 'cleared';
    if (cleared === -2) return 'retry_changed';
    return cleared === -1 ? 'superseded' : 'claim_not_held';
}

/**
 * Record the retry obligation unless another trigger holds the resume claim
 * at `claimKey`; that holder owns the obligation and may already have
 * recorded or released it.
 */
export async function saveRearmRetryUnlessClaimTaken(
    redis: Redis,
    retry: UltrafixRearmRetry,
    claim: { key: string; token: string },
): Promise<boolean> {
    const saved = await redis.eval(
        SAVE_REARM_RETRY_UNLESS_CLAIM_TAKEN_SCRIPT,
        2,
        claim.key,
        getUltrafixRearmRetryKey(retry.owner, retry.repo, retry.pr),
        claim.token,
        JSON.stringify(retry),
        String(REARM_RETRY_TTL_SECONDS),
    );
    if (Number(saved) !== 1) return false;
    await indexUltrafixResumeCandidate(redis, retry);
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
