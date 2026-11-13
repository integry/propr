/**
 * Review digest glue for issue and follow-up runs. Job modules load this file
 * lazily, so its @propr/core imports never enter their static module graph.
 */
import { collectReviewDigest, db, getStateManager, getWorktreeChanges, renderReviewDigest, summarizeReviewDigest } from '@propr/core';
import type { FileChange, RepositoryValidationResult, ReviewConfig, ReviewDigest } from '@propr/core';
import type { Logger } from 'pino';

/** The run's diff from its starting commit, including committed and remaining tracked edits. */
export function readRunChanges(worktreePath: string, diffBase: string): Promise<FileChange[]> {
    return getWorktreeChanges(worktreePath, diffBase);
}

/** The `review.digest` timeline event for one run's digest. */
export function reviewDigestEvent(digest: ReviewDigest): { reason: string; metadata: Record<string, unknown> } {
    return { reason: summarizeReviewDigest(digest), metadata: { event: 'review.digest', reviewDigest: digest } };
}

/**
 * Records the digest on the task timeline without changing the task's state.
 * Best effort: a timeline write never fails the run.
 */
export async function recordReviewDigestEvent(
    taskId: string, digest: ReviewDigest, correlatedLogger: Pick<Logger, 'warn'>,
    deps: { database?: typeof db; currentState?: (taskId: string) => Promise<string | undefined> } = {},
): Promise<void> {
    const database = deps.database ?? db;
    try {
        const task = await database('tasks').where({ task_id: taskId }).first('task_id');
        if (!task) return;
        const state = deps.currentState ? await deps.currentState(taskId) : (await getStateManager().getTaskState(taskId))?.state;
        const event = reviewDigestEvent(digest);
        await database('task_history').insert({
            task_id: taskId,
            // Written during publication; it must not read as a lifecycle change.
            state: state ?? 'post_processing',
            timestamp: new Date().toISOString(),
            reason: event.reason,
            metadata: JSON.stringify(event.metadata),
        });
    } catch (error) {
        correlatedLogger.warn({ taskId, error: (error as Error).message }, 'Could not record review digest timeline event');
    }
}

/**
 * Digest of a follow-up commit, recorded on the timeline and rendered for the
 * completion comment. Returns the markdown section; empty without a diff.
 */
export async function buildFollowUpReviewDigest(options: {
    taskId: string;
    worktreePath: string;
    commitHash: string;
    validation?: RepositoryValidationResult;
    review?: ReviewConfig;
    correlatedLogger: Pick<Logger, 'warn'>;
    currentState?: (taskId: string) => Promise<string | undefined>;
    database?: typeof db;
}): Promise<string> {
    const digest = await collectReviewDigest({ worktreePath: options.worktreePath, commitHash: options.commitHash, validation: options.validation, review: options.review });
    if (!digest) return '';
    await recordReviewDigestEvent(options.taskId, digest, options.correlatedLogger, { currentState: options.currentState, database: options.database });
    return renderReviewDigest(digest);
}
