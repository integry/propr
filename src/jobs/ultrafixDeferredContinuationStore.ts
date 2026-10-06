import type { Redis } from 'ioredis';
import type { UltrafixCommandMeta } from '@propr/core';
import type { UltrafixAction } from './ultrafixOrchestrationService.js';
import {
    getUltrafixDeferredKey,
    saveDeferredContinuationIfCurrent,
    ULTRAFIX_DEFERRED_KEY_PREFIX,
} from './ultrafixAutomaticWorkEpoch.js';

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
    return saveDeferredContinuationIfCurrent(
        redis,
        { owner: deferred.owner, repo: deferred.repo, pr: deferred.pr },
        expectedEpoch,
        JSON.stringify(deferred),
    );
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

const REARM_RETRY_KEY_PREFIX = 'ultrafix:rearm-retry';
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
}

export function getUltrafixRearmRetryKey(owner: string, repo: string, pr: number): string {
    return `${REARM_RETRY_KEY_PREFIX}:${owner}:${repo}:${pr}`;
}

export async function saveRearmRetry(redis: Redis, retry: UltrafixRearmRetry): Promise<void> {
    await redis.set(getUltrafixRearmRetryKey(retry.owner, retry.repo, retry.pr), JSON.stringify(retry), 'EX', REARM_RETRY_TTL_SECONDS);
}

export async function loadRearmRetry(redis: Redis, owner: string, repo: string, pr: number): Promise<UltrafixRearmRetry | null> {
    const raw = await redis.get(getUltrafixRearmRetryKey(owner, repo, pr));
    return raw ? JSON.parse(raw) as UltrafixRearmRetry : null;
}

export async function clearRearmRetry(redis: Redis, owner: string, repo: string, pr: number): Promise<void> {
    await redis.del(getUltrafixRearmRetryKey(owner, repo, pr));
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
