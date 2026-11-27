/**
 * An issue job the worker refused for disk pressure until its wait for free
 * space ran out (`issueDiskPressureDeferral.ts`) never reached its processor:
 * no task, no comment, no label change. Without this the issue looks ignored
 * and its plan keeps reporting it as in progress. This posts one comment that
 * says what stopped the run and how to retry, and takes the plan issue out of
 * `processing` (back to `pending`, with its queued execution blocked on the
 * reason), so `get_plan` and the Studio show it. Best effort: never throws.
 */
import type { Knex } from 'knex';
import { db } from '../db/connection.js';
import logger from '../utils/logger.js';
import { PlanIssueStatus, findPlanIssueByRepoAndNumber, updatePlanIssueStatus } from '../config/planIssueManager.js';
import { diskPressureRefusedReason, markEpicQueueIssueDispatchRefused } from './taskPlanning/epicQueueBlockedHead.js';

export interface DiskPressureRefusalOctokit {
    request(route: string, params: Record<string, unknown>): Promise<unknown>;
}

export interface RefusedIssueJob {
    id?: string;
    data: {
        repoOwner?: string; repoName?: string; number?: number; triggeringLabel?: string; correlationId?: string;
        diskPressureDeferrals?: number; diskPressureSince?: number;
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

export function diskPressureRefusalCommentBody(job: RefusedIssueJob, { inPlan, now = Date.now() }: { inPlan: boolean; now?: number }): string {
    const label = job.data.triggeringLabel || 'AI';
    return [
        '❌ **ProPR could not start on this issue: the worker had no free disk space.**',
        '',
        'The ProPR worker refused to start this issue because the disk that holds its working copies is nearly full.'
            + `${waitedText(job, now)} Nothing was changed: no branch, commit or pull request was created.`,
        '',
        `To run it again once space has been freed on the worker host, remove the \`${label}\` label from this issue and add it again`
            + (inPlan ? ', or retry the issue from its plan.' : '.'),
    ].join('\n');
}

/** A plan issue refused before any task started: back to pending, unless something else moved it on meanwhile. */
async function releasePlanIssue(
    { database, now }: { database: Knex; now: () => number }, repository: string, issueNumber: number, log: { warn(obj: object, msg: string): void },
): Promise<{ draftId: string | null; released: boolean; queueBlocked: boolean }> {
    const planIssue = await findPlanIssueByRepoAndNumber(repository, issueNumber);
    if (!planIssue?.draft_id) return { draftId: null, released: false, queueBlocked: false };
    const draftId = planIssue.draft_id;
    // Blocked with a renewed claim: once the issue is pending again, the recovery sweep must not dispatch it again at once.
    const queueBlocked = await markEpicQueueIssueDispatchRefused({ draftId, issueNumber, reason: diskPressureRefusedReason(issueNumber) }, { database, now })
        .catch(error => { log.warn({ draftId, issueNumber, error: (error as Error).message }, 'Could not block the epic execution queue issue'); return false; });
    if (planIssue.status !== PlanIssueStatus.PROCESSING) return { draftId, released: false, queueBlocked };
    const stillApplies = async () => {
        const current = await database('plan_issues').where({ id: planIssue.id }).first('status', 'task_id');
        // A task started meanwhile (a later attempt was admitted) owns the status now.
        return current?.status === PlanIssueStatus.PROCESSING && !current.task_id;
    };
    const released = await updatePlanIssueStatus(repository, issueNumber, PlanIssueStatus.PENDING, { stillApplies });
    return { draftId, released, queueBlocked };
}

export async function reportIssueDiskPressureRefusal(
    job: RefusedIssueJob,
    { octokit, database = db, now = Date.now }: { octokit?: DiskPressureRefusalOctokit; database?: Knex; now?: () => number } = {},
): Promise<DiskPressureRefusalOutcome> {
    const { repoOwner, repoName, number } = job.data;
    const log = job.data.correlationId ? logger.withCorrelation(job.data.correlationId) : logger;
    const outcome: DiskPressureRefusalOutcome = { commented: false, planIssueReleased: false, queueBlocked: false };
    if (!repoOwner || !repoName || typeof number !== 'number') return outcome;
    const repository = `${repoOwner}/${repoName}`;
    let inPlan = false;
    try {
        const plan = await releasePlanIssue({ database, now }, repository, number, log);
        inPlan = plan.draftId !== null;
        outcome.planIssueReleased = plan.released;
        outcome.queueBlocked = plan.queueBlocked;
    } catch (error) {
        log.warn({ jobId: job.id, repository, issueNumber: number, error: (error as Error).message }, 'Could not update the plan issue of an issue job refused for disk pressure');
    }
    try {
        const client = octokit ?? await (await import('../auth/githubAuth.js')).getAuthenticatedOctokit();
        await client.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner: repoOwner, repo: repoName, issue_number: number, body: diskPressureRefusalCommentBody(job, { inPlan, now: now() }),
        });
        outcome.commented = true;
    } catch (error) {
        log.error({ jobId: job.id, repository, issueNumber: number, error: (error as Error).message }, 'Failed to report an issue job refused for disk pressure on the issue');
    }
    log.warn({ jobId: job.id, repository, issueNumber: number, ...outcome }, 'Reported an issue job refused for disk pressure');
    return outcome;
}
