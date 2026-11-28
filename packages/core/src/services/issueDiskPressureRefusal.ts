/**
 * An issue job the worker refused for disk pressure until its wait for free
 * space ran out (`issueDiskPressureDeferral.ts`): the refused attempt never
 * reached its processor, so nothing told the issue. When no earlier attempt
 * was admitted either (`issueJobAdmitted`), the job never started at all: no
 * task, no comment, no label change. Without this the issue looks ignored
 * and its plan keeps reporting it as in progress. This posts one comment that
 * says what stopped the run and how to retry, and takes the plan issue out of
 * `processing` (back to `pending`, with its queued execution blocked on the
 * reason), so `get_plan` and the Studio show it. The plan issue is changed
 * only while it is not finished and is linked to this run: no task owns it
 * yet, or its task is one this job created (same correlation ID). Finished
 * plan issues, historical ones and those another run took over keep their
 * status. Best effort: never throws.
 */
import type { Knex } from 'knex';
import { db } from '../db/connection.js';
import logger from '../utils/logger.js';
import { worktreeDiskPressureDetails } from '../storage/lifecycle.js';
import { PlanIssueStatus, publishPlanIssueActivity } from '../config/planIssueManager.js';
import { notifyEpicQueue, updatePlanIssuesWithStatusJournal } from '../config/planIssueStatusJournal.js';
import { diskPressureRefusedReason, markEpicQueueIssueDispatchRefused } from './taskPlanning/epicQueueBlockedHead.js';

export interface DiskPressureRefusalOctokit {
    request(route: string, params: Record<string, unknown>): Promise<unknown>;
}

export interface RefusedIssueJob {
    id?: string;
    data: {
        repoOwner?: string; repoName?: string; number?: number; triggeringLabel?: string; correlationId?: string;
        diskPressureDeferrals?: number; diskPressureSince?: number; diskPressureDetails?: string;
        /** An earlier attempt passed admission and entered the processor. */
        issueJobAdmitted?: boolean;
    };
}

export interface DiskPressureRefusalOutcome {
    commented: boolean;
    /** The plan issue was taken out of `processing`. */
    planIssueReleased: boolean;
    /** The plan's active execution now shows the issue as blocked. */
    queueBlocked: boolean;
}

function waitedText(job: RefusedIssueJob, now: number): string {
    const since = job.data.diskPressureSince;
    if (typeof since !== 'number') return '';
    const minutes = Math.max(1, Math.round((now - since) / 60_000));
    return ` It waited about ${minutes} minute${minutes === 1 ? '' : 's'} for space to be freed, then gave up.`;
}

/** What admission measured at the final refusal (from the error), or at the latest recorded one. */
export function refusalDetails(job: RefusedIssueJob, error?: unknown): string | null {
    return worktreeDiskPressureDetails(error) ?? (typeof job.data.diskPressureDetails === 'string' ? job.data.diskPressureDetails : null);
}

export function diskPressureRefusalCommentBody(
    job: RefusedIssueJob,
    { inPlan, now = Date.now(), details = null }: { inPlan: boolean; now?: number; details?: string | null },
): string {
    const label = job.data.triggeringLabel || 'AI';
    // Only the absence of an admitted attempt supports saying that the job changed nothing.
    const startedBefore = job.data.issueJobAdmitted === true;
    return [
        ...(startedBefore
            ? [
                '❌ **ProPR stopped retrying this issue: the worker had no free disk space.**',
                '',
                'The latest attempt was refused because the disk that holds the worker\'s working copies is nearly full,'
                    + ` after an earlier attempt of this run had already started.${waitedText(job, now)}`
                    + ' Work from the earlier attempt (a task, a branch, commits or a pull request) may remain.',
            ]
            : [
                '❌ **ProPR could not start on this issue: the worker had no free disk space.**',
                '',
                'The ProPR worker refused to start this issue because the disk that holds its working copies is nearly full.'
                    + `${waitedText(job, now)} No attempt of this run started, so nothing was changed: no branch, commit or pull request was created.`,
            ]),
        '',
        ...(details ? ['Measured at the last refusal:', '', '```', details, '```', ''] : []),
        `To run it again once space has been freed on the worker host, remove the \`${label}\` label from this issue and add it again`
            + (inPlan ? ', or retry the issue from its plan.' : '.'),
    ].join('\n');
}

type Log = { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };

/** Plan issue states a refusal may still change; every other state is finished or owned by later work. */
const NON_TERMINAL = [PlanIssueStatus.PENDING, PlanIssueStatus.PROCESSING];

/**
 * Whether the plan issue is linked to the refused run: no task owns it yet (the run never created one), or its
 * task is one this job created, recognised by the job's correlation ID. A task of another run means that run owns it.
 */
async function isLinkedToRun(database: Knex, planIssue: { task_id?: string | null }, correlationId: string | undefined): Promise<boolean> {
    if (!planIssue.task_id) return true;
    if (!correlationId) return false;
    const task = await database('tasks').where({ task_id: planIssue.task_id }).first('correlation_id');
    return task?.correlation_id === correlationId;
}

