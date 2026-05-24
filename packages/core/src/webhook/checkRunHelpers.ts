/* eslint-disable max-lines */
import { Redis, RedisOptions } from 'ioredis';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import logger from '../utils/logger.js';
import { db } from '../db/connection.js';
import { getIssueQueue } from '../queue/taskQueue.js';
import {
    clearPendingPrQueueJob,
    clearTrackedPrQueueJob,
    getPendingPrQueueJobs,
    getTrackedPrQueueJobs,
    TRACKED_PR_QUEUE_STATES,
    TRACKED_PR_QUEUE_STATE_SET,
    trackPrQueueJob
} from './prQueueJobIndex.js';
import { getPrNumberFromJobData, getRepositoryFromJobData, getTaskIdFromQueueJob } from './prTaskIdentity.js';

export interface MergePROptions {
    owner: string;
    repoName: string;
    prNumber: number;
    mergeMethod?: 'merge' | 'squash' | 'rebase';
    commitTitle?: string;
    commitMessage?: string;
}

export interface MergePRResult {
    success: boolean;
    error?: string;
    merged?: boolean;
    sha?: string;
}

/**
 * Attempts to merge a PR using the REST API.
 * This is used as a fallback when GitHub's native auto-merge isn't available
 * (e.g., when branch protection rules aren't configured).
 */
export async function mergePR(options: MergePROptions): Promise<MergePRResult> {
    const { owner, repoName, prNumber, mergeMethod = 'squash', commitTitle, commitMessage } = options;

    try {
        const octokit = await getAuthenticatedOctokit();

        logger.info({ owner, repoName, prNumber, mergeMethod, commitTitle }, 'Attempting to merge PR...');

        const response = await octokit.request('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', {
            owner,
            repo: repoName,
            pull_number: prNumber,
            merge_method: mergeMethod,
            ...(commitTitle && { commit_title: commitTitle }),
            ...(commitMessage && { commit_message: commitMessage })
        });

        logger.info({
            owner,
            repoName,
            prNumber,
            sha: response.data.sha,
            merged: response.data.merged
        }, 'PR merged successfully');

        return {
            success: true,
            merged: response.data.merged,
            sha: response.data.sha
        };
    } catch (error) {
        const err = error as Error & { status?: number; response?: { data?: { message?: string } } };
        const errorMessage = err.response?.data?.message || err.message;

        logger.warn({
            owner,
            repoName,
            prNumber,
            error: errorMessage,
            status: err.status
        }, 'Failed to merge PR');

        return {
            success: false,
            error: errorMessage
        };
    }
}

/**
 * Deletes the branch associated with a PR after merge.
 */
export async function deleteBranch(
    owner: string,
    repoName: string,
    prNumber: number,
    log: ReturnType<typeof logger.withCorrelation>
): Promise<void> {
    try {
        const octokit = await getAuthenticatedOctokit();

        // Get the PR to find the branch name
        const prResponse = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
            owner,
            repo: repoName,
            pull_number: prNumber
        });

        const branchName = prResponse.data.head.ref;
        const branchOwner = prResponse.data.head.repo?.owner?.login;

        // Only delete if the branch is in the same repo (not a fork)
        if (branchOwner !== owner) {
            log.debug({ owner, repoName, prNumber, branchOwner }, 'Branch is from a fork, not deleting');
            return;
        }

        await octokit.request('DELETE /repos/{owner}/{repo}/git/refs/{ref}', {
            owner,
            repo: repoName,
            ref: `heads/${branchName}`
        });

        log.info({ owner, repoName, prNumber, branchName }, 'Deleted PR branch after merge');
    } catch (error) {
        // Non-fatal - branch might already be deleted or protected
        log.warn({
            owner,
            repoName,
            prNumber,
            error: (error as Error).message
        }, 'Failed to delete PR branch');
    }
}

interface FirstCommitInfo {
    title: string;
    message: string;
}

/**
 * Gets the first commit message of a PR branch.
 */
