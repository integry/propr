import type { JobResult } from '@propr/core';
import type { Redis } from 'ioredis';

const REMOTE_OUTCOME_TTL_SECONDS = 30 * 24 * 3600;

export const PR_COMMENT_PUBLICATION_STAGES = [
    'push_pending',
    'branch_pushed',
    'completion_comment_published',
    'review_comments_processed',
    'continuation_handled',
    'commit_hash_persisted',
] as const;

export type PRCommentPublicationStage = typeof PR_COMMENT_PUBLICATION_STAGES[number];

export interface PRCommentPublicationCheckpoint {
    kind: 'implementation-publication';
    stage: PRCommentPublicationStage;
    prProcessingAttemptGeneration: string;
    result: JobResult;
    branchName: string;
    completionComment: {
        id: number;
        body: string;
        htmlUrl?: string;
    };
    reviewCommentIds: number[];
    terminationReason?: string;
}

export const PERSIST_REMOTE_OUTCOME_SCRIPT = `
if redis.call('get', KEYS[1]) ~= ARGV[1] then
    return 0
end
redis.call('setex', KEYS[2], ARGV[2], ARGV[3])
return 1
`;

export const CLEAR_REMOTE_OUTCOME_SCRIPT = `
if redis.call('get', KEYS[1]) ~= ARGV[1] then
    return 0
end
return redis.call('del', KEYS[2])
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

function isPublicationStage(value: unknown): value is PRCommentPublicationStage {
    return typeof value === 'string'
        && (PR_COMMENT_PUBLICATION_STAGES as readonly string[]).includes(value);
}

function isValidCompletionComment(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const comment = value as Partial<PRCommentPublicationCheckpoint['completionComment']>;
    return Number.isSafeInteger(comment.id)
        && Number(comment.id) > 0
        && typeof comment.body === 'string'
        && (comment.htmlUrl === undefined || typeof comment.htmlUrl === 'string');
}

function isPublicationCheckpoint(value: unknown): value is PRCommentPublicationCheckpoint {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const checkpoint = value as Partial<PRCommentPublicationCheckpoint>;
    if (checkpoint.kind !== 'implementation-publication'
        || !isPublicationStage(checkpoint.stage)
        || typeof checkpoint.prProcessingAttemptGeneration !== 'string'
        || checkpoint.prProcessingAttemptGeneration.length === 0
        || typeof checkpoint.branchName !== 'string'
        || !Array.isArray(checkpoint.reviewCommentIds)
        || !checkpoint.reviewCommentIds.every(id => Number.isSafeInteger(id) && id > 0)
        || !isValidCompletionComment(checkpoint.completionComment)
        || (checkpoint.terminationReason !== undefined
            && typeof checkpoint.terminationReason !== 'string')
        || !isRecoverableRemoteOutcome(checkpoint.result)) {
        return false;
    }
    if (checkpoint.stage === 'push_pending'
        && (typeof checkpoint.result.commit !== 'string' || checkpoint.result.commit.length === 0)) {
        return false;
    }
    return checkpoint.result.prProcessingAttemptGeneration
        === checkpoint.prProcessingAttemptGeneration;
}

async function persistFencedRemoteValue(
    redisClient: Pick<InstanceType<typeof Redis>, 'eval'>,
    options: {
        taskId: string;
        lockKey: string;
        lockToken: string;
        value: JobResult | PRCommentPublicationCheckpoint;
    },
): Promise<void> {
    const persisted = await redisClient.eval(
        PERSIST_REMOTE_OUTCOME_SCRIPT,
        2,
        options.lockKey,
        getPRCommentRemoteOutcomeKey(options.taskId),
        options.lockToken,
        REMOTE_OUTCOME_TTL_SECONDS,
        JSON.stringify(options.value),
    );
    if (Number(persisted) !== 1) {
        throw new Error(`PR processing lease was lost before recording the remote outcome for taskId: ${options.taskId}`);
    }
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
    await persistFencedRemoteValue(redisClient, { ...options, value: options.result });
}

/** Checkpoints an implementation publication stage under the live attempt lease. */
export async function persistPRCommentPublicationCheckpoint(
    redisClient: Pick<InstanceType<typeof Redis>, 'eval'>,
    options: {
        taskId: string;
        lockKey: string;
        lockToken: string;
        checkpoint: PRCommentPublicationCheckpoint;
    },
): Promise<void> {
    await persistFencedRemoteValue(redisClient, { ...options, value: options.checkpoint });
}

/** Removes an uncommitted pre-push checkpoint only while this attempt owns the PR lease. */
export async function clearPRCommentPublicationCheckpoint(
    redisClient: Pick<InstanceType<typeof Redis>, 'eval'>,
    options: { taskId: string; lockKey: string; lockToken: string },
): Promise<void> {
    const cleared = await redisClient.eval(
        CLEAR_REMOTE_OUTCOME_SCRIPT,
        2,
        options.lockKey,
        getPRCommentRemoteOutcomeKey(options.taskId),
        options.lockToken,
    );
    if (Number(cleared) !== 1) {
        throw new Error(`PR processing lease was lost before clearing the publication checkpoint for taskId: ${options.taskId}`);
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

export async function loadPRCommentPublicationCheckpoint(
    redisClient: { get(key: string): Promise<string | null> },
    taskId: string,
): Promise<PRCommentPublicationCheckpoint | null> {
    const value = await redisClient.get(getPRCommentRemoteOutcomeKey(taskId));
    if (!value) return null;
    try {
        const checkpoint = JSON.parse(value) as unknown;
        return isPublicationCheckpoint(checkpoint) ? checkpoint : null;
    } catch {
        return null;
    }
}
