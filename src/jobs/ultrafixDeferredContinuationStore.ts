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

export type UltrafixIdentity = Pick<UltrafixDeferredContinuation, 'owner' | 'repo' | 'pr'>;

export interface ManualUltrafixTakeoverRecovery {
    stageKey: string;
    intentKey: string;
    serializedComment: string;
    ttlSeconds: number;
}

const DEFERRED_KEY_PREFIX = 'ultrafix:deferred';
const DEFERRED_GENERATION_KEY_PREFIX = 'ultrafix:deferred-generation';
const GENERATION_ALLOCATION_KEY_PREFIX = 'ultrafix:generation-allocation';
const TRANSITION_ORDER_KEY_PREFIX = 'ultrafix:transition-order';
const TAKEOVER_FENCE_KEY_PREFIX = 'ultrafix:takeover-fence';
const FRESH_RESERVATION_KEY_PREFIX = 'ultrafix:fresh-reservation';
const TAKEOVER_FENCE_TTL_SECONDS = 86400;

export function getUltrafixDeferredKey(owner: string, repo: string, pr: number): string {
    return `${DEFERRED_KEY_PREFIX}:${owner}:${repo}:${pr}`;
}

export function getUltrafixDeferredGenerationKey(owner: string, repo: string, pr: number): string {
    return `${DEFERRED_GENERATION_KEY_PREFIX}:${owner}:${repo}:${pr}`;
}

export function getUltrafixGenerationAllocationKey(owner: string, repo: string, pr: number): string {
    return `${GENERATION_ALLOCATION_KEY_PREFIX}:${owner}:${repo}:${pr}`;
}

export function getUltrafixTransitionOrderKey(owner: string, repo: string, pr: number): string {
    return `${TRANSITION_ORDER_KEY_PREFIX}:${owner}:${repo}:${pr}`;
}

export function getUltrafixTakeoverFenceKey(owner: string, repo: string, pr: number): string {
    return `${TAKEOVER_FENCE_KEY_PREFIX}:${owner}:${repo}:${pr}`;
}

export function getUltrafixFreshReservationKey(owner: string, repo: string, pr: number): string {
    return `${FRESH_RESERVATION_KEY_PREFIX}:${owner}:${repo}:${pr}`;
}

const BEGIN_MANUAL_TAKEOVER_SCRIPT = `
local function stage_recovery()
    if #KEYS < 4 then
        return
    end
    if redis.call('GET', KEYS[3]) ~= ARGV[1] then
        redis.call('SET', KEYS[3], ARGV[1], 'EX', ARGV[2])
    else
        redis.call('EXPIRE', KEYS[3], ARGV[2])
    end
    redis.call('SET', KEYS[4], ARGV[3], 'EX', ARGV[2])
end
local applied = tonumber(redis.call('GET', KEYS[1]) or '0')
local fenced = tonumber(redis.call('GET', KEYS[2]) or '0')
local incoming = tonumber(ARGV[1])
if incoming <= applied or incoming < fenced then
    return 0
end
if incoming == fenced then
    redis.call('EXPIRE', KEYS[2], ARGV[2])
    stage_recovery()
    return 1
end
redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[2])
stage_recovery()
return 1
`;

const ABORT_MANUAL_TAKEOVER_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
    return 0
end
redis.call('DEL', KEYS[1])
return 1
`;

const COMPLETE_MANUAL_TAKEOVER_SCRIPT = `
if redis.call('GET', KEYS[2]) ~= ARGV[1] then
    return nil
end
local applied = tonumber(redis.call('GET', KEYS[1]) or '0')
local incoming = tonumber(ARGV[1])
if incoming <= applied then
    redis.call('DEL', KEYS[2])
    return nil
end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('DEL', KEYS[2])
local current_generation = tonumber(redis.call('GET', KEYS[3]) or '0')
local allocated_generation = tonumber(redis.call('GET', KEYS[5]) or tostring(current_generation))
if allocated_generation < current_generation then
    allocated_generation = current_generation
end
local generation = allocated_generation + 1
redis.call('SET', KEYS[5], generation)
redis.call('SET', KEYS[3], generation)
redis.call('DEL', KEYS[4])
redis.call('DEL', KEYS[6])
return generation
`;


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
local current_generation = tonumber(redis.call('GET', KEYS[1]) or '0')
local allocated_generation = tonumber(redis.call('GET', KEYS[3]) or tostring(current_generation))
if allocated_generation < current_generation then
    allocated_generation = current_generation
end
local generation = allocated_generation + 1
redis.call('SET', KEYS[3], generation)
redis.call('SET', KEYS[1], generation)
redis.call('DEL', KEYS[2])
return generation
`;

const DELETE_DEFERRED_IF_CURRENT_SCRIPT = `
local current_generation = redis.call('GET', KEYS[1]) or '0'
if current_generation ~= ARGV[1] then
    return 0
end
redis.call('DEL', KEYS[2])
return 1
`;

