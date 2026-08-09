import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

export const ULTRAFIX_DEFERRED_KEY_PREFIX = 'ultrafix:deferred';
const AUTOMATIC_WORK_EPOCH_KEY_PREFIX = 'ultrafix:automatic-work-epoch';
const ULTRAFIX_STATE_KEY_PREFIX = 'ultrafix:state';
const MANUAL_TAKEOVER_KEY_PREFIX = 'ultrafix:manual-takeover';
const LABEL_TRANSITION_LOCK_KEY_PREFIX = 'ultrafix:label-transition';
const MANUAL_TAKEOVER_TTL_SECONDS = 24 * 60 * 60;
const LABEL_TRANSITION_LOCK_TTL_MS = 2 * 60 * 1000;
const LABEL_TRANSITION_WAIT_MS = 60 * 1000;

export interface UltrafixManualTakeover {
    workEpoch: number;
    hadAutomaticWork: boolean;
}

export interface UltrafixManualTakeoverIdentity {
    owner: string;
    repo: string;
    pr: number;
    sourceCommentId: number;
    sourceCommentRevision: string;
}

const SAVE_DEFERRED_IF_CURRENT_SCRIPT = `
local current_epoch = redis.call('GET', KEYS[1]) or '0'
if current_epoch ~= ARGV[1] then
    return 0
end
redis.call('SET', KEYS[2], ARGV[2])
return 1
`;

const CLEAR_DEFERRED_IF_CURRENT_SCRIPT = `
local current_epoch = redis.call('GET', KEYS[1]) or '0'
if current_epoch ~= ARGV[1] then
    return 0
end
redis.call('DEL', KEYS[2])
return 1
`;

const SAVE_STATE_IF_CURRENT_SCRIPT = `
local current_epoch = redis.call('GET', KEYS[1]) or '0'
if current_epoch ~= ARGV[1] then
    return 0
end
redis.call('SET', KEYS[2], ARGV[2])
return 1
`;

const CLEAR_STATE_IF_CURRENT_SCRIPT = `
local current_epoch = redis.call('GET', KEYS[1]) or '0'
if current_epoch ~= ARGV[1] then
    return 0
end
redis.call('DEL', KEYS[2])
return 1
`;

const INVALIDATE_AUTOMATIC_WORK_SCRIPT = `
local epoch = redis.call('INCR', KEYS[1])
redis.call('DEL', KEYS[2])
return epoch
`;

const INVALIDATE_AUTOMATIC_WORK_ONCE_SCRIPT = `
local existing = redis.call('GET', KEYS[4])
if existing then
    local epoch, had_automatic_work = string.match(existing, '^(%d+):([01])$')
    if epoch and had_automatic_work then
        return { tonumber(epoch), tonumber(had_automatic_work) }
    end
end

local current_epoch = tonumber(redis.call('GET', KEYS[1]) or '0')
local had_automatic_work = redis.call('EXISTS', KEYS[2])
if had_automatic_work == 0 then
    local raw_state = redis.call('GET', KEYS[3])
    if raw_state then
        local decoded, state = pcall(cjson.decode, raw_state)
        if decoded and type(state) == 'table' then
            local state_epoch = tonumber(state.workEpoch) or 0
            if state.active == true and state_epoch == current_epoch then
                had_automatic_work = 1
            end
        elseif current_epoch == 0 then
            had_automatic_work = 1
        end
    end
end

local epoch = redis.call('INCR', KEYS[1])
redis.call('DEL', KEYS[2])
redis.call('SET', KEYS[4], tostring(epoch) .. ':' .. tostring(had_automatic_work), 'EX', ARGV[1])
return { epoch, had_automatic_work }
`;

