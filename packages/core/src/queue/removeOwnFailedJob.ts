/**
 * Removal of a failed job that only removes the delivery the caller holds.
 *
 * Job IDs here are deterministic, so once a failed job is gone (BullMQ removed
 * it on failure, or retention trimmed it) a later trigger may add a new
 * delivery under the same ID. `Job.remove` addresses the job by ID alone, so a
 * failure handler that removes "its" job after awaiting other work could
 * delete that replacement while it waits or is delayed. This removal runs
 * BullMQ's own `removeJob` script behind an atomic guard: the job ID must still
 * be in the failed set, and its stored `timestamp` (set when the delivery was
 * added) and `finishedOn` must be those of the failed delivery held.
 */
import type { Job, JobsOptions, Queue } from 'bullmq';
import type { Redis } from 'ioredis';

export type RemoveOwnFailedJobOutcome =
    /** BullMQ removed the job when it failed; nothing was done. */
    | 'removed_on_fail'
    | 'removed'
    /** The ID now names another delivery, or this one is no longer failed; nothing was done. */
    | 'not_owned'
    /** BullMQ's removal refused (a lock is held, or the job belongs to a scheduler). */
    | 'refused';

const NOT_OWNED = -100;

const OWNERSHIP_GUARD = `
if redis.call("ZSCORE", KEYS[3], ARGV[1]) == false then return ${NOT_OWNED} end
local held = redis.call("HMGET", KEYS[1], "timestamp", "finishedOn")
if held[1] ~= ARGV[4] then return ${NOT_OWNED} end
if ARGV[5] ~= "" and held[2] ~= ARGV[5] then return ${NOT_OWNED} end
`;

let guardedRemoveScript: string | undefined;

async function guardedRemove(): Promise<string> {
    if (!guardedRemoveScript) {
        // BullMQ's packaged script (no subpath exports; the CJS build is what Node resolves for `bullmq`).
        const specifier = 'bullmq/dist/cjs/scripts/removeJob-2.js';
        const { removeJob } = await import(specifier) as { removeJob: { content: string; keys: number } };
        if (removeJob.keys !== 2) throw new Error(`Unexpected BullMQ removeJob script (${removeJob.keys} keys)`);
        guardedRemoveScript = OWNERSHIP_GUARD + removeJob.content;
    }
    return guardedRemoveScript;
}

/** Whether BullMQ deletes a job as it moves to failed, so no failed job is left to remove. */
export function isRemovedOnFail(opts: Pick<JobsOptions, 'removeOnFail'> | undefined): boolean {
    const keep = opts?.removeOnFail;
    if (keep === true || keep === 0) return true;
    return typeof keep === 'object' && keep !== null && keep.count === 0;
}

/** Remove `job`, a delivery that failed for good, only while its ID still names that failed delivery. */
export async function removeOwnFailedJob(queue: Pick<Queue, 'client' | 'toKey' | 'keys'>, job: Pick<Job, 'id' | 'opts' | 'timestamp' | 'finishedOn'>): Promise<RemoveOwnFailedJobOutcome> {
    if (isRemovedOnFail(job.opts)) return 'removed_on_fail';
    const id = String(job.id);
    // The queue's connection is an ioredis client; BullMQ types it as a narrower interface.
    const client = await queue.client as unknown as Pick<Redis, 'eval'>;
    const result = await client.eval(
        await guardedRemove(), 3,
        queue.toKey(id), queue.toKey('repeat'), queue.keys.failed,
        id, '0', queue.toKey(''), String(job.timestamp), job.finishedOn == null ? '' : String(job.finishedOn),
    );
    if (result === NOT_OWNED) return 'not_owned';
    return result === 1 ? 'removed' : 'refused';
}
