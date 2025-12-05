import { Job } from 'bullmq';
import type { Logger } from 'pino';
import logger from '../utils/logger.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { withRetry, retryConfigs } from '../utils/retryHandler.js';
import { getStateManager, TaskStates } from '../utils/workerStateManager.js';
import type { WorkerStateManager } from '../utils/workerStateManager.js';
import {
    createWorktreeForIssue,
    cleanupWorktree,
    getRepoUrl
} from '../git/repoManager.js';
import type { WorktreeInfo } from '../git/repoManager.js';
import { ensureGitRepository } from '../utils/git/gitValidation.js';
import { executeClaudeCode, UsageLimitError } from '../claude/claudeService.js';
import type { ClaudeCodeResponse } from '../claude/claudeService.js';
import { generateTaskImportPrompt } from '../claude/prompts/promptGenerator.js';
import { handleError } from '../utils/errorHandler.js';
import { handleSimpleUsageLimitError } from './issueJobHelpers.js';
import type { TaskImportJobData, JobResult } from '../queue/taskQueue.js';

interface GitHubToken {
    token: string;
}

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

export async function processTaskImportJob(job: Job<TaskImportJobData>): Promise<TaskImportResult> {
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
    const [repoOwner, repoName] = repository.split('/');
    const taskId = `task-import-${repoOwner}-${repoName}-${Date.now()}`;

    try {
        await stateManager.createTaskState(taskId, { number: 0, repoOwner, repoName }, correlationId);

        octokit = await withRetry(
            () => getAuthenticatedOctokit(),
            { ...retryConfigs.githubApi, correlationId },
            'get_authenticated_octokit'
        );

        if (!repoOwner || !repoName) {
            throw new Error(`Invalid repository format: ${repository}. Expected format: owner/name`);
        }

        const githubToken = await octokit.auth() as GitHubToken;
        const repoUrl = getRepoUrl({ repoOwner, repoName });

        await ensureGitRepository(correlatedLogger);

        await stateManager.updateTaskState(taskId, TaskStates.PROCESSING, { reason: 'Cloning repository if needed' });
        const { ensureRepoCloned } = await import('../git/repoManager.js');
        localRepoPath = await ensureRepoCloned(repoUrl, repoOwner, repoName, githubToken.token);

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


        const claudeResult: ClaudeCodeResponse = await executeClaudeCode({
            worktreePath: worktreeInfo.worktreePath,
            issueRef: {
                number: 0,
                repoOwner,
                repoName
            },
            githubToken: githubToken.token,
            customPrompt: prompt,
            branchName: worktreeInfo.branchName,
            modelName: 'claude-3-5-sonnet-20241022'
        });

        correlatedLogger.info({
            success: claudeResult.success,
            executionTime: claudeResult.executionTime,
            conversationTurns: claudeResult.conversationLog?.length || 0
        }, 'Claude task import analysis completed');

        if (claudeResult.success) {
            correlatedLogger.info({
                repository,
                user,
                stdout: claudeResult.output?.rawOutput || claudeResult.rawOutput
            }, 'Task import job completed successfully - Claude executed gh commands');
        } else {
            correlatedLogger.error({
                repository,
                user,
                error: claudeResult.error
            }, 'Task import job failed');
        }

        await stateManager.updateTaskState(taskId, TaskStates.POST_PROCESSING, { reason: 'Cleaning up worktree' });
        await stateManager.markTaskCompleted(taskId, { status: 'complete', repository });

        return {
            status: 'complete',
            repository,
            success: claudeResult.success,
            jobId,
            claudeResult: {
                success: claudeResult.success,
                executionTime: claudeResult.executionTime,
                conversationTurns: claudeResult.conversationLog?.length || 0,
                stdout: claudeResult.output?.rawOutput || claudeResult.rawOutput
            }
        };

    } catch (error) {
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
                    success: true
                });
            } catch (cleanupError) {
                correlatedLogger.warn({ error: (cleanupError as Error).message }, 'Failed to cleanup worktree');
            }
        }
    }
}