/**
 * The plan issue of a refused run: its queued execution blocked on the reason and, while it is `processing`,
 * back to `pending`. Only the newest plan issue of the issue, and only while it is not finished and is linked
 * to this run (`isLinkedToRun`); the update itself is conditioned on the row, status and task read here.
 */
async function releasePlanIssue(
    { database, now, log }: { database: Knex; now: () => number; log: Log }, job: RefusedIssueJob, repository: string, issueNumber: number,
): Promise<{ draftId: string | null; linked: boolean; released: boolean; queueBlocked: boolean }> {
    // Issue numbers can appear in several historical drafts; only the newest plan issue is the issue's current one.
    const planIssue = await database('plan_issues').where({ repository, issue_number: issueNumber })
        .orderBy('created_at', 'desc').orderBy('id', 'desc').first('id', 'draft_id', 'status', 'task_id') as
        { id: number; draft_id: string | null; status: string; task_id: string | null } | undefined;
    if (!planIssue?.draft_id) return { draftId: null, linked: false, released: false, queueBlocked: false };
    const draftId = planIssue.draft_id;
    const target = { draftId, issueNumber, status: planIssue.status, taskId: planIssue.task_id ?? null };
    if (!NON_TERMINAL.includes(planIssue.status as PlanIssueStatus) || !await isLinkedToRun(database, planIssue, job.data.correlationId)) {
        log.info(target, 'The plan issue is finished or not linked to the refused run; its status is left as is');
        return { draftId, linked: false, released: false, queueBlocked: false };
    }
    // Blocked with a renewed claim: once the issue is pending again, the recovery sweep must not dispatch it again at once.
    const queueBlocked = await markEpicQueueIssueDispatchRefused({ draftId, issueNumber, reason: diskPressureRefusedReason(issueNumber) }, { database, now })
        .catch(error => { log.warn({ ...target, error: (error as Error).message }, 'Could not block the epic execution queue issue'); return false; });
    if (planIssue.status !== PlanIssueStatus.PROCESSING) return { draftId, linked: true, released: false, queueBlocked };
    // Only this row, and only while it still is as read: a run that took it over meanwhile owns its status.
    const released = await updatePlanIssuesWithStatusJournal(
        rows => rows.where({ id: planIssue.id, status: PlanIssueStatus.PROCESSING })
            .where(row => planIssue.task_id ? row.where('task_id', planIssue.task_id) : row.whereNull('task_id').orWhere('task_id', '')),
        { status: PlanIssueStatus.PENDING, updated_at: database.fn.now() }, PlanIssueStatus.PENDING,
    ) > 0;
    if (!released) {
        log.info(target, 'The refused plan issue moved on meanwhile; its status is left as is');
        return { draftId, linked: true, released, queueBlocked };
    }
    // Follow-on effects of the status change, for this row's draft only; best effort, the release stands.
    try {
        await notifyEpicQueue(draftId, issueNumber, PlanIssueStatus.PENDING);
        await (await import('./taskPlanningService.js')).checkAndUpdateDraftStatus(draftId);
        await publishPlanIssueActivity(repository, draftId, PlanIssueStatus.PENDING);
    } catch (error) {
        log.warn({ ...target, error: (error as Error).message }, 'Could not propagate the release of a refused plan issue');
    }
    return { draftId, linked: true, released, queueBlocked };
}

export async function reportIssueDiskPressureRefusal(
    job: RefusedIssueJob,
    { octokit, database = db, now = Date.now, error }: { octokit?: DiskPressureRefusalOctokit; database?: Knex; now?: () => number; error?: unknown } = {},
): Promise<DiskPressureRefusalOutcome> {
    const details = refusalDetails(job, error);
    const { repoOwner, repoName, number } = job.data;
    const log = job.data.correlationId ? logger.withCorrelation(job.data.correlationId) : logger;
    const outcome: DiskPressureRefusalOutcome = { commented: false, planIssueReleased: false, queueBlocked: false };
    if (!repoOwner || !repoName || typeof number !== 'number') return outcome;
    const repository = `${repoOwner}/${repoName}`;
    let inPlan = false;
    try {
        const plan = await releasePlanIssue({ database, now, log }, job, repository, number);
        inPlan = plan.draftId !== null;
        outcome.planIssueReleased = plan.released;
        outcome.queueBlocked = plan.queueBlocked;
    } catch (error) {
        log.warn({ jobId: job.id, repository, issueNumber: number, error: (error as Error).message }, 'Could not update the plan issue of an issue job refused for disk pressure');
    }
    try {
        const client = octokit ?? await (await import('../auth/githubAuth.js')).getAuthenticatedOctokit();
        await client.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner: repoOwner, repo: repoName, issue_number: number, body: diskPressureRefusalCommentBody(job, { inPlan, now: now(), details }),
        });
        outcome.commented = true;
    } catch (error) {
        log.error({ jobId: job.id, repository, issueNumber: number, error: (error as Error).message }, 'Failed to report an issue job refused for disk pressure on the issue');
    }
    log.warn({ jobId: job.id, repository, issueNumber: number, ...outcome, ...(details ? { diskPressureDetails: details } : {}) },
        `Reported an issue job refused for disk pressure${details ? ` (${details})` : ''}`);
    return outcome;
}
