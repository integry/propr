import type { Redis } from 'ioredis';
import type { UltrafixLoopState } from './ultrafixOrchestrationService.js';
import {
    getUltrafixDeferredGenerationKey,
    getUltrafixDeferredKey,
    getUltrafixGenerationAllocationKey,
} from './ultrafixDeferredContinuationStore.js';
import {
    getUltrafixStateKey,
    ULTRAFIX_STATE_KEY_PREFIX,
} from './ultrafixStateKey.js';

export { getUltrafixStateKey } from './ultrafixStateKey.js';

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

const IS_ACTIVE_GENERATION_SCRIPT = `
local current_generation = redis.call('GET', KEYS[1]) or '0'
if current_generation ~= ARGV[1] then
    return 0
end
local serialized_state = redis.call('GET', KEYS[2])
if not serialized_state then
    return 0
end
local decoded, state = pcall(cjson.decode, serialized_state)
if not decoded or state.active ~= true or tonumber(state.generation) ~= tonumber(ARGV[1]) then
    return 0
end
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

export async function listUltrafixStateKeys(redis: Redis): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
        const [nextCursor, batch] = await redis.scan(
            cursor, 'MATCH', `${ULTRAFIX_STATE_KEY_PREFIX}:*`, 'COUNT', '100',
        );
        cursor = nextCursor;
        keys.push(...batch);
    } while (cursor !== '0');
    return keys;
}

export function parseUltrafixStateKey(
    key: string,
): { owner: string; repo: string; pr: number } | null {
    const prefix = `${ULTRAFIX_STATE_KEY_PREFIX}:`;
    if (!key.startsWith(prefix)) return null;
    const [owner, repo, rawPr, ...extra] = key.slice(prefix.length).split(':');
    const pr = Number(rawPr);
    if (!owner || !repo || extra.length > 0 || !Number.isInteger(pr)) return null;
    return { owner, repo, pr };
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

/** Atomically require both current generation ownership and an active loop state. */
export async function isUltrafixGenerationActive(
    redis: Redis,
    identity: { owner: string; repo: string; pr: number },
    generation: number | undefined,
): Promise<boolean> {
    if (generation === undefined) return false;
    const generationKey = getUltrafixDeferredGenerationKey(identity.owner, identity.repo, identity.pr);
    const stateKey = getUltrafixStateKey(identity.owner, identity.repo, identity.pr);
    return Number(await redis.eval(
        IS_ACTIVE_GENERATION_SCRIPT,
        2,
        generationKey,
        stateKey,
        String(generation),
    )) === 1;
}

/** Persist one idempotent successful-loop finalization step under generation ownership. */
export async function recordTerminalFinalizationStep(
    redis: Redis,
    params: {
        owner: string;
        repo: string;
        pr: number;
        generation: number;
        step: 'labelRemoved' | 'autoMergeEvaluated';
    },
): Promise<UltrafixLoopState | null> {
    const state = await loadState(redis, params.owner, params.repo, params.pr);
    if (!state
        || state.active
        || state.completionStatus !== 'succeeded'
        || state.generation !== params.generation) {
        return null;
    }
    state.terminalFinalization ??= { labelRemoved: false, autoMergeEvaluated: false };
    state.terminalFinalization[params.step] = true;
    return await saveStateIfGenerationCurrent(redis, state) ? state : null;
}

export async function completeLoop(
    redis: Redis,
    params: {
        owner: string;
        repo: string;
        pr: number;
        generation?: number;
        completionStatus: 'succeeded' | 'failed';
        completionReason: string;
        finalScore: number | null;
    },
): Promise<UltrafixLoopState | null> {
    const state = await loadState(redis, params.owner, params.repo, params.pr);
    if (!state) return null;
    state.active = false;
    state.completionStatus = params.completionStatus;
    state.completionReason = params.completionReason;
    state.finalScore = params.finalScore;
    state.completedAt = new Date().toISOString();
    state.terminalFinalization = params.completionStatus === 'succeeded'
        ? { labelRemoved: false, autoMergeEvaluated: false }
        : undefined;
    const saved = params.generation === undefined
        ? await saveState(redis, state).then(() => true)
        : await saveStateIfGenerationCurrent(redis, state);
    return saved ? state : null;
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
