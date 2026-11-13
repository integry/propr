import type { Knex } from 'knex';
import type { Redis } from 'ioredis';
import { summarizeCheckSignals } from '../../webhook/checkRunHelpers.js';
import { EPIC_BRANCH_PATTERN } from '../epicPRService.js';
import { loadPullRequestScoreHistory } from '../reviewScoreStore.js';
import logger from '../../utils/logger.js';
import {
    computePullRequestStatus,
    type PullRequestStatus,
    type PullRequestStatusChecks,
    type PullRequestStatusFacts,
    type PullRequestStatusTask,
    type PullRequestStatusUltrafix,
} from './pullRequestStatus.js';

/** The slice of Octokit the status reads use, so MCP can pass the caller's own credential. */
export interface PullRequestStatusGitHub {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    request: (route: string, parameters: Record<string, unknown>) => Promise<{ data: any }>;
}

/** A pull request as GitHub's REST API returns it; only the fields the status reads. */
export interface PullRequestStatusPull {
    state: string;
    merged?: boolean | null;
    mergeable?: boolean | null;
    body?: string | null;
    head: { sha: string; ref: string };
}

export interface PullRequestStatusSources {
    github: PullRequestStatusGitHub;
    db: Knex;
    /** Ultrafix loop state lives in Redis; without it no loop is reported. */
    redis?: Pick<Redis, 'get'> | null;
    loadRatingGoal: () => Promise<number>;
    loadNonBlockingChecks: (owner: string, repo: string) => Promise<string[]>;
    /** BullMQ jobs for the pull request that have not started yet. */
    countQueuedJobs?: (repository: string, prNumber: number) => Promise<number>;
}

const PULL_REQUEST_TASK_TYPES = ['pr-comment', 'review', 'merge_conflict'];
const TASK_LIMIT = 20;
const CHECK_RUN_PAGE = 100;
const MAX_CHECK_RUN_PAGES = 3;

function parseJson(value: unknown): Record<string, unknown> {
    if (value && typeof value === 'object') return value as Record<string, unknown>;
    if (typeof value !== 'string') return {};
    try {
        const parsed: unknown = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    } catch {
        return {};
    }
}

function taskMode(type: string, jobData: Record<string, unknown>): PullRequestStatusTask['mode'] {
    if (type !== 'pr-comment') return null;
    const comments = Array.isArray(jobData.comments) ? jobData.comments as Array<{ commandMode?: unknown }> : [];
    const review = jobData.commandMode === 'review' || comments.some(comment => comment?.commandMode === 'review');
    return review ? 'review' : 'follow_up';
}

export async function loadPullRequestStatusTasks(db: Knex, repository: string, prNumber: number): Promise<PullRequestStatusTask[]> {
    const latestState = db('task_history').select('state')
        .where('task_id', db.ref('tasks.task_id')).orderBy('history_id', 'desc').limit(1);
    const rows: Array<{ task_type: string | null; created_at: string; initial_job_data: unknown; state: string | null }> = await db('tasks')
        .where('tasks.repository', repository)
        .andWhere(query => query.where('tasks.pr_number', prNumber)
            .orWhere(nested => nested.whereIn('tasks.task_type', PULL_REQUEST_TASK_TYPES).andWhere('tasks.issue_number', prNumber)))
        .orderBy('tasks.created_at', 'desc').orderBy('tasks.task_id', 'desc')
        .limit(TASK_LIMIT)
        .select('tasks.task_type', 'tasks.created_at', 'tasks.initial_job_data', latestState.as('state'));
    return rows.map(row => {
        const type = row.task_type ?? 'issue';
        return { type, mode: taskMode(type, parseJson(row.initial_job_data)), state: row.state ?? 'pending', createdAt: String(row.created_at) };
    });
}

async function isProprPullRequest(
    db: Knex, pullRequest: { repository: string; prNumber: number; headRef: string }, tasks: PullRequestStatusTask[],
): Promise<boolean> {
    const { repository, prNumber, headRef } = pullRequest;
    if (tasks.length > 0 || EPIC_BRANCH_PATTERN.test(headRef)) return true;
    const [planIssue, goal] = await Promise.all([
        db('plan_issues').where({ repository, pr_number: prNumber }).first('id'),
        db('goals').where({ repository, final_pr_number: prNumber }).first('goal_id'),
    ]);
    return Boolean(planIssue || goal);
}