export async function getFirstCommitMessage(
    owner: string,
    repoName: string,
    prNumber: number
): Promise<FirstCommitInfo | null> {
    try {
        const octokit = await getAuthenticatedOctokit();

        const commitsResponse = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/commits', {
            owner,
            repo: repoName,
            pull_number: prNumber,
            per_page: 100
        });

        const commits = commitsResponse.data;
        if (commits.length === 0) {
            return null;
        }

        const firstCommit = commits[0];
        const fullMessage = firstCommit.commit.message;

        const lines = fullMessage.split('\n');
        const title = lines[0];
        const message = lines.slice(1).join('\n').trim();

        return { title, message };
    } catch (error) {
        logger.warn({
            owner,
            repoName,
            prNumber,
            error: (error as Error).message
        }, 'Failed to get first commit message');
        return null;
    }
}

/**
 * Gets the current HEAD SHA of a PR to verify checks are for the latest commit.
 */
export async function getCurrentPRHead(owner: string, repoName: string, prNumber: number): Promise<string | null> {
    try {
        const octokit = await getAuthenticatedOctokit();

        const prResponse = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
            owner,
            repo: repoName,
            pull_number: prNumber
        });

        return prResponse.data.head.sha;
    } catch (error) {
        logger.warn({
            owner,
            repoName,
            prNumber,
            error: (error as Error).message
        }, 'Failed to get current PR head');
        return null;
    }
}

interface CommitStatusInfo {
    state: string;
    totalCount: number;
}

interface GitHubApiError extends Error {
    status?: number;
}