const RELEASE_LABEL_TRANSITION_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
end
return 0
`;

export function getUltrafixDeferredKey(owner: string, repo: string, pr: number): string {
    return `${ULTRAFIX_DEFERRED_KEY_PREFIX}:${owner}:${repo}:${pr}`;
}

export function getUltrafixAutomaticWorkEpochKey(owner: string, repo: string, pr: number): string {
    return `${AUTOMATIC_WORK_EPOCH_KEY_PREFIX}:${owner}:${repo}:${pr}`;
}

function getUltrafixManualTakeoverKey(identity: UltrafixManualTakeoverIdentity): string {
    const { owner, repo, pr, sourceCommentId, sourceCommentRevision } = identity;
    return `${MANUAL_TAKEOVER_KEY_PREFIX}:${owner}:${repo}:${pr}:${sourceCommentId}:${sourceCommentRevision}`;
}

function getUltrafixLabelTransitionLockKey(identity: { owner: string; repo: string; pr: number }): string {
    return `${LABEL_TRANSITION_LOCK_KEY_PREFIX}:${identity.owner}:${identity.repo}:${identity.pr}`;
}

/** Serialize the shared GitHub label with epoch state publication and cleanup. */
export async function withUltrafixLabelTransition<T>(
    redis: Redis,
    identity: { owner: string; repo: string; pr: number },
    operation: () => Promise<T>,
): Promise<T> {
    const key = getUltrafixLabelTransitionLockKey(identity);
    const token = randomUUID();
    const deadline = Date.now() + LABEL_TRANSITION_WAIT_MS;
    while (await redis.set(key, token, 'PX', LABEL_TRANSITION_LOCK_TTL_MS, 'NX') !== 'OK') {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for Ultrafix label transition');
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    try {
        return await operation();
    } finally {
        await redis.eval(RELEASE_LABEL_TRANSITION_LOCK_SCRIPT, 1, key, token);
    }
}

/** Whether a manual command must be queued independently to take over live automatic work. */
export async function hasUltrafixAutomaticWork(
    redis: Redis,
    owner: string,
    repo: string,
    pr: number,
): Promise<boolean> {
    const [rawState, deferred, currentEpoch] = await Promise.all([
        redis.get(`${ULTRAFIX_STATE_KEY_PREFIX}:${owner}:${repo}:${pr}`),
        redis.get(getUltrafixDeferredKey(owner, repo, pr)),
        getUltrafixAutomaticWorkEpoch(redis, owner, repo, pr),
    ]);
    if (deferred !== null) return true;
    if (rawState === null) return false;
    try {
        const state = JSON.parse(rawState) as { active?: unknown; workEpoch?: unknown };
        const stateEpoch = typeof state.workEpoch === 'number' ? state.workEpoch : 0;
        return state.active === true && stateEpoch === currentEpoch;
    } catch {
        // Legacy state belongs to epoch zero. Once a takeover has advanced the
        // epoch, malformed or otherwise unversioned state must not stay live.
        return currentEpoch === 0;
    }
}

export async function getUltrafixAutomaticWorkEpoch(
    redis: Redis,
    owner: string,
    repo: string,
    pr: number,
): Promise<number> {
    const raw = await redis.get(getUltrafixAutomaticWorkEpochKey(owner, repo, pr));
    return Number(raw ?? '0');
}

export async function isUltrafixAutomaticWorkCurrent(
    redis: Redis,
    identity: { owner: string; repo: string; pr: number },
    workEpoch?: number,
): Promise<boolean> {
    const currentEpoch = await getUltrafixAutomaticWorkEpoch(
        redis,
        identity.owner,
        identity.repo,
        identity.pr,
    );
    return currentEpoch === (workEpoch ?? 0);
}

/** Invalidate deferred and queued automatic actions. */
export async function invalidateUltrafixAutomaticWork(
    redis: Redis,
    owner: string,
    repo: string,
    pr: number,
): Promise<number> {
    const nextEpoch = await redis.eval(
        INVALIDATE_AUTOMATIC_WORK_SCRIPT,
        2,
        getUltrafixAutomaticWorkEpochKey(owner, repo, pr),
        getUltrafixDeferredKey(owner, repo, pr),
    );
    return Number(nextEpoch);
}

/** Idempotently fence automatic actions for one source comment revision and preserve its takeover decision. */
export async function invalidateUltrafixAutomaticWorkForComment(
    redis: Redis,
    identity: UltrafixManualTakeoverIdentity,
): Promise<UltrafixManualTakeover> {
    const { owner, repo, pr } = identity;
    const result = await redis.eval(
        INVALIDATE_AUTOMATIC_WORK_ONCE_SCRIPT,
        4,
        getUltrafixAutomaticWorkEpochKey(owner, repo, pr),
        getUltrafixDeferredKey(owner, repo, pr),
        `${ULTRAFIX_STATE_KEY_PREFIX}:${owner}:${repo}:${pr}`,
        getUltrafixManualTakeoverKey(identity),
        String(MANUAL_TAKEOVER_TTL_SECONDS),
    ) as [number | string, number | string];
    return {
        workEpoch: Number(result[0]),
        hadAutomaticWork: Number(result[1]) === 1,
    };
}

export async function saveDeferredContinuationIfCurrent(
    redis: Redis,
    identity: { owner: string; repo: string; pr: number },
    workEpoch: number,
    serializedDeferred: string,
): Promise<boolean> {
    const saved = await redis.eval(
        SAVE_DEFERRED_IF_CURRENT_SCRIPT,
        2,
        getUltrafixAutomaticWorkEpochKey(identity.owner, identity.repo, identity.pr),
        getUltrafixDeferredKey(identity.owner, identity.repo, identity.pr),
        String(workEpoch),
        serializedDeferred,
    );
    return Number(saved) === 1;
}

export async function clearDeferredContinuationIfCurrent(
    redis: Redis,
    identity: { owner: string; repo: string; pr: number },
    workEpoch: number,
): Promise<boolean> {
    const cleared = await redis.eval(
        CLEAR_DEFERRED_IF_CURRENT_SCRIPT,
        2,
        getUltrafixAutomaticWorkEpochKey(identity.owner, identity.repo, identity.pr),
        getUltrafixDeferredKey(identity.owner, identity.repo, identity.pr),
        String(workEpoch),
    );
    return Number(cleared) === 1;
}

export async function saveUltrafixStateIfCurrent(
    redis: Redis,
    identity: { owner: string; repo: string; pr: number },
    workEpoch: number,
    serializedState: string,
): Promise<boolean> {
    const saved = await redis.eval(
        SAVE_STATE_IF_CURRENT_SCRIPT,
        2,
        getUltrafixAutomaticWorkEpochKey(identity.owner, identity.repo, identity.pr),
        `${ULTRAFIX_STATE_KEY_PREFIX}:${identity.owner}:${identity.repo}:${identity.pr}`,
        String(workEpoch),
        serializedState,
    );
    return Number(saved) === 1;
}

export async function clearUltrafixStateIfCurrent(
    redis: Redis,
    identity: { owner: string; repo: string; pr: number },
    workEpoch: number,
): Promise<boolean> {
    const cleared = await redis.eval(
        CLEAR_STATE_IF_CURRENT_SCRIPT,
        2,
        getUltrafixAutomaticWorkEpochKey(identity.owner, identity.repo, identity.pr),
        `${ULTRAFIX_STATE_KEY_PREFIX}:${identity.owner}:${identity.repo}:${identity.pr}`,
        String(workEpoch),
    );
    return Number(cleared) === 1;
}
