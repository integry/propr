import type { Redis } from 'ioredis';
import type { UltrafixLoopState } from './ultrafixOrchestrationService.js';
import {
    getUltrafixDeferredGenerationKey,
    getUltrafixDeferredKey,
    getUltrafixGenerationAllocationKey,
} from './ultrafixDeferredContinuationStore.js';

const KEY_PREFIX = 'ultrafix:state';

const SAVE_STATE_IF_CURRENT_SCRIPT = `
local current_generation = redis.call('GET', KEYS[1]) or '0'
if current_generation ~= ARGV[1] then
    return 0
end
redis.call('SET', KEYS[2], ARGV[2])
return 1
`;

const CLEAR_STATE_IF_CURRENT_SCRIPT = `
local current_generation = redis.call('GET', KEYS[1]) or '0'
if current_generation ~= ARGV[1] then
    return 0
end
redis.call('DEL', KEYS[2])
return 1
`;

const ADOPT_LEGACY_GENERATION_SCRIPT = `
local current_generation = redis.call('GET', KEYS[1])
if current_generation and current_generation ~= '0' then
    return 0
end
local serialized_state = redis.call('GET', KEYS[2])
if serialized_state then
    local decoded, state = pcall(cjson.decode, serialized_state)
    if not decoded then
        return 0
    end
    if state.generation ~= nil and tonumber(state.generation) ~= 0 then
        return 0
    end
    state.generation = 0
    redis.call('SET', KEYS[2], cjson.encode(state))
end
redis.call('SET', KEYS[1], '0')
return 1
`;

const RETIRE_LOOP_IF_CURRENT_SCRIPT = `
local current_generation = redis.call('GET', KEYS[1]) or '0'
if current_generation ~= ARGV[1] then
    return 0
end
local allocated_generation = tonumber(redis.call('GET', KEYS[4]) or current_generation)
local numeric_current_generation = tonumber(current_generation)
if allocated_generation < numeric_current_generation then
    allocated_generation = numeric_current_generation
end
local generation = allocated_generation + 1
redis.call('SET', KEYS[4], generation)
redis.call('SET', KEYS[1], generation)
redis.call('DEL', KEYS[2])
redis.call('DEL', KEYS[3])
return 1
`;

export function getUltrafixStateKey(owner: string, repo: string, pr: number): string {
    return `${KEY_PREFIX}:${owner}:${repo}:${pr}`;
}

export async function saveState(redis: Redis, state: UltrafixLoopState): Promise<void> {
    const key = getUltrafixStateKey(state.owner, state.repo, state.pr);
    await redis.set(key, JSON.stringify(state));
}

export async function loadState(redis: Redis, owner: string, repo: string, pr: number): Promise<UltrafixLoopState | null> {
    const key = getUltrafixStateKey(owner, repo, pr);
    const raw = await redis.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as UltrafixLoopState;
}

export async function clearState(redis: Redis, owner: string, repo: string, pr: number): Promise<void> {
    const key = getUltrafixStateKey(owner, repo, pr);
    await redis.del(key);
}

export async function saveStateIfGenerationCurrent(redis: Redis, state: UltrafixLoopState): Promise<boolean> {
    const generationKey = getUltrafixDeferredGenerationKey(state.owner, state.repo, state.pr);
    const stateKey = getUltrafixStateKey(state.owner, state.repo, state.pr);
    return Number(await redis.eval(
        SAVE_STATE_IF_CURRENT_SCRIPT,
        2,
        generationKey,
        stateKey,
        String(state.generation),
        JSON.stringify(state),
    )) === 1;
}

export async function clearStateIfGenerationCurrent(
    redis: Redis,
    identity: { owner: string; repo: string; pr: number },
    generation: number,
): Promise<boolean> {
    const generationKey = getUltrafixDeferredGenerationKey(identity.owner, identity.repo, identity.pr);
    const stateKey = getUltrafixStateKey(identity.owner, identity.repo, identity.pr);
    return Number(await redis.eval(
        CLEAR_STATE_IF_CURRENT_SCRIPT,
        2,
        generationKey,
        stateKey,
        String(generation),
    )) === 1;
}

/**
 * Adopt work created before generation fencing as generation zero. The
 * migration is permitted only until any newer takeover advances the
 * authoritative generation, so generation-less work can never re-enter after
 * a manual command or fresh loop has superseded it.
 */
export async function adoptLegacyUltrafixGeneration(
    redis: Redis,
    identity: { owner: string; repo: string; pr: number },
): Promise<boolean> {
    const generationKey = getUltrafixDeferredGenerationKey(identity.owner, identity.repo, identity.pr);
    const stateKey = getUltrafixStateKey(identity.owner, identity.repo, identity.pr);
    return Number(await redis.eval(
        ADOPT_LEGACY_GENERATION_SCRIPT,
        2,
        generationKey,
        stateKey,
    )) === 1;
}

/** Invalidate a loop and delete both its state and deferred continuation atomically. */
export async function retireLoopIfGenerationCurrent(
    redis: Redis,
    identity: { owner: string; repo: string; pr: number },
    generation: number,
): Promise<boolean> {
    const generationKey = getUltrafixDeferredGenerationKey(identity.owner, identity.repo, identity.pr);
    const deferredKey = getUltrafixDeferredKey(identity.owner, identity.repo, identity.pr);
    const stateKey = getUltrafixStateKey(identity.owner, identity.repo, identity.pr);
    const allocationKey = getUltrafixGenerationAllocationKey(identity.owner, identity.repo, identity.pr);
    return Number(await redis.eval(
        RETIRE_LOOP_IF_CURRENT_SCRIPT,
        4,
        generationKey,
        deferredKey,
        stateKey,
        allocationKey,
        String(generation),
    )) === 1;
}