function isIntegrationAccessError(error: unknown): boolean {
    const err = error as GitHubApiError;
    return err.status === 403 || err.message.includes('Resource not accessible by integration');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getCommitStatusInfo(octokit: any, owner: string, repoName: string, ref: string): Promise<CommitStatusInfo> {
    const statusResponse = await octokit.request('GET /repos/{owner}/{repo}/commits/{ref}/status', {
        owner,
        repo: repoName,
        ref
    });
    return {
        state: statusResponse.data.state as string,
        totalCount: (statusResponse.data.total_count ?? statusResponse.data.statuses?.length ?? 0) as number,
    };
}

export interface CheckRunsStatus {
    count: number;
    allPassing: boolean;
    anyPending: boolean;
    anyFailed: boolean;
}

/**
 * Gets detailed status of check runs for a commit.
 * Always queries both the check-runs API and the legacy commit status API
 * so repos that publish both signal types are handled correctly.
 */
export async function getCheckRunsStatus(owner: string, repoName: string, ref: string): Promise<CheckRunsStatus> {
    try {
        const octokit = await getAuthenticatedOctokit();
        const [checkRunsResult, commitStatusResult] = await Promise.allSettled([
            octokit.request('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', {
                owner,
                repo: repoName,
                ref
            }),
            getCommitStatusInfo(octokit, owner, repoName, ref)
        ]);

        if (checkRunsResult.status === 'rejected' && commitStatusResult.status === 'rejected') {
            throw checkRunsResult.reason;
        }

        const checkRuns = checkRunsResult.status === 'fulfilled'
            ? checkRunsResult.value.data.check_runs
            : [];
        const commitStatus = commitStatusResult.status === 'fulfilled'
            ? commitStatusResult.value
            : { state: 'pending', totalCount: 0 };

        if (checkRunsResult.status === 'rejected') {
            logger.warn({ owner, repoName, ref, error: (checkRunsResult.reason as Error).message }, 'Failed to get check runs data');
        }

        if (commitStatusResult.status === 'rejected') {
            const error = commitStatusResult.reason as Error;
            const logMethod = isIntegrationAccessError(error) ? 'info' : 'warn';
            logger[logMethod](
                { owner, repoName, ref, error: error.message },
                'Legacy commit status unavailable, continuing with check-runs only',
            );
        }

        const count = checkRuns.length + commitStatus.totalCount;
        const crPending = checkRuns.some((run: { status: string }) => run.status !== 'completed');
        const crFailed = checkRuns.some((run: { status: string; conclusion: string | null }) =>
            run.status === 'completed' && run.conclusion !== 'success' && run.conclusion !== 'skipped'
        );

        const hasStatusContexts = commitStatus.totalCount > 0;
        const statusPending = hasStatusContexts && commitStatus.state === 'pending';
        const statusFailed = hasStatusContexts && (commitStatus.state === 'failure' || commitStatus.state === 'error');

        const anyPending = crPending || statusPending;
        const anyFailed = crFailed || statusFailed;
        const allPassing = !anyPending && !anyFailed;

        logger.debug({ owner, repoName, ref, count, allPassing, anyPending, anyFailed, commitStatus: commitStatus.state, statusContexts: commitStatus.totalCount }, 'Check runs status');
        return { count, allPassing, anyPending, anyFailed };
    } catch (error) {
        logger.warn({ owner, repoName, ref, error: (error as Error).message }, 'Failed to get check runs status');
        return { count: 0, allPassing: false, anyPending: false, anyFailed: false };
    }
}

/**
 * Checks if all check runs have passed for a PR.
 * Always queries both the check-runs API and the legacy commit status API
 * so repos that publish both signal types are handled correctly.
 */
export async function areAllChecksPassing(owner: string, repoName: string, ref: string): Promise<boolean> {
    try {
        const octokit = await getAuthenticatedOctokit();

        const [checkRunsResult, commitStatusResult] = await Promise.allSettled([
            octokit.request('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', {
                owner,
                repo: repoName,
                ref
            }),
            getCommitStatusInfo(octokit, owner, repoName, ref)
        ]);

        if (checkRunsResult.status === 'rejected' && commitStatusResult.status === 'rejected') {
            throw checkRunsResult.reason;
        }

        const checkRuns = checkRunsResult.status === 'fulfilled'
            ? checkRunsResult.value.data.check_runs
            : [];
        const commitStatus = commitStatusResult.status === 'fulfilled'
            ? commitStatusResult.value
            : { state: 'pending', totalCount: 0 };

        if (checkRunsResult.status === 'rejected') {
            logger.warn({ owner, repoName, ref, error: (checkRunsResult.reason as Error).message }, 'Failed to get check runs data');
        }

        if (commitStatusResult.status === 'rejected') {
            const error = commitStatusResult.reason as Error;
            const logMethod = isIntegrationAccessError(error) ? 'info' : 'warn';
            logger[logMethod](
                { owner, repoName, ref, error: error.message },
                'Legacy commit status unavailable, continuing with check-runs only',
            );
        }

        const allCheckRunsPass = checkRuns.length === 0 || checkRuns.every(
            (run: { status: string; conclusion: string | null }) =>
                run.status === 'completed' && (run.conclusion === 'success' || run.conclusion === 'skipped')
        );

        // Repos with no legacy status contexts report 'pending' — treat as passing.
        const statusPass = commitStatus.totalCount === 0 ||
            (commitStatus.state !== 'pending' && commitStatus.state !== 'failure' && commitStatus.state !== 'error');
        const allPass = allCheckRunsPass && statusPass;

        logger.debug({
            owner,
            repoName,
            ref,
            totalCheckRuns: checkRuns.length,
            commitStatus: commitStatus.state,
            statusContexts: commitStatus.totalCount,
            allCheckRunsPass,
            statusPass,
            allPass
        }, 'Checked PR status');

        return allPass;
    } catch (error) {
        logger.warn({
            owner,
            repoName,
            ref,
            error: (error as Error).message
        }, 'Failed to check PR status');
        return false;
    }
}

export interface PRAutoMergeInfo {
    hasLabel: boolean;
    hasUltrafixLabel?: boolean;
    hasActiveUltrafixLoop?: boolean;
    ultrafixCompletionStatus?: 'succeeded' | 'failed' | null;
    ultrafixStateUnavailable?: boolean;
    isDraft: boolean;
    baseBranch: string;
    headBranch: string;
}

const ULTRAFIX_STATE_KEY_PREFIX = 'ultrafix:state';
const ULTRAFIX_DEFERRED_KEY_PREFIX = 'ultrafix:deferred';
let ultrafixStateRedis: Redis | null = null;

export function buildRedisRuntimeConfig(): { url?: string; options: RedisOptions } {
    const options: RedisOptions = {
        maxRetriesPerRequest: null,
        enableReadyCheck: false
    };

    if (process.env.REDIS_URL) {
        const parsedUrl = new URL(process.env.REDIS_URL);
        options.host = parsedUrl.hostname;
        options.port = parsedUrl.port ? parseInt(parsedUrl.port, 10) : (parsedUrl.protocol === 'rediss:' ? 6380 : 6379);
        if (parsedUrl.username) {
            options.username = decodeURIComponent(parsedUrl.username);
        }
        if (parsedUrl.password) {
            options.password = decodeURIComponent(parsedUrl.password);
        }
        if (parsedUrl.protocol === 'rediss:') {
            options.tls = {
                rejectUnauthorized: process.env.REDIS_TLS_REJECT_UNAUTHORIZED !== 'false'
            };
        }
        if (parsedUrl.pathname && parsedUrl.pathname !== '/') {
            const db = parseInt(parsedUrl.pathname.slice(1), 10);
            if (!Number.isNaN(db)) {
                options.db = db;
            }
        }

        return {
            url: process.env.REDIS_URL,
            options
        };
    }

    const redisOptions: RedisOptions = {
        ...options,
        host: process.env.REDIS_HOST || 'redis',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
    };

    if (process.env.REDIS_USERNAME) {
        redisOptions.username = process.env.REDIS_USERNAME;
    }
    if (process.env.REDIS_PASSWORD) {
        redisOptions.password = process.env.REDIS_PASSWORD;
    }
    if (process.env.REDIS_TLS === 'true' || process.env.REDIS_TLS === '1') {
        redisOptions.tls = {
            rejectUnauthorized: process.env.REDIS_TLS_REJECT_UNAUTHORIZED !== 'false'
        };
    }

    return { options: redisOptions };
}

function getUltrafixStateRedis(): Redis {
    if (!ultrafixStateRedis) {
        const { url, options } = buildRedisRuntimeConfig();
        ultrafixStateRedis = url ? new Redis(url, options) : new Redis(options);
    }
    return ultrafixStateRedis;
}

export async function closeUltrafixStateRedis(): Promise<void> {
    const client = ultrafixStateRedis;
    ultrafixStateRedis = null;
    if (!client) return;

    try {
        await client.quit();
    } catch {
        client.disconnect(false);
    }
}

export function resetUltrafixStateRedisForTests(): void {
    ultrafixStateRedis?.disconnect(false);
    ultrafixStateRedis = null;
}

function getUltrafixStateKey(owner: string, repoName: string, prNumber: number): string {
    return `${ULTRAFIX_STATE_KEY_PREFIX}:${owner}:${repoName}:${prNumber}`;
}

function getUltrafixDeferredKey(owner: string, repoName: string, prNumber: number): string {
    return `${ULTRAFIX_DEFERRED_KEY_PREFIX}:${owner}:${repoName}:${prNumber}`;
}

export async function hasActiveUltrafixLoop(owner: string, repoName: string, prNumber: number): Promise<boolean> {
    const state = await getUltrafixLoopState(owner, repoName, prNumber);
    return state?.unavailable === true ? true : state?.active === true;
}

export async function clearUltrafixLoopState(owner: string, repoName: string, prNumber: number): Promise<void> {
    try {
        await getUltrafixStateRedis().del(
            getUltrafixStateKey(owner, repoName, prNumber),
            getUltrafixDeferredKey(owner, repoName, prNumber),
        );
    } catch (error) {
        logger.warn({
            owner,
            repoName,
            prNumber,
            error: (error as Error).message,
        }, 'Failed to clear ultrafix loop state');
    }
}

export async function getUltrafixLoopState(
    owner: string,
    repoName: string,
    prNumber: number
): Promise<{ active: boolean; completionStatus: 'succeeded' | 'failed' | null; unavailable?: boolean } | null> {
    try {
        const rawState = await getUltrafixStateRedis().get(getUltrafixStateKey(owner, repoName, prNumber));
        if (!rawState) return null;

        const parsedState = JSON.parse(rawState) as { active?: unknown; completionStatus?: unknown };
        return {
            active: parsedState.active === true,
            completionStatus: parsedState.completionStatus === 'succeeded' || parsedState.completionStatus === 'failed'
                ? parsedState.completionStatus
                : null
        };
    } catch (error) {
        logger.warn({
            owner,
            repoName,
            prNumber,
            error: (error as Error).message
        }, 'Failed to load ultrafix loop state');
        return {
            active: false,
            completionStatus: null,
            unavailable: true
        };
    }
}

/**
 * Checks if a PR has the auto-merge label, if it's a draft, and gets the base/head branches.
 */
export async function getPRAutoMergeInfo(owner: string, repoName: string, prNumber: number): Promise<PRAutoMergeInfo> {
    try {
        const octokit = await getAuthenticatedOctokit();

        const prResponse = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
            owner,
            repo: repoName,
            pull_number: prNumber
        });

        const labels = prResponse.data.labels as Array<{ name: string }>;
        const hasLabel = labels.some(label => label.name === 'auto-merge');
        const hasUltrafixLabel = labels.some(label => label.name === 'ultrafix');
        let ultrafixState = await getUltrafixLoopState(owner, repoName, prNumber);
        if (!hasUltrafixLabel && ultrafixState) {
            await clearUltrafixLoopState(owner, repoName, prNumber);
            ultrafixState = null;
        }
        const isDraft = prResponse.data.draft ?? false;
        const baseBranch = prResponse.data.base.ref;
        const headBranch = prResponse.data.head.ref;

        return {
            hasLabel,
            hasUltrafixLabel,
            hasActiveUltrafixLoop: ultrafixState?.active ?? false,
            ultrafixCompletionStatus: ultrafixState?.completionStatus ?? null,
            ultrafixStateUnavailable: ultrafixState?.unavailable === true,
            isDraft,
            baseBranch,
            headBranch
        };
    } catch (error) {
        logger.warn({
            owner,
            repoName,
            prNumber,
            error: (error as Error).message
        }, 'Failed to check PR info');
        return {
            hasLabel: false,
            hasUltrafixLabel: false,
            hasActiveUltrafixLoop: false,
            ultrafixCompletionStatus: null,
            ultrafixStateUnavailable: false,
            isDraft: false,
            baseBranch: '',
            headBranch: ''
        };
    }
}

