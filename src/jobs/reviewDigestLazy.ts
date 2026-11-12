/**
 * Best-effort review digest steps for job modules. Loads `reviewDigestRun.js`
 * on first use, so this file adds no @propr/core imports to its importers'
 * static module graph, and a digest failure never fails a run.
 */
import type { FileChange, RepositoryValidationResult, ReviewConfig, ReviewDigest } from '@propr/core';
import type { Logger } from 'pino';

type WarnLogger = Pick<Logger, 'warn'>;
type CurrentState = (taskId: string) => Promise<string | undefined>;

/**
 * The issue run's diff from its starting commit. Empty (no digest) without a
 * commit or a pinned starting commit, or when the diff cannot be read.
 */
export async function readReviewDigestChanges(worktreePath: string, diffBase: string | undefined, hasCommit: boolean, correlatedLogger: WarnLogger): Promise<FileChange[]> {
    if (!diffBase || !hasCommit) return [];
    try {
        return await (await import('./reviewDigestRun.js')).readRunChanges(worktreePath, diffBase);
    } catch (error) {
        correlatedLogger.warn({ error: (error as Error).message }, 'Could not read the diff for the review digest');
        return [];
    }
}

/** Records an issue run's digest; nothing without a digest or a task. */
export async function recordReviewDigest(
    taskId: string | undefined, digest: ReviewDigest | null | undefined, correlatedLogger: WarnLogger,
    stateManager?: { getTaskState(taskId: string): Promise<{ state?: string } | null | undefined> },
): Promise<void> {
    if (!taskId || !digest) return;
    const currentState: CurrentState | undefined = stateManager && (async id => (await stateManager.getTaskState(id))?.state);
    try {
        await (await import('./reviewDigestRun.js')).recordReviewDigestEvent(taskId, digest, correlatedLogger, { currentState });
    } catch (error) {
        correlatedLogger.warn({ taskId, error: (error as Error).message }, 'Could not record review digest timeline event');
    }
}

/** The follow-up commit's digest section for the completion comment, recorded on the timeline; empty on failure. */
export async function followUpReviewDigestSection(options: {
    taskId: string;
    worktreePath: string;
    commitHash: string;
    validation?: RepositoryValidationResult;
    review?: ReviewConfig;
    correlatedLogger: WarnLogger;
    currentState?: CurrentState;
}): Promise<string> {
    try {
        return await (await import('./reviewDigestRun.js')).buildFollowUpReviewDigest(options);
    } catch (error) {
        options.correlatedLogger.warn({ taskId: options.taskId, error: (error as Error).message }, 'Could not build the review digest');
        return '';
    }
}
