/**
 * An issue job the worker refused for disk pressure until its wait for free
 * space ran out (`issueDiskPressureDeferral.ts`): the refused attempt never
 * reached its processor, so nothing told the issue. This ends the issue's
 * dispatch, posts one comment that says what stopped the run and how to retry,
 * and, for the plan issue that points at this dispatch only, takes it out of
 * `processing` (back to `pending`, with its queued execution blocked on the
 * reason), so `get_plan` and the Studio show it.
 *
 * A refused top-level job ends its dispatch. Either refusal releases the plan
 * issue only once the issue's run has ended: the issue's current dispatch has
 * ended (its dispatcher neither runs nor will run again) and the queue holds
 * no other job of the issue that may still start, such as an execution child
 * the dispatcher queued before it failed, or a sibling still waiting, delayed
 * or running. The current dispatch answers for a refused child whose own
 * dispatch a newer one replaced on the row: the newer dispatcher's add of the
 * same execution deduplicated against this child (child job IDs are
 * deterministic), so the child carries the older dispatch ID but is the newer
 * dispatch's execution too. A top-level job whose dispatch a newer request
 * took over is not the issue's run: it is not reported.
 *
 * What the report says comes from the dispatch row alone: "nothing was
 * changed" only when no attempt of the dispatch ever entered its processor
 * (`started_at` is null). Best effort: never throws.
 */
import type { Knex } from 'knex';
import { db } from '../db/connection.js';
import logger from '../utils/logger.js';
import { worktreeDiskPressureDetails } from '../storage/lifecycle.js';
import { PlanIssueStatus, publishPlanIssueActivity } from '../config/planIssueManager.js';
import { notifyEpicQueue, updatePlanIssuesWithStatusJournal } from '../config/planIssueStatusJournal.js';
import { diskPressureRefusedReason, markEpicQueueIssueDispatchRefused } from './taskPlanning/epicQueueBlockedHead.js';
import { findIssueDispatch, findIssueDispatchById, settleIssueDispatch, type IssueDispatch } from '../queue/issueDispatch.js';
import { ISSUE_JOB_NAME } from '../queue/issueDiskPressureDeferral.js';

export interface DiskPressureRefusalOctokit {
    request(route: string, params: Record<string, unknown>): Promise<unknown>;
}

export interface RefusedIssueJob {
    id?: string;
    data: {
        repoOwner?: string; repoName?: string; number?: number; triggeringLabel?: string; correlationId?: string;
        diskPressureDeferrals?: number; diskPressureSince?: number; diskPressureDetails?: string;
        issueDispatchId?: string; isChildJob?: boolean;
    };
}

export interface DiskPressureRefusalOutcome {
    commented: boolean;
    /** This refusal ended the issue's dispatch (it was still queued, deferred or processing). */
    dispatchEnded: boolean;
    /** The plan issue pointing at this dispatch was taken out of `processing`. */
    planIssueReleased: boolean;
    /** The plan's active execution now shows the issue as blocked. */
    queueBlocked: boolean;
}

/** Whether an attempt of the dispatch ran, as its row records it; unknown without a row. */
export type DispatchStart = 'never' | 'started' | 'unknown';

export function dispatchStart(dispatch: Pick<IssueDispatch, 'started_at'> | null): DispatchStart {
    if (!dispatch) return 'unknown';
    return dispatch.started_at === null || dispatch.started_at === undefined ? 'never' : 'started';
}

function waitedText(job: RefusedIssueJob, now: number): string {
    const since = job.data.diskPressureSince;
    if (typeof since !== 'number') return '';
    const minutes = Math.max(1, Math.round((now - since) / 60_000));
    return ` It waited about ${minutes} minute${minutes === 1 ? '' : 's'} for space to be freed, then gave up.`;
}

/** What admission measured at the final refusal (from the error), or at the latest recorded one. */
export function refusalDetails(job: RefusedIssueJob, error?: unknown, dispatch?: Pick<IssueDispatch, 'details'> | null): string | null {
    return worktreeDiskPressureDetails(error)
        ?? (typeof job.data.diskPressureDetails === 'string' ? job.data.diskPressureDetails : null)
        ?? dispatch?.details ?? null;
}

export function diskPressureRefusalCommentBody(
    job: RefusedIssueJob,
    { inPlan, start, now = Date.now(), details = null }: { inPlan: boolean; start: DispatchStart; now?: number; details?: string | null },
): string {
    const label = job.data.triggeringLabel || 'AI';
    const waited = waitedText(job, now);
    const lead = start === 'never'
        ? [
            '❌ **ProPR could not start on this issue: the worker had no free disk space.**',
            '',
            `The ProPR worker refused to start this issue because the disk that holds its working copies is nearly full.${waited}`
                + ' No attempt of this run started, so nothing was changed.',
        ]
        : [
            '❌ **ProPR stopped retrying this issue: the worker had no free disk space.**',
            '',
            'The latest attempt was refused because the disk that holds the worker\'s working copies is nearly full'
                + (start === 'started' ? ', after earlier attempts of this run had already run.' : '; ProPR has no record of whether earlier attempts of this run ran.')
                + waited,
        ];
    return [
        ...lead,
        '',
        ...(details ? ['Measured at the last refusal:', '', '```', details, '```', ''] : []),
        `To run it again once space has been freed on the worker host, remove the \`${label}\` label from this issue and add it again`
            + (inPlan ? ', or retry the issue from its plan.' : '.'),
    ].join('\n');
}

