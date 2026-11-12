import { Job } from 'bullmq';
import type { Logger } from 'pino';
import { logger } from '@propr/core';
import { getAuthenticatedOctokit } from '@propr/core';
import { withRetry, retryConfigs } from '@propr/core';
import { getStateManager, TaskStates } from '@propr/core';
import {
    createWorktreeForIssue,
    cleanupWorktree,
    getRepoUrl,
    ensureRepoCloned
} from '@propr/core';
import type { WorktreeInfo } from '@propr/core';
import { ensureGitRepository } from '@propr/core';
import { AgentRegistry, UsageLimitError } from '@propr/core';
import { generateTaskImportPrompt } from '@propr/core';
import { handleError } from '@propr/core';
import { handleSimpleUsageLimitError } from './issueJobHelpers.js';
import type { TaskImportJobData, JobResult } from '@propr/core';
import type { GitHubToken } from './githubTypes.js';
import { resolveDefaultAgentAndModel } from './prCommentAgentUtils.js';
import { compactNotificationRecap } from './notificationRecap.js';
import { deferOnCapacityRefusal } from './capacityDeferral.js';
import { admitAgentCapacity, checkJobAgentCapacity, isAgentCapacityRefusal, JOB_AGENT_CAPACITY_RACE_WAIT_MS, persistAgentCapacityDeferral, runWithJobAgentCapacity } from './agentCapacityDeferral.js';

interface TaskImportResult extends JobResult {
    repository?: string;
    success?: boolean;
    claudeResult?: {
        success: boolean;
        executionTime?: number;
        conversationTurns?: number;
        stdout?: string;
    };
}

function taskImportNotificationRecap(
    result: { summary?: string; success: boolean },
    repository: string,
): string {
    const summary = compactNotificationRecap(result.summary);
    if (summary) return summary;
    return result.success
        ? `Imported repository tasks for ${repository}.`
        : `Task import finished without importing tasks for ${repository}.`;
}

/** BullMQ retries keep the job ID, so every attempt shares one durable task. */
function taskImportTaskId(repoOwner: string, repoName: string, jobId: string | undefined): string {
    return jobId === undefined
        ? `task-import-${repoOwner}-${repoName}-${Date.now()}`
        : `task-import-${jobId}`;
}

/**
 * Creates the task, or after a capacity wait keeps it (and its waiting row).
 * Returns false when the task was stopped while the job waited.
 */
async function openTaskImportTask(job: Job<TaskImportJobData>, taskId: string, stateManager: ReturnType<typeof getStateManager>): Promise<boolean> {
    const [repoOwner, repoName] = job.data.repository.split('/');
    const issueRef = { number: 0, repoOwner, repoName, type: 'task-import' } as const;
    const jobId = job.id === undefined ? null : String(job.id);
    if (!job.data.agentCapacityDeferrals) {
        await stateManager.createTaskState(taskId, issueRef, job.data.correlationId, jobId);
        return true;
    }
    if ((await stateManager.getTaskState(taskId))?.state === TaskStates.CANCELLED) {
        await admitAgentCapacity(job);
        return false;
    }
    await stateManager.createTaskStateIfAbsent(taskId, issueRef, job.data.correlationId, jobId);
    return true;
}

/**
 * A default agent at its per-agent ceiling delays this same job (no attempt
 * consumed). Task import publishes nothing before its agent runs, so a lost race
 * at the authoritative acquire that waits longer than the race bound is
 * deferred too; the throwaway worktree is removed meanwhile.
 */
export function processTaskImportJob(job: Job<TaskImportJobData>): Promise<TaskImportResult> {
    return deferOnCapacityRefusal(job, () => processAdmittedTaskImportJob(job));
}

