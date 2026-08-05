import {
    hashTaskAttemptToken,
    type JobResult,
    type TaskStateData,
} from '@propr/core';
import { loadPRCommentRemoteOutcome } from './jobs/prCommentRemoteOutcome.js';

export function taskAgeMs(
    task: TaskStateData,
    now: number,
    futureSkewAllowanceMs: number,
): number {
    const updatedAt = new Date(task.updatedAt).getTime();
    if (!Number.isFinite(updatedAt) || updatedAt > now + futureSkewAllowanceMs) {
        return Number.POSITIVE_INFINITY;
    }
    return Math.max(0, now - updatedAt);
}

export function completedResultMatchesAttempt(task: TaskStateData, result: unknown): boolean {
    if (task.prProcessingLockToken === undefined) return true;
    if (!result || typeof result !== 'object') return false;
    const record = result as {
        prProcessingAttemptGeneration?: unknown;
        prProcessingLockToken?: unknown;
    };
    if (typeof record.prProcessingAttemptGeneration === 'string') {
        return record.prProcessingAttemptGeneration === hashTaskAttemptToken(task.prProcessingLockToken);
    }
    // Accept results produced during a rolling upgrade, but never emit the raw
    // token in new BullMQ return values.
    return record.prProcessingLockToken === task.prProcessingLockToken;
}

export async function loadMatchingPRCommentRemoteOutcome(
    redis: { get?(key: string): Promise<string | null> },
    task: TaskStateData,
): Promise<JobResult | null> {
    if (!redis.get) return null;
    const checkpoint = await loadPRCommentRemoteOutcome(
        { get: key => redis.get!(key) },
        task.taskId,
    );
    return checkpoint && completedResultMatchesAttempt(task, checkpoint) ? checkpoint : null;
}