export async function saveDeferredContinuation(
    redis: Redis,
    deferred: UltrafixDeferredContinuation,
): Promise<boolean> {
    if (deferred.generation === undefined) return false;
    const key = getUltrafixDeferredKey(deferred.owner, deferred.repo, deferred.pr);
    const generationKey = getUltrafixDeferredGenerationKey(deferred.owner, deferred.repo, deferred.pr);
    const saved = await redis.eval(
        SAVE_DEFERRED_IF_CURRENT_SCRIPT,
        2,
        generationKey,
        key,
        String(deferred.generation),
        JSON.stringify(deferred),
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
    return isUltrafixGenerationCurrent(redis, deferred, deferred.generation);
}

export async function getUltrafixGeneration(
    redis: Redis,
    identity: UltrafixIdentity,
): Promise<number> {
    const generationKey = getUltrafixDeferredGenerationKey(identity.owner, identity.repo, identity.pr);
    return Number(await redis.get(generationKey) ?? '0');
}

export async function getActiveUltrafixTakeoverSequence(
    redis: Redis,
    identity: UltrafixIdentity,
): Promise<number | null> {
    const key = getUltrafixTakeoverFenceKey(identity.owner, identity.repo, identity.pr);
    const value = await redis.get(key);
    return value === null ? null : Number(value);
}

/** Establish a sequence-valued fence before a manual replacement is scheduled. */
export async function beginManualUltrafixTakeover(
    redis: Redis,
    identity: UltrafixIdentity,
    commandSequence: number,
    recovery?: ManualUltrafixTakeoverRecovery,
): Promise<boolean> {
    const orderKey = getUltrafixTransitionOrderKey(identity.owner, identity.repo, identity.pr);
    const fenceKey = getUltrafixTakeoverFenceKey(identity.owner, identity.repo, identity.pr);
    const keys = recovery
        ? [orderKey, fenceKey, recovery.stageKey, recovery.intentKey]
        : [orderKey, fenceKey];
    return Number(await redis.eval(
        BEGIN_MANUAL_TAKEOVER_SCRIPT,
        keys.length,
        ...keys,
        String(commandSequence),
        String(recovery?.ttlSeconds ?? TAKEOVER_FENCE_TTL_SECONDS),
        recovery?.serializedComment ?? '',
    )) === 1;
}

/** Remove an uncommitted fence only when it still belongs to this command. */
export async function abortManualUltrafixTakeover(
    redis: Redis,
    identity: UltrafixIdentity,
    commandSequence: number,
): Promise<boolean> {
    const fenceKey = getUltrafixTakeoverFenceKey(identity.owner, identity.repo, identity.pr);
    return Number(await redis.eval(
        ABORT_MANUAL_TAKEOVER_SCRIPT,
        1,
        fenceKey,
        String(commandSequence),
    )) === 1;
}

/** Commit the newest manual takeover and invalidate its predecessor atomically. */
export async function completeManualUltrafixTakeover(
    redis: Redis,
    identity: UltrafixIdentity,
    commandSequence: number,
): Promise<number | null> {
    const orderKey = getUltrafixTransitionOrderKey(identity.owner, identity.repo, identity.pr);
    const fenceKey = getUltrafixTakeoverFenceKey(identity.owner, identity.repo, identity.pr);
    const generationKey = getUltrafixDeferredGenerationKey(identity.owner, identity.repo, identity.pr);
    const deferredKey = getUltrafixDeferredKey(identity.owner, identity.repo, identity.pr);
    const allocationKey = getUltrafixGenerationAllocationKey(identity.owner, identity.repo, identity.pr);
    const reservationKey = getUltrafixFreshReservationKey(identity.owner, identity.repo, identity.pr);
    const result = await redis.eval(
        COMPLETE_MANUAL_TAKEOVER_SCRIPT,
        6,
        orderKey,
        fenceKey,
        generationKey,
        deferredKey,
        allocationKey,
        reservationKey,
        String(commandSequence),
    );
    return result === null ? null : Number(result);
}

export async function isUltrafixGenerationCurrent(
    redis: Redis,
    identity: UltrafixIdentity,
    generation: number | undefined,
): Promise<boolean> {
    if (generation === undefined) return false;
    return await getUltrafixGeneration(redis, identity) === generation;
}

export async function clearDeferredContinuation(
    redis: Redis,
    owner: string,
    repo: string,
    pr: number,
): Promise<number> {
    const key = getUltrafixDeferredKey(owner, repo, pr);
    const generationKey = getUltrafixDeferredGenerationKey(owner, repo, pr);
    const allocationKey = getUltrafixGenerationAllocationKey(owner, repo, pr);
    return Number(await redis.eval(CANCEL_DEFERRED_SCRIPT, 3, generationKey, key, allocationKey));
}

export async function deleteDeferredContinuationIfCurrent(
    redis: Redis,
    identity: UltrafixIdentity,
    generation: number,
): Promise<boolean> {
    const key = getUltrafixDeferredKey(identity.owner, identity.repo, identity.pr);
    const generationKey = getUltrafixDeferredGenerationKey(identity.owner, identity.repo, identity.pr);
    return Number(await redis.eval(
        DELETE_DEFERRED_IF_CURRENT_SCRIPT,
        2,
        generationKey,
        key,
        String(generation),
    )) === 1;
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
