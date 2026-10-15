/**
 * Keeps a plan issue's refinement status in step with the follow-up work that
 * actually exists for its pull request.
 *
 * A plan issue enters refinement when a PR comment admits follow-up work. It
 * leaves refinement when that work, and any newer work for the same PR, has
 * finished — whether it pushed a commit, made none, failed or was cancelled.
 * Only the refinement statuses are ever settled, so merged, closed and
 * pre-PR issues are never rewritten by a late task or webhook event.
 */

import type { Knex } from 'knex';
import { db } from '../../db/connection.js';
import logger from '../../utils/logger.js';
import {
    findPlanIssueByRepoAndPR,
    publishPlanIssueActivity,
    PlanIssueStatus,
    type PlanIssue,
} from '../../config/planIssueManager.js';
import { getPendingPrCommentsKey } from '../../utils/constants.js';

/** Statuses that claim follow-up work is still being applied to the issue's PR. */
export const REFINEMENT_PLAN_ISSUE_STATUSES: readonly PlanIssueStatus[] = [
    PlanIssueStatus.IN_REFINEMENT,
    PlanIssueStatus.REFINEMENT_PROCESSING,
];

const TERMINAL_TASK_STATES = ['completed', 'failed', 'cancelled'];
/** Task types whose PR number lives in `tasks.issue_number`. */
const PULL_REQUEST_TASK_TYPES = ['pr-comment', 'review', 'merge_conflict'];
const QUEUE_JOB_STATES = ['waiting', 'delayed', 'prioritized', 'waiting-children', 'active'] as const;

export interface QueuedJobSnapshot {
    id?: string | null;
    data: unknown;
    /** BullMQ state the job was listed under. */
    state: string;
    /** When the job's current attempt started running (BullMQ `processedOn`, epoch ms). */
    processedOn?: number | null;
}

/** Sources of follow-up work outside the tasks table, injectable for tests. */
export interface RefinementActivitySources {
    listQueuedJobs?: () => Promise<QueuedJobSnapshot[]>;
    countPendingComments?: (repository: string, prNumber: number) => Promise<number>;
}

async function checkAndUpdateDraftStatus(draftId: string): Promise<void> {
    const { checkAndUpdateDraftStatus: update } = await import('./draftStatus.js');
    await update(draftId);
}

/**
 * Returns plan issues whose follow-up work has finished to under_review.
 *
 * The write is conditional on the issue still being in refinement, so a merge,
 * close or any other transition recorded meanwhile is never overwritten. The
 * PR link, follow-up count and task link are left untouched.
 *
 * @returns The issues that were settled
 */
export async function settlePlanIssueRefinement(ids: number[]): Promise<PlanIssue[]> {
    const settled: PlanIssue[] = [];
    for (const id of ids) {
        const count = await db('plan_issues')
            .where({ id })
            .whereIn('status', REFINEMENT_PLAN_ISSUE_STATUSES)
            .update({ status: PlanIssueStatus.UNDER_REVIEW, updated_at: db.fn.now() });
        const issue = count > 0 ? await db('plan_issues').where({ id }).first() as PlanIssue | undefined : undefined;
        if (issue) settled.push(issue);
    }
    for (const draftId of new Set(settled.map(issue => issue.draft_id))) await checkAndUpdateDraftStatus(draftId);
    for (const issue of settled) {
        logger.info({ draftId: issue.draft_id, issueNumber: issue.issue_number, prNumber: issue.pr_number },
            'Settled plan issue refinement: no follow-up work remains');
        await publishPlanIssueActivity(issue.repository, String(issue.id), PlanIssueStatus.UNDER_REVIEW);
    }
    return settled;
}

/**
 * Marks the plan issue linked to a PR as refining once follow-up work was admitted.
 * Only an issue whose PR awaits review moves; refinement already in progress,
 * terminal and pre-PR statuses are kept.
 */
export async function markPlanIssueRefining(repository: string, prNumber: number): Promise<boolean> {
    const planIssue = await findPlanIssueByRepoAndPR(repository, prNumber);
    if (!planIssue) return false;
    const count = await db('plan_issues')
        .where({ id: planIssue.id, status: PlanIssueStatus.UNDER_REVIEW })
        .update({ status: PlanIssueStatus.IN_REFINEMENT, updated_at: db.fn.now() });
    if (count === 0) return false;
    await checkAndUpdateDraftStatus(planIssue.draft_id);
    await publishPlanIssueActivity(repository, String(planIssue.id), PlanIssueStatus.IN_REFINEMENT);
    return true;
}

