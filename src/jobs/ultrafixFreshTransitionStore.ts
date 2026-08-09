import type { Redis } from 'ioredis';
import {
    getUltrafixDeferredGenerationKey,
    getUltrafixDeferredKey,
    getUltrafixFreshReservationKey,
    getUltrafixGenerationAllocationKey,
    getUltrafixTakeoverFenceKey,
    getUltrafixTransitionOrderKey,
    type UltrafixIdentity,
} from './ultrafixDeferredContinuationStore.js';

const RESERVATION_TTL_SECONDS = 86400;

const RESERVE_FRESH_ULTRAFIX_SCRIPT = `
local applied = tonumber(redis.call('GET', KEYS[1]) or '0')
local fenced = tonumber(redis.call('GET', KEYS[2]) or '0')
local incoming = tonumber(ARGV[1])
if incoming <= applied or incoming < fenced then
    return nil
end
if incoming == fenced then
    local reservation = redis.call('GET', KEYS[5])
    if not reservation then
        return nil
    end
    local separator1 = string.find(reservation, ':')
    local separator2 = string.find(reservation, ':', separator1 + 1)
    local reserved_sequence = tonumber(string.sub(reservation, 1, separator1 - 1))
    if reserved_sequence ~= incoming then
        return nil
    end
    redis.call('EXPIRE', KEYS[2], ARGV[2])
    redis.call('EXPIRE', KEYS[5], ARGV[2])
    return {
        tonumber(string.sub(reservation, separator1 + 1, separator2 - 1)),
        tonumber(string.sub(reservation, separator2 + 1))
    }
end
local current_generation = tonumber(redis.call('GET', KEYS[3]) or '0')
local allocated_generation = tonumber(redis.call('GET', KEYS[4]) or tostring(current_generation))
if allocated_generation < current_generation then
    allocated_generation = current_generation
end
local reserved_generation = allocated_generation + 1
redis.call('SET', KEYS[4], reserved_generation)
redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[2])
redis.call('SET', KEYS[5], ARGV[1] .. ':' .. reserved_generation .. ':' .. current_generation, 'EX', ARGV[2])
return { reserved_generation, current_generation }
`;

const COMMIT_FRESH_ULTRAFIX_SCRIPT = `
local applied_value = redis.call('GET', KEYS[1])
local current_value = redis.call('GET', KEYS[3])
if applied_value == ARGV[1] and current_value == ARGV[2] then
    return tonumber(ARGV[2])
end
if redis.call('GET', KEYS[2]) ~= ARGV[1]
    or redis.call('GET', KEYS[6]) ~= ARGV[1] .. ':' .. ARGV[2] .. ':' .. ARGV[3] then
    return nil
end
local applied = tonumber(redis.call('GET', KEYS[1]) or '0')
local incoming = tonumber(ARGV[1])
local current_generation = tonumber(redis.call('GET', KEYS[3]) or '0')
local reserved_generation = tonumber(ARGV[2])
local base_generation = tonumber(ARGV[3])
if incoming <= applied or current_generation ~= base_generation then
    return nil
end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('DEL', KEYS[2])
redis.call('SET', KEYS[3], ARGV[2])
redis.call('DEL', KEYS[4])
redis.call('SET', KEYS[5], ARGV[4])
redis.call('DEL', KEYS[6])
return reserved_generation
`;

const ABORT_FRESH_ULTRAFIX_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
    return 0
end
local reservation = redis.call('GET', KEYS[2])
if not reservation or string.sub(reservation, 1, string.len(ARGV[1]) + 1) ~= ARGV[1] .. ':' then
    return 0
end
redis.call('DEL', KEYS[1])
redis.call('DEL', KEYS[2])
return 1
`;

export async function reserveFreshUltrafixTransition(
    redis: Redis,
    identity: UltrafixIdentity,
    commandSequence: number,
): Promise<{ generation: number; baseGeneration: number } | null> {
    const key = (fn: typeof getUltrafixDeferredKey): string => fn(identity.owner, identity.repo, identity.pr);
    const result = await redis.eval(
        RESERVE_FRESH_ULTRAFIX_SCRIPT,
        5,
        key(getUltrafixTransitionOrderKey),
        key(getUltrafixTakeoverFenceKey),
        key(getUltrafixDeferredGenerationKey),
        key(getUltrafixGenerationAllocationKey),
        key(getUltrafixFreshReservationKey),
        String(commandSequence),
        String(RESERVATION_TTL_SECONDS),
    );
    if (!Array.isArray(result) || result.length !== 2) return null;
    return { generation: Number(result[0]), baseGeneration: Number(result[1]) };
}

interface CommitFreshTransitionOptions {
    identity: UltrafixIdentity;
    commandSequence: number;
    generation: number;
    baseGeneration: number;
    stateKey: string;
    serializedState: string;
}

export async function commitFreshUltrafixTransitionState(
    redis: Redis,
    options: CommitFreshTransitionOptions,
): Promise<boolean> {
    const { identity, commandSequence, generation, baseGeneration, stateKey, serializedState } = options;
    const key = (fn: typeof getUltrafixDeferredKey): string => fn(identity.owner, identity.repo, identity.pr);
    const evaluate = () => redis.eval(
        COMMIT_FRESH_ULTRAFIX_SCRIPT, 6,
        key(getUltrafixTransitionOrderKey), key(getUltrafixTakeoverFenceKey),
        key(getUltrafixDeferredGenerationKey), key(getUltrafixDeferredKey),
        stateKey, key(getUltrafixFreshReservationKey),
        String(commandSequence), String(generation), String(baseGeneration), serializedState,
    );
    try {
        return Number(await evaluate()) === generation;
    } catch (error) {
        try {
            return Number(await evaluate()) === generation;
        } catch {
            throw error;
        }
    }
}

export async function abortFreshUltrafixTransition(
    redis: Redis,
    identity: UltrafixIdentity,
    commandSequence: number,
): Promise<boolean> {
    const key = (fn: typeof getUltrafixDeferredKey): string => fn(identity.owner, identity.repo, identity.pr);
    return Number(await redis.eval(
        ABORT_FRESH_ULTRAFIX_SCRIPT,
        2,
        key(getUltrafixTakeoverFenceKey),
        key(getUltrafixFreshReservationKey),
        String(commandSequence),
    )) === 1;
}

/** Return whether a not-yet-published generation still has a live reservation. */
export async function isFreshUltrafixTransitionReserved(
    redis: Redis,
    identity: UltrafixIdentity,
    generation: number,
): Promise<boolean> {
    const reservation = await redis.get(
        getUltrafixFreshReservationKey(identity.owner, identity.repo, identity.pr),
    );
    if (!reservation) return false;
    const [, reservedGeneration] = reservation.split(':');
    return Number(reservedGeneration) === generation;
}
