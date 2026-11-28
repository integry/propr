/**
 * An issue job the worker refused for disk pressure until its wait for free
 * space ran out (`issueDiskPressureDeferral.ts`): the refused attempt never
 * reached its processor, so nothing told the issue. This ends the issue's
 * dispatch, posts one comment that says what stopped the run and how to retry,
 * and, for the plan issue that points at this dispatch only, takes it out of
 * `processing` (back to `pending`, with its queued execution blocked on the
 * reason), so `get_plan` and the Studio show it.
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
import { findIssueDispatchById, settleIssueDispatch, type IssueDispatch } from '../queue/issueDispatch.js';

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

/**
 * The plan issue that points at this dispatch, back to pending, while it is
 * still pending or processing. Called only once this refusal ended the
 * dispatch, so a plan issue a newer dispatch took over (it points at that one)
 * and historical or finished plan issues keep their status.
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

export async function reportIssueDiskPressureRefusal(
    job: RefusedIssueJob,
    { octokit, database = db, now = Date.now, error }: { octokit?: DiskPressureRefusalOctokit; database?: Knex; now?: () => number; error?: unknown } = {},
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
            // Only the top-level job moves its dispatch; a refused child reports on the dispatch as it stands.
            if (!job.data.isChildJob) {
                outcome.dispatchEnded = await settleIssueDispatch(issueDispatchId, 'failed', {
                    database, now, error: error instanceof Error ? error.message : undefined, details: refusalDetails(job, error),
                });
            }
            dispatch = await findIssueDispatchById(issueDispatchId, { database });
            if (outcome.dispatchEnded) {
                const plan = await releasePlanIssue(database, issueDispatchId, number, { now, log });
                outcome.planIssueReleased = plan.released;
                outcome.queueBlocked = plan.queueBlocked;
            }
            inPlan = Boolean(await database('plan_issues').where({ issue_dispatch_id: issueDispatchId }).first('id'));
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
