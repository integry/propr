/**
 * Issue jobs use one job ID per issue (`issue-<owner>-<repo>-<number>`), so
 * BullMQ deduplicates a second request while the first is still queued. It
 * also deduplicates against a job that has already finished but is still
 * retained (failed or completed, e.g. waiting for its removal), and then the
 * request is swallowed without a trace. A finished job is no reason not to run
 * the issue again: it is removed and the new job added. A job that is still
 * live (waiting, delayed, active) keeps the request, and that is logged.
 */
import logger from '../utils/logger.js';

type EnqueueLog = { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };

const FINISHED_STATES = new Set(['failed', 'completed']);

interface EnqueueQueue<D> {
    add(name: string, data: D, opts: { jobId: string } & Record<string, unknown>): Promise<unknown>;
    getJob?(jobId: string): Promise<{ getState(): Promise<string>; remove(): Promise<void> } | undefined | null>;
}

export type IssueJobEnqueueOutcome =
    | { status: 'added'; replaced?: 'failed' | 'completed' }
    | { status: 'already_queued'; state: string };

export async function enqueueIssueJobReplacingFinished<D extends object>(
    queue: EnqueueQueue<D>,
    { name, data, opts }: { name: string; data: D; opts: { jobId: string } & Record<string, unknown> },
    log: EnqueueLog = logger,
): Promise<IssueJobEnqueueOutcome> {
    const { jobId } = opts;
    let replaced: 'failed' | 'completed' | undefined;
    // Test doubles of the queue may implement only `add`.
    const existing = typeof queue.getJob === 'function' ? await queue.getJob(jobId) : undefined;
    if (existing) {
        const state = await existing.getState();
        if (!FINISHED_STATES.has(state)) {
            log.info({ jobId, state }, 'An issue job with this ID is still queued or running; the new request is served by it');
            return { status: 'already_queued', state };
        }
        try {
            await existing.remove();
            replaced = state as 'failed' | 'completed';
            log.info({ jobId, state }, 'Removed the finished issue job retained under this ID so the issue can run again');
        } catch (error) {
            // Removed meanwhile (its retention ran out) or locked: the add below decides.
            log.warn({ jobId, state, error: (error as Error).message }, 'Could not remove the finished issue job retained under this ID');
        }
    }
    await queue.add(name, data, opts);
    return replaced ? { status: 'added', replaced } : { status: 'added' };
}