async function loadEpicProgress(db: Knex, repository: string, headRef: string): Promise<PullRequestStatusFacts['epic']> {
    const match = headRef.match(EPIC_BRANCH_PATTERN);
    if (!match) return null;
    const first = await db('plan_issues').where({ repository, issue_number: Number(match[1]) }).first('draft_id');
    if (!first?.draft_id) return null;
    const issues: Array<{ status: string }> = await db('plan_issues').where({ draft_id: first.draft_id }).select('status');
    return { merged: issues.filter(issue => issue.status === 'merged').length, total: issues.length };
}

/** Ultrafix keeps its loop state, and any CI wait, under these Redis keys. */
export function ultrafixStatusKeys(owner: string, repo: string, prNumber: number): { state: string; ciWait: string } {
    return { state: `ultrafix:state:${owner}:${repo}:${prNumber}`, ciWait: `ultrafix:ci-wait:${owner}:${repo}:${prNumber}` };
}

async function loadUltrafix(redis: Pick<Redis, 'get'> | null | undefined, owner: string, repo: string, prNumber: number): Promise<PullRequestStatusUltrafix | null> {
    if (!redis) return null;
    const keys = ultrafixStatusKeys(owner, repo, prNumber);
    const [rawState, rawWait] = await Promise.all([redis.get(keys.state), redis.get(keys.ciWait)]);
    const state = parseJson(rawState);
    if (!rawState || typeof state.goal !== 'number') return null;
    const number = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    const text = (value: unknown): string | null => typeof value === 'string' ? value : null;
    return {
        active: state.active === true,
        cycleCount: number(state.cycleCount, 0),
        maxCycles: number(state.maxCycles, 0),
        goal: state.goal,
        completionStatus: state.completionStatus === 'succeeded' || state.completionStatus === 'failed' ? state.completionStatus : null,
        completionReason: text(state.completionReason),
        finalScore: typeof state.finalScore === 'number' ? state.finalScore : null,
        completedAt: text(state.completedAt),
        waitingForCi: state.active === true && Boolean(rawWait),
    };
}

interface CheckRunPage { total_count?: number; check_runs?: Array<{ name?: string; status: string; conclusion: string | null }> }

async function loadCheckRuns(github: PullRequestStatusGitHub, owner: string, repo: string, ref: string): Promise<NonNullable<CheckRunPage['check_runs']>> {
    const runs: NonNullable<CheckRunPage['check_runs']> = [];
    for (let page = 1; page <= MAX_CHECK_RUN_PAGES; page++) {
        const { data } = await github.request('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', { owner, repo, ref, per_page: CHECK_RUN_PAGE, page }) as { data: CheckRunPage };
        const pageRuns = data.check_runs ?? [];
        runs.push(...pageRuns);
        if (pageRuns.length < CHECK_RUN_PAGE || runs.length >= (data.total_count ?? 0)) break;
    }
    return runs;
}

/** Blocking checks on the head; nonBlockingChecks neither fail nor hold the status. */
export async function loadPullRequestStatusChecks(
    sources: Pick<PullRequestStatusSources, 'github' | 'loadNonBlockingChecks'>, owner: string, repo: string, ref: string,
): Promise<PullRequestStatusChecks> {
    const [runs, status, patterns] = await Promise.allSettled([
        loadCheckRuns(sources.github, owner, repo, ref),
        sources.github.request('GET /repos/{owner}/{repo}/commits/{ref}/status', { owner, repo, ref, per_page: 100 }),
        sources.loadNonBlockingChecks(owner, repo),
    ]);
    const checkRuns = runs.status === 'fulfilled' ? runs.value : [];
    const statusData = status.status === 'fulfilled' ? status.value.data as { state?: string; total_count?: number; statuses?: Array<{ context?: string; state?: string }> } : null;
    const statuses = Array.isArray(statusData?.statuses) ? statusData.statuses : [];
    const commitStatus = { state: statusData?.state ?? 'success', totalCount: statusData?.total_count ?? statuses.length, statuses };
    const summary = summarizeCheckSignals(checkRuns, commitStatus, patterns.status === 'fulfilled' ? patterns.value : []);
    const failed = summary.blockingFailed?.length ?? 0;
    const pending = summary.blockingPending?.length ?? 0;
    return {
        complete: runs.status === 'fulfilled' && status.status === 'fulfilled',
        passed: Math.max(0, summary.count - (summary.nonBlockingCount ?? 0) - failed - pending),
        failed,
        pending,
        failedNames: summary.blockingFailed ?? [],
    };
}