/**
 * Checks if the linked issue (if any) has the auto-merge label.
 */
export async function linkedIssueHasAutoMergeLabel(owner: string, repoName: string, prNumber: number): Promise<boolean> {
    try {
        const octokit = await getAuthenticatedOctokit();

        const prResponse = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
            owner,
            repo: repoName,
            pull_number: prNumber
        });

        const prBody = prResponse.data.body || '';

        const issueRefs = prBody.match(/(?:fixes|closes|resolves|fix|close|resolve)\s*#(\d+)/gi);
        if (!issueRefs) return false;

        for (const ref of issueRefs) {
            const match = ref.match(/#(\d+)/);
            if (!match) continue;

            const issueNumber = parseInt(match[1], 10);

            const issueResponse = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
                owner,
                repo: repoName,
                issue_number: issueNumber
            });

            const labels = issueResponse.data.labels as Array<{ name: string } | string>;
            const hasLabel = labels.some(label =>
                (typeof label === 'string' ? label : label.name) === 'auto-merge'
            );

            if (hasLabel) {
                logger.debug({
                    owner,
                    repoName,
                    prNumber,
                    issueNumber
                }, 'Found auto-merge label on linked issue');
                return true;
            }
        }

        return false;
    } catch (error) {
        logger.warn({
            owner,
            repoName,
            prNumber,
            error: (error as Error).message
        }, 'Failed to check linked issue labels');
        return false;
    }
}