async function listIssueQueueJobs(): Promise<QueuedJobSnapshot[]> {
    const { getIssueQueue } = await import('../../queue/taskQueue.js');
    const queue = await getIssueQueue();
    const jobs: QueuedJobSnapshot[] = [];
    for (const state of QUEUE_JOB_STATES) {
        for (const job of await queue.getJobs([state])) {
            if (job) jobs.push({ id: job.id ?? null, data: job.data, state, processedOn: job.processedOn ?? null });
        }
    }
    return jobs;
}

async function countRedisPendingComments(repository: string, prNumber: number): Promise<number> {
    const { getUltrafixStateRedis } = await import('../../webhook/checkRunHelpers.js');
    const [owner, repo] = repository.split('/');
    return getUltrafixStateRedis().llen(getPendingPrCommentsKey(owner, repo, prNumber));
}

function jobPullRequest(data: unknown): { repository: string; prNumber: number } | null {
    if (!data || typeof data !== 'object') return null;
    const job = data as Record<string, unknown>;
    const repository = typeof job.repository === 'string'
        ? job.repository
        : typeof job.repoOwner === 'string' && typeof job.repoName === 'string' ? `${job.repoOwner}/${job.repoName}` : null;
    const prNumber = typeof job.prNumber === 'number'
        ? job.prNumber
        : typeof job.pullRequestNumber === 'number' ? job.pullRequestNumber : null;
    return repository && prNumber !== null ? { repository, prNumber } : null;
}

function latestTaskState(this: Knex.JoinClause): void {
    this.on('tasks.task_id', '=', 'task_history.task_id')
        .andOn('task_history.history_id', '=', db.raw('(SELECT MAX(th2.history_id) FROM task_history th2 WHERE th2.task_id = tasks.task_id)'));
}

const isPullRequestTaskRow = (row: { task_type: string; task_id: string }): boolean =>
    PULL_REQUEST_TASK_TYPES.includes(row.task_type) || /^pr-comments?-/.test(row.task_id);

/** PRs with a task whose latest state is not terminal. */
async function pullRequestsWithOpenTasks(repository: string, wanted: Set<number>): Promise<Set<number>> {
    const prNumbers = [...wanted];
    const rows = await db('tasks')
        .select('tasks.issue_number', 'tasks.pr_number', 'tasks.task_type', 'tasks.task_id')
        .join('task_history', latestTaskState)
        .where('tasks.repository', repository)
        .where(scope => scope
            .where(prTask => prTask
                .whereIn('tasks.issue_number', prNumbers)
                .where(kind => kind
                    .whereIn('tasks.task_type', PULL_REQUEST_TASK_TYPES)
                    .orWhere('tasks.task_id', 'like', 'pr-comment-%')
                    .orWhere('tasks.task_id', 'like', 'pr-comments-%')))
            .orWhereIn('tasks.pr_number', prNumbers))
        .whereNotIn('task_history.state', TERMINAL_TASK_STATES) as Array<{ issue_number: number | null; pr_number: number | null; task_type: string; task_id: string }>;
    const active = new Set<number>();
    for (const row of rows) {
        if (row.pr_number !== null && wanted.has(row.pr_number)) active.add(row.pr_number);
        if (isPullRequestTaskRow(row) && row.issue_number !== null && wanted.has(row.issue_number)) active.add(row.issue_number);
    }
    return active;
}

/** Epoch ms of a stored history timestamp; SQLite's default timestamps carry no zone and are UTC. */
function historyTime(value: unknown): number {
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number') return value;
    if (typeof value !== 'string') return Number.NaN;
    return Date.parse(/(Z|[+-]\d\d:?\d\d)$/.test(value) ? value : `${value.replace(' ', 'T')}Z`);
}

/**
 * PRs with a waiting, delayed or running job. A job still listed as active
 * whose task already finished is the attempt that is wrapping up, not newer
 * work, unless that attempt started after the task finished: then it is a
 * BullMQ retry that resumed processing after a recorded failure.
 */
