import type { Redis } from 'ioredis';

export const ULTRAFIX_DEFERRED_KEY_PREFIX = 'ultrafix:deferred';
const AUTOMATIC_WORK_EPOCH_KEY_PREFIX = 'ultrafix:automatic-work-epoch';
const ULTRAFIX_STATE_KEY_PREFIX = 'ultrafix:state';

const SAVE_DEFERRED_IF_CURRENT_SCRIPT = `
local current_epoch = redis.call('GET', KEYS[1]) or '0'
if current_epoch ~= ARGV[1] then
    return 0
end
redis.call('SET', KEYS[2], ARGV[2])
return 1
`;

const INVALIDATE_AUTOMATIC_WORK_SCRIPT = `
local epoch = redis.call('INCR', KEYS[1])
redis.call('DEL', KEYS[2])
return epoch
`;

export function getUltrafixDeferredKey(owner: string, repo: string, pr: number): string {
    return `${ULTRAFIX_DEFERRED_KEY_PREFIX}:${owner}:${repo}:${pr}`;
}

export function getUltrafixAutomaticWorkEpochKey(owner: string, repo: string, pr: number): string {
    return `${AUTOMATIC_WORK_EPOCH_KEY_PREFIX}:${owner}:${repo}:${pr}`;
}

/** Whether a manual command must be queued independently to take over live automatic work. */
export async function hasUltrafixAutomaticWork(
    redis: Redis,
    owner: string,
    repo: string,
    pr: number,
): Promise<boolean> {
    const [rawState, deferred] = await Promise.all([
        redis.get(`${ULTRAFIX_STATE_KEY_PREFIX}:${owner}:${repo}:${pr}`),
        redis.get(getUltrafixDeferredKey(owner, repo, pr)),
    ]);
    if (deferred !== null) return true;
    if (rawState === null) return false;
    try {
        return (JSON.parse(rawState) as { active?: unknown }).active === true;
    } catch {
        return true;
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

/** Invalidate deferred and queued automatic actions before a manual takeover. */
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