const PR_QUEUE_STATE_SET = TRACKED_PR_QUEUE_STATE_SET;
const TERMINAL_TASK_HISTORY_STATES = ['completed', 'failed', 'cancelled'] as const;

export interface PRTaskActivity {
    taskId: string;
    state: string;
}

interface ActiveTaskRow {
    task_id: string;
    job_id: string | null;
    state: string;
}

interface IndexedQueueTaskActivity {
    taskId: string;
    state: string;
    aliases: string[];
}

export interface GetActiveTasksForPRDeps {
    getIssueQueue?: typeof getIssueQueue;
    db?: typeof db;
    log?: Pick<typeof logger, 'info' | 'warn'>;
    forceQueueScan?: boolean;
}

/**
 * Returns active or queued task references for a PR.
 * Queue-backed entries use the BullMQ job id as their task id when no worker state exists yet.
 */
export async function getActiveTasksForPR(
    repository: string,
    prNumber: number,
    deps: GetActiveTasksForPRDeps = {}
): Promise<PRTaskActivity[]> {
    try {
        const taskMap = new Map<string, PRTaskActivity>();
        const taskAliases = new Map<string, string>();
        const queue = await (deps.getIssueQueue ?? getIssueQueue)();
        const database = deps.db ?? db;
        const log = deps.log ?? logger;
        const trackedQueueJobs = await getTrackedPrQueueJobs(queue as never, repository, prNumber);
        const pendingQueueJobs = await getPendingPrQueueJobs(queue as never, repository, prNumber);
        const indexedTrackedQueueJobs = await loadIndexedQueueTaskActivities({
            queue,
            repository,
            prNumber,
            queueJobs: trackedQueueJobs,
            log,
            promotePendingEntry: false,
        });
        const indexedPendingQueueJobs = await loadIndexedQueueTaskActivities({
            queue,
            repository,
            prNumber,
            queueJobs: pendingQueueJobs,
            log,
            promotePendingEntry: true,
        });

        for (const job of indexedTrackedQueueJobs) {
            registerActiveTask(
                taskMap,
                taskAliases,
                { taskId: job.taskId, state: job.state },
                job.aliases,
            );
        }
        for (const job of indexedPendingQueueJobs) {
            registerActiveTask(
                taskMap,
                taskAliases,
                { taskId: job.taskId, state: job.state },
                job.aliases,
            );
        }

        await addQueuedPrJobsFromFallbackScan({
            queue,
            repository,
            prNumber,
            taskMap,
            taskAliases,
            log,
        });

        const activeTasks = await database('tasks')
            .select('tasks.task_id', 'tasks.job_id', 'task_history.state')
            .leftJoin('task_history', function() {
                this.on('tasks.task_id', '=', 'task_history.task_id')
                    .andOn('task_history.history_id', '=', database.raw(`(
                        SELECT MAX(history_id) FROM task_history th2
                        WHERE th2.task_id = tasks.task_id
                    )`));
            })
            .where('tasks.repository', repository)
            .where('tasks.pr_number', prNumber)
            .whereNotNull('task_history.state')
            .whereNotIn('task_history.state', TERMINAL_TASK_HISTORY_STATES) as ActiveTaskRow[];

        for (const task of activeTasks) {
            const dedupeKey = resolveActiveTaskKey(taskMap, taskAliases, [task.job_id, task.task_id]);
            if (taskMap.has(dedupeKey)) {
                registerActiveTask(taskMap, taskAliases, { taskId: task.task_id, state: task.state }, [task.job_id]);
                continue;
            }

            registerActiveTask(taskMap, taskAliases, { taskId: task.task_id, state: task.state }, [task.job_id]);
        }

        const taskList = [...taskMap.values()];
        if (taskList.length > 0) {
            log.info({ repository, prNumber, activeTasks: taskList }, 'Found active or queued work for PR');
        }

        return taskList;
    } catch (error) {
        (deps.log ?? logger).warn({
            repository,
            prNumber,
            error: (error as Error).message
        }, 'Failed to load active tasks for PR');
        throw error;
    }
}