type Log = { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };

/** The issue queue, as far as finding an issue's jobs still in flight needs it. */
export interface RefusalIssueQueue {
    getJobs(states: Array<'waiting' | 'delayed' | 'active' | 'prioritized' | 'waiting-children'>): Promise<Array<{ id?: string; name?: string; data?: unknown } | undefined>>;
}

const IN_FLIGHT_STATES: Array<'waiting' | 'delayed' | 'active' | 'prioritized' | 'waiting-children'> = ['waiting', 'delayed', 'active', 'prioritized', 'waiting-children'];

type IssueJobRef = { repoOwner?: unknown; repoName?: unknown; number?: unknown };

/** Whether `other` is an issue job of the same issue as `job` (owner and repository names are case-insensitive). */
function isJobOfIssue(other: { name?: string; data?: unknown }, job: RefusedIssueJob): boolean {
    if (typeof other.name === 'string' && other.name !== ISSUE_JOB_NAME) return false;
    const data = other.data as IssueJobRef | undefined;
    return typeof data?.repoOwner === 'string' && typeof data.repoName === 'string' && data.number === job.data.number
        && `${data.repoOwner}/${data.repoName}`.toLowerCase() === `${job.data.repoOwner}/${job.data.repoName}`.toLowerCase();
}

/**
 * Whether the refused job was the issue's last execution in flight: the
 * issue's current dispatch has ended (its dispatcher neither runs nor will run
 * again) and the queue holds no other job of the issue that may still start,
 * whichever dispatch it carries. Unknown (the queue could not be read) counts
 * as in flight, so the plan issue is left as it is.
 */
async function wasLastInFlight(
    job: RefusedIssueJob, current: IssueDispatch, { issueQueue, log }: { issueQueue?: RefusalIssueQueue; log: Log },
): Promise<boolean> {
    if (current.state !== 'completed' && current.state !== 'failed') return false;
    try {
        const queue = issueQueue ?? await (await import('../queue/taskQueue.js')).getIssueQueue();
        const live = (await queue.getJobs(IN_FLIGHT_STATES)).filter(other => other && other.id !== job.id && isJobOfIssue(other, job));
        if (live.length > 0) {
            log.info({ jobId: job.id, dispatchId: current.dispatch_id, inFlight: live.map(other => other!.id) },
                'A refused issue job leaves its plan issue to the executions of the issue still in flight');
        }
        return live.length === 0;
    } catch (error) {
        log.warn({ jobId: job.id, dispatchId: current.dispatch_id, error: (error as Error).message },
            'Could not read the issue queue for executions still in flight; the plan issue is left as it is');
        return false;
    }
}

/**
 * The plan issue that points at this dispatch, back to pending, while it is
 * still pending or processing. Called only once this refusal ended the
 * issue's run (no execution of the issue is left in flight) with the issue's
 * current dispatch, so a plan issue a newer dispatch took over since (it
 * points at that one) and historical or finished plan issues keep their status.
 */
async function releasePlanIssue(
    database: Knex, dispatchId: string, issueNumber: number, { now, log }: { now: () => number; log: Log },
): Promise<{ released: boolean; queueBlocked: boolean }> {
    const linked = await database('plan_issues').where({ issue_dispatch_id: dispatchId })
        .whereIn('status', [PlanIssueStatus.PENDING, PlanIssueStatus.PROCESSING]).first('id', 'draft_id', 'repository');
    if (!linked?.draft_id) return { released: false, queueBlocked: false };
    const draftId = linked.draft_id as string;
    const released = await updatePlanIssuesWithStatusJournal(
        rows => rows.where({ id: linked.id, issue_dispatch_id: dispatchId }).whereIn('status', [PlanIssueStatus.PENDING, PlanIssueStatus.PROCESSING]),
        { status: PlanIssueStatus.PENDING, updated_at: database.fn.now() }, PlanIssueStatus.PENDING,
    ) > 0;
    if (!released) return { released, queueBlocked: false };
    // Blocked with a renewed claim: once the issue is pending again, the recovery sweep must not dispatch it again at once.
    const queueBlocked = await markEpicQueueIssueDispatchRefused({ draftId, issueNumber, reason: diskPressureRefusedReason(issueNumber) }, { database, now })
        .catch(error => { log.warn({ draftId, issueNumber, error: (error as Error).message }, 'Could not block the epic execution queue issue'); return false; });
    // Follow-on effects of the status change, for this row's draft only; best effort, the release stands.
    try {
        await notifyEpicQueue(draftId, issueNumber, PlanIssueStatus.PENDING);
        await (await import('./taskPlanningService.js')).checkAndUpdateDraftStatus(draftId);
        await publishPlanIssueActivity(linked.repository as string, draftId, PlanIssueStatus.PENDING);
    } catch (error) {
        log.warn({ draftId, issueNumber, error: (error as Error).message }, 'Could not propagate the release of a refused plan issue');
    }
    return { released, queueBlocked };
}

