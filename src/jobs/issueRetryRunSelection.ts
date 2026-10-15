import {
    logger, acceptedRunTrigger,
    type IssueJobData, type IssueRetryRequest, type RetryRun, type RetryRunReceipt, type SubmissionRetry, type RunReceiptFence,
} from '@propr/core';
import type { DispatcherDeps, Submission } from './issueJobDispatcher.js';

/**
 * The run the delivery dispatches. The open request is selected by the same
 * rules for a direct job and a recovering relabel or poll: only on its own
 * admitted trigger, so a newer, independent trigger runs a request still owed
 * a run instead of stranding it. Without one, the delivery's latest trigger,
 * read from the same history, runs without any request.
 */
async function resolveRun(
    issueRef: IssueJobData,
    submission: Submission,
    deps: DispatcherDeps,
): Promise<{ run: RetryRun; trigger: SubmissionRetry | null }> {
    if (submission) [issueRef.repoOwner, issueRef.repoName] = submission.repository.split('/');
    const run: RetryRun = deps.retryRequests ? await deps.retryRequests.select(issueRef, { submission }) : { request: null };
    if ('deferred' in run || !submission) return { run, trigger: null };
    if (run.request) return { run, trigger: { eventId: run.triggerEventId } };
    return { run, trigger: run.trigger !== undefined ? run.trigger : await deps.resolveSubmissionRetry(submission) };
}

/**
 * Whether the job is the one the route queued for the deferred request's
 * current trigger write. The route queues a request's job only once GitHub
 * confirmed that write, so the job is the evidence of the outcome the route
 * could not record; a job of an earlier write of a restarted request is not.
 */
function confirmsPublication(issueRef: IssueJobData, request: IssueRetryRequest): boolean {
    return request.publication === 'pending' && request.commentId !== null && request.publishedAt !== null
        && issueRef.retryCommentId === request.commentId && issueRef.retryRequesterId === request.requesterId
        && issueRef.retryPublishedAt === request.publishedAt;
}

/**
 * The run the delivery dispatches, after recording the outcome of a deferred
 * request's trigger write that the job itself confirms or that the route kept
 * as durable evidence, so any later delivery reconciles it after the route's
 * process or the job carrying it is gone. A refusal releases the request, and
 * the delivery runs without it. A failure to record it fails the dispatch,
 * whose retry or a later delivery reconciles again, with the evidence kept,
 * rather than completing it as deferred for good.
 */
async function resolveConfirmedRun(issueRef: IssueJobData, submission: Submission, deps: DispatcherDeps): ReturnType<typeof resolveRun> {
    const resolved = await resolveRun(issueRef, submission, deps);
    if (!('deferred' in resolved.run) || !deps.retryRequests) return resolved;
    const request = resolved.run.deferred;
    if (request?.publication !== 'pending' || request.publishedAt === null) return resolved;
    const outcome = confirmsPublication(issueRef, request) ? 'possible' : await deps.retryRequests.evidence(issueRef, request);
    if (!outcome) return resolved;
    logger.info({ issue: issueRef.number, retryCommentId: request.commentId, outcome }, 'Recording the retry trigger outcome its publication left');
    await deps.retryRequests.confirm(issueRef, request, outcome);
    return resolveRun(issueRef, submission, deps);
}
/**
 * The fence of the submission's dispatch receipt this dispatch records: the
 * receipt it read when it began, which its selection admitted triggers after.
 */
export function receiptFence(submission: NonNullable<Submission>, deps: DispatcherDeps, fence: Partial<RunReceiptFence> = {}): RunReceiptFence {
    return {
        observedEventId: submission.retry_event_id ?? null,
        history: retained => deps.submissionTriggers ? deps.submissionTriggers(submission, retained) : Promise.reject(new Error('The issue\'s trigger history cannot be read')),
        ...fence,
    };
}

/**
 * Records, in the submission's dispatch receipt, the trigger the queue's
 * record of a request's accepted run names, whichever dispatch accepted it:
 * not a trigger this dispatch's own, possibly stale, selection would have run
 * it on. A receipt that already records it or a later trigger is kept. A
 * receipt that cannot be read, ordered or written fails, so the request is
 * not recorded consumed and its record is not retired.
 */
export async function recordAcceptedRun(submission: NonNullable<Submission>, request: IssueRetryRequest, run: RetryRunReceipt, deps: DispatcherDeps): Promise<void> {
    const fence = receiptFence(submission, deps);
    const { eventId, events } = await acceptedRunTrigger(request, run, fence);
    await deps.recordDispatch(submission.id, eventId, { ...fence, events });
}
/**
 * Records the consumption of requests an earlier dispatch carried into its
 * run, as its receipt of their own triggers or the queue's record of their
 * runs shows, after recording that consumption itself failed; a submission's
 * receipt first records the trigger the run consumed, as the record names it.
 * Selection already owes them nothing, so a failure here is left to a later
 * delivery or follow-up, which settles them on the same records, rather than
 * holding back this delivery.
 */
async function settleCarriedRequests(issueRef: IssueJobData, submission: Submission, run: RetryRun, deps: DispatcherDeps): Promise<void> {
    for (const request of run.carried ?? []) {
        logger.info({ issue: issueRef.number, retryCommentId: request.commentId }, 'Recording the consumption of a retry request an earlier dispatch carried');
        try {
            if (submission && request.run) await recordAcceptedRun(submission, request, request.run, deps);
            await deps.retryRequests?.consume(issueRef, request);
        } catch (error) {
            logger.warn({ issue: issueRef.number, retryCommentId: request.commentId, errMessage: (error as Error).message }, 'Could not record a carried retry request as consumed');
        }
    }
}
// How often a dispatch selects its run again on a dispatch receipt that moved since it read it, before it fails to be retried.
const RECEIPT_SELECTIONS = 3;

/**
 * The run the delivery dispatches, selected on the submission's dispatch
 * receipt as it stands once the requests an earlier dispatch carried are
 * settled. Settling them may record the trigger their run consumed, and
 * another dispatch may record its own meanwhile; a selection made on the
 * receipt read before admits triggers that receipt now covers, so the run is
 * selected again on the receipt read afresh, and none of the stale
 * selection's children are added. That selection admits only triggers a
 * history showing that receipt places after it, so a history read from
 * before it, however the requests that consumed it were settled, defers the
 * delivery rather than run a trigger it covers. An issue-only delivery has no
 * receipt: its selection already ordered the latest trigger against the
 * trigger each carried request's run consumed, which settling them does not
 * change.
 */
export async function resolveCurrentRun(issueRef: IssueJobData, deps: DispatcherDeps): Promise<{ submission: Submission } & Awaited<ReturnType<typeof resolveRun>>> {
    let submission = await deps.findSubmission(issueRef);
    for (let selection = 1; ; selection++) {
        const resolved = await resolveConfirmedRun(issueRef, submission, deps);
        await settleCarriedRequests(issueRef, submission, resolved.run, deps);
        if (!submission) return { submission, ...resolved };
        const current = await deps.findSubmission(issueRef);
        if (!current || (current.retry_event_id === submission.retry_event_id && current.dispatch_complete === submission.dispatch_complete)) {
            return { submission, ...resolved };
        }
        if (selection >= RECEIPT_SELECTIONS) throw new Error(`Submission ${submission.id}'s dispatch receipt kept changing, so no run was selected on it`);
        logger.info({ issue: issueRef.number, receipt: submission.retry_event_id, current: current.retry_event_id }, 'The submission\'s dispatch receipt moved since the run was selected; selecting it again');
        submission = current;
    }
}