async function addQueuedPrJobsFromFallbackScan(params: {
    queue: Awaited<ReturnType<typeof getIssueQueue>>;
    repository: string;
    prNumber: number;
    taskMap: Map<string, PRTaskActivity>;
    taskAliases: Map<string, string>;
    log: Pick<typeof logger, 'info' | 'warn'>;
}): Promise<void> {
    const { queue, repository, prNumber, taskMap, taskAliases, log } = params;
    for (const queueState of TRACKED_PR_QUEUE_STATES) {
        const jobs = await queue.getJobs([queueState]);
        for (const job of jobs) {
            const jobData = job.data as unknown as Record<string, unknown>;
            if (getRepositoryFromJobData(jobData) !== repository || getPrNumberFromJobData(jobData) !== prNumber) {
                continue;
            }

            const queueJobId = String(job.id);
            registerActiveTask(taskMap, taskAliases, { taskId: queueJobId, state: queueState }, [
                getQueueTaskAlias(queueJobId),
                getTaskIdFromQueueJob(job),
            ]);
            try {
                await trackPrQueueJob(queue as never, repository, prNumber, queueJobId);
            } catch (error) {
                log.warn({
                    repository,
                    prNumber,
                    jobId: queueJobId,
                    error: (error as Error).message,
                }, 'Failed to backfill PR queue-job index entry');
            }
        }
    }
}

