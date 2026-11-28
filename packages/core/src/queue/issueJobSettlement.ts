/**
 * The end of an issue job attempt, on the issue's dispatch row
 * (`issueDispatch.ts`). Called from the issue worker's `completed` and
 * `failed` events. Best effort: never throws.
 */
import logger from '../utils/logger.js';
import { isWorktreeDiskPressureError } from '../storage/lifecycle.js';
import { isFinalJobFailure, ISSUE_JOB_NAME, topLevelDispatchId } from './issueDiskPressureDeferral.js';
import type { RefusalIssueQueue } from '../services/issueDiskPressureRefusal.js';

/** Loaded on first use: importing the database opens it, and the queue module must not do that at import. */
const settleIssueDispatch: typeof import('./issueDispatch.js').settleIssueDispatch = async (...args) =>
    (await import('./issueDispatch.js')).settleIssueDispatch(...args);

/**
 * The dispatcher's settlement just ended its dispatch: an execution of the
 * issue refused for disk pressure while the dispatcher still ran left the plan
 * issue to it (`refusal_release` pending), so the plan issue is released now
 * if nothing of the issue is left in flight. Read after the end was written,
 * as the refusal records itself before reading whether the run ended.
 */
async function releaseRefusedExecution(job: SettledJob, dispatchId: string, issueQueue?: RefusalIssueQueue): Promise<void> {
    const dispatch = await (await import('./issueDispatch.js')).findIssueDispatchById(dispatchId);
    if (dispatch?.refusal_release !== 'pending') return;
    const { releaseRefusedRunOnDispatchEnd } = await import('../services/issueDiskPressureRefusal.js');
    await releaseRefusedRunOnDispatchEnd(job as unknown as Parameters<typeof releaseRefusedRunOnDispatchEnd>[0], dispatch, { issueQueue });
}

interface SettledJob {
    id?: string;
    name: string;
    data: unknown;
    attemptsMade: number;
    finishedOn?: number;
    opts?: { attempts?: number };
}

/**
 * A failed attempt of an issue job, on its dispatch row: a retry puts the
 * dispatch back to queued, a final failure ends it. A final disk-pressure
 * refusal never reached its processor, so nothing told the issue or its plan:
 * the refusal report ends a top-level job's dispatch, releases the plan issue
 * once no other job of the issue is in flight, and says what happened, from
 * what the row recorded (`started_at`). Any other final failure of a
 * dispatcher releases the plan issue for an execution refused while it ran. Best effort.
 */
export async function settleIssueJobFailure(
    job: SettledJob | undefined, err: Error,
    { issueQueue }: { issueQueue?: RefusalIssueQueue } = {},
): Promise<void> {
    if (!job || job.name !== ISSUE_JOB_NAME) return;
    const final = isFinalJobFailure(job, err);
    const dispatchId = topLevelDispatchId(job.data);
    try {
        if (final && isWorktreeDiskPressureError(err)) {
            const { reportIssueDiskPressureRefusal } = await import('../services/issueDiskPressureRefusal.js');
            await reportIssueDiskPressureRefusal(job as unknown as Parameters<typeof reportIssueDiskPressureRefusal>[0], { error: err, issueQueue });
        } else if (dispatchId) {
            const ended = await settleIssueDispatch(dispatchId, final ? 'failed' : 'retrying', { error: err.message }) && final;
            if (ended) await releaseRefusedExecution(job, dispatchId, issueQueue);
        }
    } catch (error) {
        logger.warn({ jobId: job.id, dispatchId, error: (error as Error).message }, 'Failed to settle a failed issue job on its dispatch');
    }
}

/** A completed issue job, on its dispatch row; a dispatcher whose completion ends its dispatch also releases the plan issue for an execution refused while it ran. */
export async function settleIssueJobCompletion(job: SettledJob, { issueQueue }: { issueQueue?: RefusalIssueQueue } = {}): Promise<void> {
    const dispatchId = job.name === ISSUE_JOB_NAME ? topLevelDispatchId(job.data) : null;
    if (!dispatchId) return;
    try {
        if (await settleIssueDispatch(dispatchId, 'completed')) await releaseRefusedExecution(job, dispatchId, issueQueue);
    } catch (error) {
        logger.warn({ jobId: job.id, dispatchId, error: (error as Error).message }, 'Failed to settle a completed issue job on its dispatch');
    }
}