/** BullMQ jobs for the pull request that have not started yet (running ones are tasks already). */
export async function countQueuedPullRequestJobs(
    queue: { getJobs: (types: Array<'waiting' | 'delayed' | 'prioritized'>) => Promise<Array<{ data?: unknown } | undefined>> },
    repository: string, prNumber: number,
): Promise<number> {
    const jobs = await queue.getJobs(['waiting', 'delayed', 'prioritized']);
    return jobs.filter(job => {
        const data = (job?.data ?? {}) as Record<string, unknown>;
        const jobRepository = typeof data.repository === 'string' ? data.repository : `${String(data.repoOwner)}/${String(data.repoName)}`;
        const jobPr = typeof data.pullRequestNumber === 'number' ? data.pullRequestNumber : data.prNumber;
        return jobRepository.toLowerCase() === repository.toLowerCase() && jobPr === prNumber;
    }).length;
}

async function latestReviewScore(db: Knex, repository: string, prNumber: number): Promise<number | null> {
    const history = await loadPullRequestScoreHistory(db, repository, prNumber);
    const latest = history.at(-1);
    return latest ? latest.score : null;
}

/** Reads every fact the status computation needs, from ProPR's records and GitHub. */
export async function loadPullRequestStatusFacts(
    repository: string, prNumber: number, sources: PullRequestStatusSources, pull?: PullRequestStatusPull,
): Promise<PullRequestStatusFacts> {
    const [owner, repo] = repository.split('/');
    const pr = pull ?? (await sources.github.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', { owner, repo, pull_number: prNumber })).data as PullRequestStatusPull;
    const pullRequest = { state: pr.state, merged: pr.merged === true, headSha: pr.head.sha, mergeable: typeof pr.mergeable === 'boolean' ? pr.mergeable : null };
    const tasks = await loadPullRequestStatusTasks(sources.db, repository, prNumber);
    const isPropr = await isProprPullRequest(sources.db, { repository, prNumber, headRef: pr.head.ref }, tasks);
    const closed = pullRequest.state !== 'open' || pullRequest.merged;
    const empty: PullRequestStatusChecks = { complete: true, passed: 0, failed: 0, pending: 0, failedNames: [] };
    if (closed || !isPropr) {
        return { pullRequest, isProprPullRequest: isPropr, tasks, queuedJobs: 0, ultrafix: null, checks: empty, latestReviewScore: null, ratingGoal: 0, epic: null };
    }
    const [queuedJobs, ultrafix, checks, score, ratingGoal, epic] = await Promise.all([
        sources.countQueuedJobs ? sources.countQueuedJobs(repository, prNumber).catch(() => 0) : 0,
        loadUltrafix(sources.redis, owner, repo, prNumber).catch(error => {
            logger.warn({ repository, prNumber, error: (error as Error).message }, 'Failed to read Ultrafix state for the pull request status');
            return null;
        }),
        loadPullRequestStatusChecks(sources, owner, repo, pullRequest.headSha),
        latestReviewScore(sources.db, repository, prNumber).catch(() => null),
        sources.loadRatingGoal(),
        loadEpicProgress(sources.db, repository, pr.head.ref).catch(() => null),
    ]);
    return { pullRequest, isProprPullRequest: isPropr, tasks, queuedJobs, ultrafix, checks, latestReviewScore: score, ratingGoal, epic };
}

/** The status of a pull request: its facts read, then computed by the one status computation. */
export async function loadPullRequestStatus(
    repository: string, prNumber: number, sources: PullRequestStatusSources, pull?: PullRequestStatusPull,
): Promise<PullRequestStatus> {
    return computePullRequestStatus(await loadPullRequestStatusFacts(repository, prNumber, sources, pull));
}