async function pullRequestsWithQueuedJobs(repository: string, wanted: Set<number>, listQueuedJobs: () => Promise<QueuedJobSnapshot[]>): Promise<Set<number>> {
    const active = new Set<number>();
    const runningJobs = new Map<string, { prNumber: number; processedOn: number | null }>();
    const target = repository.toLowerCase();
    for (const job of await listQueuedJobs()) {
        const pr = jobPullRequest(job.data);
        if (!pr || pr.repository.toLowerCase() !== target || !wanted.has(pr.prNumber)) continue;
        if (job.state === 'active' && job.id) runningJobs.set(String(job.id), { prNumber: pr.prNumber, processedOn: job.processedOn ?? null });
        else active.add(pr.prNumber);
    }
    if (runningJobs.size === 0) return active;
    const finishedAt = new Map((await db('tasks')
        .select('tasks.job_id', 'task_history.timestamp')
        .join('task_history', latestTaskState)
        .whereIn('tasks.job_id', [...runningJobs.keys()])
        .whereIn('task_history.state', TERMINAL_TASK_STATES) as Array<{ job_id: string; timestamp: unknown }>)
        .map(row => [row.job_id, historyTime(row.timestamp)]));
    for (const [jobId, { prNumber, processedOn }] of runningJobs) {
        const finished = finishedAt.get(jobId);
        if (finished === undefined || (processedOn !== null && processedOn > finished)) active.add(prNumber);
    }
    return active;
}

/**
 * Pull requests among `prNumbers` that still have follow-up work: a task that
 * has not reached a terminal state, a queued or running job, or comments
 * waiting for the running task.
 *
 * Throws when a source cannot be read, so callers keep the current status
 * instead of settling work they could not verify.
 */
export async function findPullRequestsWithFollowUpWork(
    repository: string,
    prNumbers: number[],
    sources: RefinementActivitySources = {},
): Promise<Set<number>> {
    const wanted = new Set(prNumbers);
    if (wanted.size === 0) return new Set();
    const active = await pullRequestsWithOpenTasks(repository, wanted);
    const remaining = new Set([...wanted].filter(prNumber => !active.has(prNumber)));
    if (remaining.size > 0) {
        for (const prNumber of await pullRequestsWithQueuedJobs(repository, remaining, sources.listQueuedJobs ?? listIssueQueueJobs)) active.add(prNumber);
    }
    const countPending = sources.countPendingComments ?? countRedisPendingComments;
    for (const prNumber of remaining) {
        if (!active.has(prNumber) && await countPending(repository, prNumber) > 0) active.add(prNumber);
    }
    return active;
}

type RefinementCandidate = Pick<PlanIssue, 'id' | 'repository' | 'pr_number' | 'status'>;

const isRefining = (issue: RefinementCandidate): boolean =>
    REFINEMENT_PLAN_ISSUE_STATUSES.includes(issue.status) && issue.pr_number !== null;

/**
 * Settles every refining issue in `issues` whose PR has no follow-up work left
 * and returns the list with those issues shown as under_review.
 *
 * This is the read-path recovery for issues left refining by an earlier
 * version or by a task that ended outside the normal lifecycle. It touches
 * only the given issues, does nothing when none of them is refining, and once
 * settled an issue is no longer a candidate.
 */
export async function reconcilePlanIssueRefinement<T extends RefinementCandidate>(
    issues: T[],
    sources: RefinementActivitySources = {},
): Promise<T[]> {
    const candidates = issues.filter(isRefining);
    if (candidates.length === 0) return issues;
    const byRepository = new Map<string, T[]>();
    for (const issue of candidates) byRepository.set(issue.repository, [...(byRepository.get(issue.repository) ?? []), issue]);

    const idleIds: number[] = [];
    for (const [repository, repositoryIssues] of byRepository) {
        try {
            const active = await findPullRequestsWithFollowUpWork(repository, repositoryIssues.map(issue => issue.pr_number!), sources);
            const idle = repositoryIssues.filter(issue => !active.has(issue.pr_number!));
            idleIds.push(...idle.map(issue => issue.id));
            await settleIdlePlanIssues(repository, idle, sources);
        } catch (error) {
            logger.warn({ repository, error: (error as Error).message }, 'Could not verify plan refinement activity; keeping current status');
        }
    }
    if (idleIds.length === 0) return issues;
    // Settlement may have been undone for work admitted meanwhile, so report what is stored.
    const stored = new Map((await db('plan_issues').whereIn('id', idleIds).select('id', 'status') as Array<Pick<PlanIssue, 'id' | 'status'>>)
        .map(row => [row.id, row.status]));
    return issues.map(issue => {
        const status = stored.get(issue.id);
        return status && status !== issue.status ? { ...issue, status } : issue;
    });
}

