import type { Redis } from 'ioredis';
import { repositoryWorkflowSlotKeys } from './workflowConcurrency.js';

/** Repository workflow capacity (`limits.max_parallel_tasks`) in use right now, for one repository that has a limit. */
export interface RepositoryWorkflowSlotUsage {
    /** Lowercased repository handle, as the slot keys store it. */
    repository: string;
    inUse: number;
    /** The smallest limit any running run of the repository was admitted under (admission uses the same rule). */
    limit: number;
    /** Jobs deferred for this repository's capacity and waiting for a released slot. */
    waiting: number;
}

// Read-only, by Redis server time (seconds, as the slot scripts). Expired
// slots are ignored rather than removed; the next acquire removes them.
const USAGE_SCRIPT = `
local now = tonumber(redis.call('TIME')[1])
local live = redis.call('ZRANGEBYSCORE', KEYS[1], '(' .. now, '+inf')
local limit = 0
for _, member in ipairs(live) do
    local value = tonumber(redis.call('HGET', KEYS[2], member) or 0)
    if value and value > 0 and (limit == 0 or value < limit) then limit = value end
end
local waiting = redis.call('ZCOUNT', KEYS[4], '(' .. now, '+inf')
return {#live, limit, waiting}
`;

const PATTERN = 'propr:workflow:slots:{*}:limits';
const REPOSITORY = /^propr:workflow:slots:\{(.+)\}:limits$/;

/**
 * Slots in use per repository whose running work carries a limit. Discovered
 * from the slot keys, which exist only while a run holds a slot, so a
 * repository with a limit and nothing running is not listed.
 */
export async function repositoryWorkflowSlotUsage(redis: Pick<Redis, 'scan' | 'eval'>, maxRepositories = 500): Promise<RepositoryWorkflowSlotUsage[]> {
    const repositories = new Set<string>();
    let cursor = '0';
    do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', PATTERN, 'COUNT', 200);
        cursor = next;
        for (const key of keys) {
            const repository = REPOSITORY.exec(key)?.[1];
            if (repository) repositories.add(repository);
        }
    } while (cursor !== '0' && repositories.size < maxRepositories);
    const usage: RepositoryWorkflowSlotUsage[] = [];
    for (const repository of [...repositories].sort().slice(0, maxRepositories)) {
        const keys = repositoryWorkflowSlotKeys(repository);
        const [inUse, limit, waiting] = (await redis.eval(USAGE_SCRIPT, 4, ...keys) as number[]).map(Number);
        if (limit > 0) usage.push({ repository, inUse, limit, waiting });
    }
    return usage;
}