interface SettleContext { database: Knex; now: () => number; error?: unknown; issueQueue?: RefusalIssueQueue; log: Log; outcome: DiskPressureRefusalOutcome }

/**
 * The refusal on the issue's dispatch and its plan issue, recorded on
 * `outcome`. `superseded` when a newer request took the issue over from this
 * top-level job's dispatch: rows are only ever replaced, so no row under the
 * dispatch says so. A refused child whose dispatch was replaced answers to
 * the dispatch now on the row instead (see the module comment).
 */
async function settleRefusedDispatch(
    job: RefusedIssueJob, dispatchId: string, issue: { owner: string; repo: string; number: number },
    { database, now, error, issueQueue, log, outcome }: SettleContext,
): Promise<{ dispatch: IssueDispatch | null; inPlan: boolean; superseded: boolean }> {
    const child = Boolean(job.data.isChildJob);
    // Only the top-level job moves its dispatch; a refused child reports on the dispatch as it stands.
    if (!child) {
        outcome.dispatchEnded = await settleIssueDispatch(dispatchId, 'failed', {
            database, now, error: error instanceof Error ? error.message : undefined, details: refusalDetails(job, error),
        });
    }
    const dispatch = await findIssueDispatchById(dispatchId, { database });
    if (!dispatch && !child) return { dispatch, inPlan: false, superseded: true };
    // Read after the top-level settle above, so a parent's own dispatch is seen ended.
    const current = dispatch ?? await findIssueDispatch(issue, { database });
    // The plan issue pointing at the current dispatch is released only when the refusal ended the issue's run.
    const runEnded = current !== null && (child || outcome.dispatchEnded) && await wasLastInFlight(job, current, { issueQueue, log });
    if (runEnded) {
        const plan = await releasePlanIssue(database, current.dispatch_id, issue.number, { now, log });
        outcome.planIssueReleased = plan.released;
        outcome.queueBlocked = plan.queueBlocked;
    }
    const inPlan = Boolean(await database('plan_issues').where({ issue_dispatch_id: current?.dispatch_id ?? dispatchId }).first('id'));
    return { dispatch, inPlan, superseded: false };
}

export async function reportIssueDiskPressureRefusal(
    job: RefusedIssueJob,
    { octokit, database = db, now = Date.now, error, issueQueue }: {
        octokit?: DiskPressureRefusalOctokit; database?: Knex; now?: () => number; error?: unknown; issueQueue?: RefusalIssueQueue;
    } = {},
): Promise<DiskPressureRefusalOutcome> {
    const { repoOwner, repoName, number, issueDispatchId } = job.data;
    const log = job.data.correlationId ? logger.withCorrelation(job.data.correlationId) : logger;
    const outcome: DiskPressureRefusalOutcome = { commented: false, dispatchEnded: false, planIssueReleased: false, queueBlocked: false };
    if (!repoOwner || !repoName || typeof number !== 'number') return outcome;
    const repository = `${repoOwner}/${repoName}`;
    const target = { jobId: job.id, repository, issueNumber: number, dispatchId: issueDispatchId ?? null };
    let dispatch: IssueDispatch | null = null;
    let inPlan = false;
    try {
        if (issueDispatchId) {
            const settled = await settleRefusedDispatch(job, issueDispatchId, { owner: repoOwner, repo: repoName, number }, { database, now, error, issueQueue, log, outcome });
            if (settled.superseded) {
                log.warn(target, 'An issue job refused for disk pressure belongs to a dispatch a newer request took over; not reporting it');
                return outcome;
            }
            ({ dispatch, inPlan } = settled);
        }
    } catch (failure) {
        log.warn({ ...target, error: (failure as Error).message }, 'Could not settle the dispatch of an issue job refused for disk pressure');
    }
    const details = refusalDetails(job, error, dispatch);
    const start = dispatchStart(dispatch);
    try {
        const client = octokit ?? await (await import('../auth/githubAuth.js')).getAuthenticatedOctokit();
        await client.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner: repoOwner, repo: repoName, issue_number: number, body: diskPressureRefusalCommentBody(job, { inPlan, start, now: now(), details }),
        });
        outcome.commented = true;
    } catch (failure) {
        log.warn({ ...target, error: (failure as Error).message }, 'Failed to report an issue job refused for disk pressure on the issue');
    }
    log.warn({ ...target, start, ...outcome, ...(details ? { diskPressureDetails: details } : {}) },
        `Reported an issue job refused for disk pressure${details ? ` (${details})` : ''}`);
    return outcome;
}