/**
 * Settles issues whose follow-up work was found finished, then looks once more.
 *
 * Work admitted while the idle result was being read cannot mark an issue that
 * is still refining, so its admission leaves no trace for the settlement to
 * see. Work admitted before the settlement write is visible to the recheck,
 * which restores refinement through the same conditional marking and settles
 * again if that work finished before the restore was written; work admitted
 * after the write finds the issue under review and marks it itself.
 * A recheck that cannot be read restores refinement too, keeping the status
 * that could not be disproved. Merged and closed issues are never touched.
 */
async function settleIdlePlanIssues(repository: string, issues: RefinementCandidate[], sources: RefinementActivitySources): Promise<void> {
    const settled = await settlePlanIssueRefinement(issues.map(issue => issue.id));
    if (settled.length === 0) return;
    let active: Set<number> | null = null;
    try {
        active = await findPullRequestsWithFollowUpWork(repository, settled.map(issue => issue.pr_number!), sources);
    } catch (error) {
        logger.warn({ repository, error: (error as Error).message }, 'Could not recheck plan refinement activity; restoring refinement');
    }
    for (const issue of settled) {
        if (active && !active.has(issue.pr_number!)) continue;
        logger.info({ draftId: issue.draft_id, issueNumber: issue.issue_number, prNumber: issue.pr_number },
            'Follow-up work was admitted while settling plan refinement; restoring refinement');
        if (active) await restorePlanIssueRefinement(repository, issue.pr_number!, sources);
        else await markPlanIssueRefining(repository, issue.pr_number!);
    }
}

/**
 * Marks the issue refining for work that was seen, then settles it again if
 * that work has finished meanwhile: its own completion sync ran while the
 * issue was still under review, so it found nothing refining to settle.
 */
async function restorePlanIssueRefinement(repository: string, prNumber: number, sources: RefinementActivitySources): Promise<void> {
    if (!await markPlanIssueRefining(repository, prNumber)) return;
    await settlePlanRefinementForPullRequest(repository, prNumber, sources);
}

/**
 * Reconciles every refining issue of a draft before the caller filters,
 * counts or pages them, so a read never returns issues under a status they
 * were just moved out of.
 */
export async function reconcileDraftPlanIssueRefinement(draftId: string, sources: RefinementActivitySources = {}): Promise<void> {
    const refining = await db('plan_issues')
        .where({ draft_id: draftId })
        .whereIn('status', REFINEMENT_PLAN_ISSUE_STATUSES)
        .whereNotNull('pr_number')
        .select('id', 'repository', 'pr_number', 'status') as RefinementCandidate[];
    await reconcilePlanIssueRefinement(refining, sources);
}

/**
 * Settles the plan issue linked to a PR once no follow-up work remains for it.
 * Called when a PR task finishes.
 *
 * @returns Whether the issue was moved to under_review
 */
export async function settlePlanRefinementForPullRequest(
    repository: string,
    prNumber: number,
    sources: RefinementActivitySources = {},
): Promise<boolean> {
    const issue = await findPlanIssueByRepoAndPR(repository, prNumber);
    if (!issue || !isRefining(issue)) return false;
    const [reconciled] = await reconcilePlanIssueRefinement([issue], sources);
    return reconciled.status === PlanIssueStatus.UNDER_REVIEW;
}

/**
 * Brings the plan issue linked to a PR in line with its follow-up work after a
 * PR comment was handled or a queued job's attempt failed, resumed or completed:
 * refining while work is queued or running, under review once nothing is
 * left. Comments that admitted no work never leave the plan refining.
 */
export async function syncPlanRefinementForPullRequest(
    repository: string,
    prNumber: number,
    sources: RefinementActivitySources = {},
): Promise<void> {
    const issue = await findPlanIssueByRepoAndPR(repository, prNumber);
    if (!issue || (issue.status !== PlanIssueStatus.UNDER_REVIEW && !isRefining(issue))) return;
    let active: Set<number>;
    try {
        active = await findPullRequestsWithFollowUpWork(repository, [prNumber], sources);
    } catch (error) {
        logger.warn({ repository, prNumber, error: (error as Error).message }, 'Could not verify plan refinement activity; keeping current status');
        return;
    }
    if (!active.has(prNumber)) {
        if (isRefining(issue)) await settleIdlePlanIssues(repository, [issue], sources);
        return;
    }
    await restorePlanIssueRefinement(repository, prNumber, sources);
}

/** {@link syncPlanRefinementForPullRequest} for the PR a queued job works on, if any. */
export async function syncPlanRefinementForJob(data: unknown, sources: RefinementActivitySources = {}): Promise<void> {
    const pr = jobPullRequest(data);
    if (pr) await syncPlanRefinementForPullRequest(pr.repository, pr.prNumber, sources);
}
