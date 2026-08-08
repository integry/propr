import type { UltrafixCommandMeta } from '@propr/core';
import type { Redis } from 'ioredis';

export type UltrafixDeferredAction = 'review' | 'fix';

export interface UltrafixDeferredContinuation {
    owner: string;
    repo: string;
    pr: number;
    nextAction: UltrafixDeferredAction;
    savedAt: string;
    reason: string;
    /** UltrafixMeta to pass to the next job when resuming. */
    ultrafixMeta?: UltrafixCommandMeta;
    /** Cancellation generation captured when this continuation was claimed. */
    generation?: number;
}

const DEFERRED_KEY_PREFIX = 'ultrafix:deferred';
const DEFERRED_GENERATION_KEY_PREFIX = 'ultrafix:deferred-generation';

export function getUltrafixDeferredKey(owner: string, repo: string, pr: number): string {
    return `${DEFERRED_KEY_PREFIX}:${owner}:${repo}:${pr}`;
}

export function getUltrafixDeferredGenerationKey(owner: string, repo: string, pr: number): string {
    return `${DEFERRED_GENERATION_KEY_PREFIX}:${owner}:${repo}:${pr}`;
}

const SAVE_DEFERRED_IF_CURRENT_SCRIPT = `
local current_generation = redis.call('GET', KEYS[1]) or '0'
if current_generation ~= ARGV[1] then
    return 0
end
redis.call('SET', KEYS[2], ARGV[2])
return 1
`;

const CLAIM_DEFERRED_SCRIPT = `
local deferred = redis.call('GET', KEYS[2])
if not deferred then
    return nil
end
local generation = redis.call('GET', KEYS[1]) or '0'
redis.call('DEL', KEYS[2])
return { deferred, generation }
`;

const CANCEL_DEFERRED_SCRIPT = `
redis.call('INCR', KEYS[1])
redis.call('DEL', KEYS[2])
return 1
`;

export async function saveDeferredContinuation(
    redis: Redis,
    deferred: UltrafixDeferredContinuation,
): Promise<boolean> {
    const key = getUltrafixDeferredKey(deferred.owner, deferred.repo, deferred.pr);
    const generationKey = getUltrafixDeferredGenerationKey(deferred.owner, deferred.repo, deferred.pr);
    const generation = deferred.generation
        ?? Number(await redis.get(generationKey) ?? '0');
    const persisted = { ...deferred };
    delete persisted.generation;
    const saved = await redis.eval(
        SAVE_DEFERRED_IF_CURRENT_SCRIPT,
        2,
        generationKey,
        key,
        String(generation),
        JSON.stringify(persisted),
    );
    return Number(saved) === 1;
}

export async function loadDeferredContinuation(
    redis: Redis,
    owner: string,
    repo: string,
    pr: number,
): Promise<UltrafixDeferredContinuation | null> {
    const key = getUltrafixDeferredKey(owner, repo, pr);
    const raw = await redis.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as UltrafixDeferredContinuation;
}

export async function claimDeferredContinuation(
    redis: Redis,
    owner: string,
    repo: string,
    pr: number,
): Promise<UltrafixDeferredContinuation | null> {
    const key = getUltrafixDeferredKey(owner, repo, pr);
    const generationKey = getUltrafixDeferredGenerationKey(owner, repo, pr);
    const claimed = await redis.eval(CLAIM_DEFERRED_SCRIPT, 2, generationKey, key);
    if (!Array.isArray(claimed) || claimed.length !== 2) return null;
    const deferred = JSON.parse(String(claimed[0])) as UltrafixDeferredContinuation;
    deferred.generation = Number(claimed[1]);
    return deferred;
}

export async function isDeferredContinuationCurrent(
    redis: Redis,
    deferred: UltrafixDeferredContinuation,
): Promise<boolean> {
    if (deferred.generation === undefined) return false;
    const generationKey = getUltrafixDeferredGenerationKey(deferred.owner, deferred.repo, deferred.pr);
    const currentGeneration = Number(await redis.get(generationKey) ?? '0');
    return currentGeneration === deferred.generation;
}

export async function clearDeferredContinuation(
    redis: Redis,
    owner: string,
    repo: string,
    pr: number,
): Promise<void> {
    const key = getUltrafixDeferredKey(owner, repo, pr);
    const generationKey = getUltrafixDeferredGenerationKey(owner, repo, pr);
    await redis.eval(CANCEL_DEFERRED_SCRIPT, 2, generationKey, key);
}

/** List deferred continuation keys without blocking a large Redis keyspace. */
export async function listDeferredContinuationKeys(redis: Redis): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
        const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', `${DEFERRED_KEY_PREFIX}:*`, 'COUNT', '100');
        cursor = nextCursor;
        keys.push(...batch);
    } while (cursor !== '0');
    return keys;
}

export function parseDeferredKey(key: string): { owner: string; repo: string; pr: number } | null {
    const prefix = `${DEFERRED_KEY_PREFIX}:`;
    if (!key.startsWith(prefix)) return null;
    const parts = key.slice(prefix.length).split(':');
    if (parts.length < 3) return null;
    const pr = parseInt(parts[parts.length - 1], 10);
    if (isNaN(pr)) return null;
    return { owner: parts[0], repo: parts[1], pr };
}