// eslint-disable-next-line complexity -- one linear lifecycle: task, capacity, worktree, agent, settle and cleanup
async function processAdmittedTaskImportJob(job: Job<TaskImportJobData>): Promise<TaskImportResult> {
    const { id: jobId, name: jobName, data } = job;
    const {
        taskDescription,
        repository,
        correlationId,
        user
    } = data;
    const correlatedLogger: Logger = logger.withCorrelation(correlationId);
    const stateManager = getStateManager();

    correlatedLogger.info({
        jobId,
        jobName,
        repository,
        user,
        taskDescriptionLength: taskDescription?.length || 0,
        taskDescriptionPreview: taskDescription?.substring(0, 100) + '...'
    }, 'Processing task import job...');

    let octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>;
    let localRepoPath: string | undefined;
    let worktreeInfo: WorktreeInfo | undefined;
    let importSucceeded = false;
    const [repoOwner, repoName] = repository.split('/');
    const taskId = taskImportTaskId(repoOwner, repoName, jobId);

    let deferred = false;
    try {
        if (!await openTaskImportTask(job, taskId, stateManager)) return { status: 'cancelled', repository, jobId };

        const registry = AgentRegistry.getInstance();
        await registry.ensureInitialized();
        const { resolvedAlias, resolvedModel } = await resolveDefaultAgentAndModel(registry, correlatedLogger);
        // Before cloning: a saturated default agent defers the job.
        const agentCapacity = await checkJobAgentCapacity(job, [{ agentAlias: resolvedAlias, model: resolvedModel }], { raceWaitMs: JOB_AGENT_CAPACITY_RACE_WAIT_MS });
        await admitAgentCapacity(job);

        octokit = await withRetry(
            () => getAuthenticatedOctokit(),
            { ...retryConfigs.githubApi, correlationId },
            'get_authenticated_octokit'
        );

        if (!repoOwner || !repoName) {
            throw new Error(`Invalid repository format: ${repository}. Expected format: owner/name`);
        }

        const githubToken = await octokit.auth({ type: "installation" }) as GitHubToken;
        const repoUrl = getRepoUrl({ repoOwner, repoName });

        await ensureGitRepository(correlatedLogger);

        await stateManager.updateTaskState(taskId, TaskStates.PROCESSING, { reason: 'Cloning repository if needed' });
        localRepoPath = await ensureRepoCloned({ repoUrl, owner: repoOwner, repoName, authToken: githubToken.token });

        await stateManager.updateTaskState(taskId, TaskStates.PROCESSING, { reason: 'Creating worktree for analysis' });

        worktreeInfo = await createWorktreeForIssue(
            localRepoPath,
            { issueId: 'import', issueTitle: 'Task Import Analysis', owner: repoOwner, repoName },
            { baseBranch: null, octokit, modelName: 'planner' }
        );

        correlatedLogger.info({
            worktreePath: worktreeInfo.worktreePath,
            branchName: worktreeInfo.branchName
        }, 'Created worktree for task import analysis');

        await stateManager.updateTaskState(taskId, TaskStates.CLAUDE_EXECUTION, { reason: 'Generating task import prompt' });

        const prompt = generateTaskImportPrompt(taskDescription, repoOwner, repoName, worktreeInfo.worktreePath);


        const agent = registry.getAgentByAlias(resolvedAlias);
        if (!agent) throw new Error(`Configured default agent not found: ${resolvedAlias}`);

        const importWorktree = worktreeInfo;
        const agentResult = await runWithJobAgentCapacity(agentCapacity, () => agent.executeTask({
            worktreePath: importWorktree.worktreePath,
            issueRef: {
                number: 0,
                repoOwner,
                repoName
            },
            githubToken: githubToken.token,
            prompt,
            branchName: importWorktree.branchName,
            model: resolvedModel,
            taskId,
        }));

        correlatedLogger.info({
            agentAlias: resolvedAlias,
            model: resolvedModel,
            success: agentResult.success,
            executionTime: agentResult.executionTimeMs,
            conversationTurns: agentResult.conversationLog?.length || 0
        }, 'Task import analysis completed');

        if (agentResult.success) {
            correlatedLogger.info({
                repository,
                user,
                stdout: agentResult.rawOutput || agentResult.logs
            }, 'Task import job completed successfully - agent executed gh commands');
        } else {
            correlatedLogger.error({
                repository,
                user,
                error: agentResult.error
            }, 'Task import job failed');
        }

        await stateManager.updateTaskState(taskId, TaskStates.POST_PROCESSING, { reason: 'Cleaning up worktree' });
        await stateManager.markTaskCompleted(taskId, {
            status: 'complete',
            repository,
            notificationRecap: taskImportNotificationRecap(agentResult, repository),
        });

        importSucceeded = agentResult.success;
        return {
            status: 'complete',
            repository,
            success: agentResult.success,
            jobId,
            claudeResult: {
                success: agentResult.success,
                executionTime: agentResult.executionTimeMs,
                conversationTurns: agentResult.conversationLog?.length || 0,
                stdout: agentResult.rawOutput || agentResult.logs
            }
        };

    } catch (error) {
        if (isAgentCapacityRefusal(error)) {
            deferred = true;
            await persistAgentCapacityDeferral({ job, error, stateManager, taskId, correlatedLogger });
            throw error;
        }
        if (error instanceof UsageLimitError) {
            return handleSimpleUsageLimitError(error, job as unknown as Job<{ repoOwner: string; repoName: string; number: number; modelName?: string; correlationId?: string }>, correlatedLogger, repository);
        }
        correlatedLogger.error({ error: (error as Error).message, stack: (error as Error).stack }, 'Task import job failed');
        await stateManager.markTaskFailed(taskId, error as Error);
        handleError(error, 'Failed to process task import job', { correlationId });
        throw error;
    } finally {
        if (localRepoPath && worktreeInfo) {
            try {
                await cleanupWorktree(localRepoPath, worktreeInfo.worktreePath, worktreeInfo.branchName, {
                    deleteBranch: true,
                    // A deferred import starts over in a fresh worktree; none is retained for diagnosis.
                    success: importSucceeded || deferred
                });
            } catch (cleanupError) {
                correlatedLogger.warn({ error: (cleanupError as Error).message }, 'Failed to cleanup worktree');
            }
        }
    }
}