async function loadIndexedQueueTaskActivities(params: {
    queue: Awaited<ReturnType<typeof getIssueQueue>>;
    repository: string;
    prNumber: number;
    queueJobs: Array<{ jobId: string; state: string }>;
    log: Pick<typeof logger, 'info' | 'warn'>;
    promotePendingEntry: boolean;
}): Promise<IndexedQueueTaskActivity[]> {
    const { queueJobs } = params;
    const resolvedQueueJobs = await Promise.all(queueJobs.map((queueJob) => loadIndexedQueueTaskActivity({
        ...params,
        queueJob,
    })));

    return resolvedQueueJobs.filter((queueJob): queueJob is IndexedQueueTaskActivity => queueJob !== null);
}

async function loadIndexedQueueTaskActivity(params: {
    queue: Awaited<ReturnType<typeof getIssueQueue>>;
    repository: string;
    prNumber: number;
    queueJob: { jobId: string; state: string };
    log: Pick<typeof logger, 'info' | 'warn'>;
    promotePendingEntry: boolean;
}): Promise<IndexedQueueTaskActivity | null> {
    const { queue, repository, prNumber, queueJob, log, promotePendingEntry } = params;
    const resolvedQueueJob = await queue.getJob(queueJob.jobId);
    if (!resolvedQueueJob) {
        await clearStalePrQueueJobIndexEntries({ queue, repository, prNumber, jobId: queueJob.jobId, log });
        return null;
    }

    const queueState = await resolvedQueueJob.getState();
    if (!TRACKED_PR_QUEUE_STATE_SET.has(queueState)) {
        await clearStalePrQueueJobIndexEntries({ queue, repository, prNumber, jobId: queueJob.jobId, log });
        return null;
    }

    if (promotePendingEntry) {
        try {
            await trackPrQueueJob(queue as never, repository, prNumber, queueJob.jobId);
        } catch (error) {
            log.warn({
                repository,
                prNumber,
                jobId: queueJob.jobId,
                error: (error as Error).message,
            }, 'Failed to promote pending PR queue-job index entry');
        }
    }

    return {
        taskId: queueJob.jobId,
        state: queueState,
        aliases: [
            getQueueTaskAlias(queueJob.jobId),
            getTaskIdFromQueueJob(resolvedQueueJob),
        ].filter((alias): alias is string => Boolean(alias)),
    };
}

