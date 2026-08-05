import type { Redis } from 'ioredis';

export interface UltrafixMutationLease {
    lockKey: string;
    lockToken: string;
    assertLease: () => Promise<void>;
}

export const RECORD_ULTRAFIX_ACTION_WITH_LEASE_SCRIPT = `
if redis.call('get', KEYS[1]) ~= ARGV[1] then
    return {-1}
end
local raw = redis.call('get', KEYS[2])
if not raw then
    return {0}
end
local state = cjson.decode(raw)
local handled = state.handledContinuationIds or {}
if ARGV[4] ~= '' then
    for _, continuation_id in ipairs(handled) do
        if continuation_id == ARGV[4] then
            return {1, raw}
        end
    end
end
local review_count = tonumber(state.reviewCount)
local fix_count = tonumber(state.fixCount)
if not review_count or not fix_count then
    local cycle_count = tonumber(state.cycleCount) or 0
    if state.lastAction == 'review' then
        review_count = cycle_count + 1
        fix_count = cycle_count
    elseif state.lastAction == 'fix' then
        review_count = cycle_count
        fix_count = cycle_count
    else
        review_count = 0
        fix_count = 0
    end
end
state.lastAction = ARGV[2]
state.lastActionTimestamp = ARGV[3]
if ARGV[4] ~= '' then
    table.insert(handled, ARGV[4])
end
state.handledContinuationIds = handled
if ARGV[2] == 'review' then
    review_count = review_count + 1
else
    fix_count = fix_count + 1
end
state.reviewCount = review_count
state.fixCount = fix_count
state.cycleCount = math.min(review_count, fix_count)
local updated = cjson.encode(state)
redis.call('set', KEYS[2], updated)
return {1, updated}
`;

export const AUTHORIZE_ULTRAFIX_CONTINUATION_WITH_LEASE_SCRIPT = `
if redis.call('get', KEYS[1]) ~= ARGV[1] then
    return -1
end
local raw = redis.call('get', KEYS[2])
if not raw then
    return 0
end
local state = cjson.decode(raw)
local scheduled = state.scheduledContinuationIds or {}
for _, continuation_id in ipairs(scheduled) do
    if continuation_id == ARGV[2] then
        return 1
    end
end
table.insert(scheduled, ARGV[2])
state.scheduledContinuationIds = scheduled
redis.call('set', KEYS[2], cjson.encode(state))
return 1
`;

export async function recordUltrafixActionWithLease(
    redis: Redis,
    params: { stateKey: string; action: 'review' | 'fix'; continuationId?: string },
    lease: UltrafixMutationLease,
): Promise<string | null> {
    const result = await redis.eval(
        RECORD_ULTRAFIX_ACTION_WITH_LEASE_SCRIPT,
        2,
        lease.lockKey,
        params.stateKey,
        lease.lockToken,
        params.action,
        new Date().toISOString(),
        params.continuationId ?? '',
    ) as unknown;
    if (!Array.isArray(result)) throw new Error('Invalid fenced Ultrafix action response');
    const status = Number(result[0]);
    if (status === -1) {
        await lease.assertLease();
        throw new Error('Could not generation-fence the Ultrafix continuation');
    }
    if (status === 0) return null;
    if (typeof result[1] !== 'string') throw new Error('Invalid fenced Ultrafix action state');
    return result[1];
}

/** Authorizes idempotent queue delivery while the source attempt owns the PR lease. */
export async function authorizeUltrafixContinuation(
    redis: Redis,
    params: { stateKey: string; continuationId: string },
    lease: UltrafixMutationLease,
): Promise<void> {
    const result = Number(await redis.eval(
        AUTHORIZE_ULTRAFIX_CONTINUATION_WITH_LEASE_SCRIPT,
        2,
        lease.lockKey,
        params.stateKey,
        lease.lockToken,
        params.continuationId,
    ));
    if (result === 1) return;
    if (result === -1) await lease.assertLease();
    throw new Error('Could not generation-fence the Ultrafix continuation delivery');
}
