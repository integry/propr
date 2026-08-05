import type { JobResult } from '@propr/core';
import type { Redis } from 'ioredis';

const REMOTE_OUTCOME_TTL_SECONDS = 30 * 24 * 3600;

export const PERSIST_REMOTE_OUTCOME_SCRIPT = `
if redis.call('get', KEYS[1]) ~= ARGV[1] then
    return 0
end
redis.call('setex', KEYS[2], ARGV[2], ARGV[3])
return 1
`;

export function getPRCommentRemoteOutcomeKey(taskId: string): string {
    return `pr-comment:remote-outcome:${taskId}`;
}

function isRecoverableRemoteOutcome(value: unknown): value is JobResult {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const result = value as Partial<JobResult>;
    return (result.status === 'complete' || result.status === 'partial')
        && typeof result.prProcessingAttemptGeneration === 'string'
        && result.prProcessingAttemptGeneration.length > 0;
}

/** Records an externally published outcome only while this attempt owns the live PR lease. */
export async function persistPRCommentRemoteOutcome(
    redisClient: Pick<InstanceType<typeof Redis>, 'eval'>,
    options: {
        taskId: string;
        lockKey: string;
        lockToken: string;
        result: JobResult;
    },
): Promise<void> {
    const persisted = await redisClient.eval(
        PERSIST_REMOTE_OUTCOME_SCRIPT,
        2,
        options.lockKey,
        getPRCommentRemoteOutcomeKey(options.taskId),
        options.lockToken,
        REMOTE_OUTCOME_TTL_SECONDS,
        JSON.stringify(options.result),
    );
    if (Number(persisted) !== 1) {
        throw new Error(`PR processing lease was lost before recording the remote outcome for taskId: ${options.taskId}`);
    }
}

export async function loadPRCommentRemoteOutcome(
    redisClient: { get(key: string): Promise<string | null> },
    taskId: string,
): Promise<JobResult | null> {
    const value = await redisClient.get(getPRCommentRemoteOutcomeKey(taskId));
    if (!value) return null;
    try {
        const result = JSON.parse(value) as unknown;
        return isRecoverableRemoteOutcome(result) ? result : null;
    } catch {
        return null;
    }
}