async function clearStalePrQueueJobIndexEntries(params: {
    queue: Awaited<ReturnType<typeof getIssueQueue>>;
    repository: string;
    prNumber: number;
    jobId: string;
    log: Pick<typeof logger, 'info' | 'warn'>;
}): Promise<void> {
    const { queue, repository, prNumber, jobId, log } = params;

    try {
        await Promise.all([
            clearTrackedPrQueueJob(queue as never, repository, prNumber, jobId),
            clearPendingPrQueueJob(queue as never, repository, prNumber, jobId),
        ]);
    } catch (error) {
        log.warn({
            repository,
            prNumber,
            jobId,
            error: (error as Error).message,
        }, 'Failed to clear stale PR queue-job index entry');
    }
}

function registerActiveTask(
    taskMap: Map<string, PRTaskActivity>,
    taskAliases: Map<string, string>,
    task: PRTaskActivity,
    aliases: Array<string | null | undefined> = [],
): void {
    const dedupeKey = resolveActiveTaskKey(taskMap, taskAliases, [task.taskId, ...aliases]);
    taskMap.set(dedupeKey, task);

    for (const alias of [dedupeKey, task.taskId, ...aliases]) {
        if (!alias) {
            continue;
        }
        taskAliases.set(alias, dedupeKey);
    }
}

function resolveActiveTaskKey(
    taskMap: Map<string, PRTaskActivity>,
    taskAliases: Map<string, string>,
    candidates: Array<string | null | undefined>,
): string {
    for (const candidate of candidates) {
        if (!candidate) {
            continue;
        }

        const aliasedKey = taskAliases.get(candidate);
        if (aliasedKey) {
            return aliasedKey;
        }

        if (taskMap.has(candidate)) {
            return candidate;
        }
    }

    for (const candidate of candidates) {
        if (candidate) {
            return candidate;
        }
    }

    return '';
}

function getQueueTaskAlias(jobId: string): string | null {
    if (!jobId.startsWith('issue-')) {
        return null;
    }

    const parts = jobId.replace(/^issue-/, '').split('-');
    parts.pop();
    return parts.join('-');
}

/**
 * Checks if there are any active (non-terminal) tasks for a given PR.
 * This is used to prevent auto-merge while a followup task is still running.
 */
export async function hasActiveTasksForPR(
    repository: string,
    prNumber: number,
    deps: GetActiveTasksForPRDeps = {}
): Promise<{
    hasActive: boolean;
    activeTasks: Array<{ taskId: string; state: string }>;
    queuedJobs: Array<{ jobId: string; state: string }>;
}> {
    try {
        const taskList = await getActiveTasksForPR(repository, prNumber, deps);
        return {
            hasActive: taskList.length > 0,
            activeTasks: taskList.filter(task => !PR_QUEUE_STATE_SET.has(task.state)),
            queuedJobs: taskList
                .filter(task => PR_QUEUE_STATE_SET.has(task.state))
                .map(task => ({ jobId: task.taskId, state: task.state })),
        };
    } catch {
        return {
            hasActive: false,
            activeTasks: [],
            queuedJobs: [],
        };
    }
}

/**
 * Finds open PRs whose head SHA matches the given commit.
 * Used by the status event handler to map a commit status update to PRs.
 */
export async function findPRsForCommit(
    owner: string,
    repoName: string,
    commitSha: string
): Promise<Array<{ number: number }>> {
    try {
        const octokit = await getAuthenticatedOctokit();
        const { data: pulls } = await octokit.request(
            'GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls',
            { owner, repo: repoName, commit_sha: commitSha, headers: { accept: 'application/vnd.github.groot-preview+json' } }
        );
        return pulls
            .filter((pr: { state: string }) => pr.state === 'open')
            .map((pr: { number: number }) => ({ number: pr.number }));
    } catch (error) {
        logger.warn({ owner, repoName, commitSha, error: (error as Error).message }, 'Failed to find PRs for commit');
        return [];
    }
}
