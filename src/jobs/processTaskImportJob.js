import logger from '../utils/logger.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { withRetry, retryConfigs } from '../utils/retryHandler.js';
import { getStateManager, TaskStates } from '../utils/workerStateManager.js';
import { 
    createWorktreeForIssue,
    cleanupWorktree,
    getRepoUrl
} from '../git/repoManager.js';
import { ensureGitRepository } from '../utils/git/gitValidation.js';
import { executeClaudeCode, UsageLimitError } from '../claude/claudeService.js';
import { generateTaskImportPrompt } from '../claude/prompts/promptGenerator.js';
import { handleError } from '../utils/errorHandler.js';
import { issueQueue } from '../queue/taskQueue.js';

const REQUEUE_BUFFER_MS = parseInt(process.env.REQUEUE_BUFFER_MS || (5 * 60 * 1000), 10);
const REQUEUE_JITTER_MS = parseInt(process.env.REQUEUE_JITTER_MS || (2 * 60 * 1000), 10);

async function handleUsageLimitError(error, job, correlatedLogger, repository) {
    correlatedLogger.warn({ repository, resetTimestamp: error.resetTimestamp }, 'Claude usage limit hit during task import processing. Requeueing job.');
    const resetTimeUTC = error.resetTimestamp ? (error.resetTimestamp * 1000) : (Date.now() + 60 * 60 * 1000);
    const delay = (resetTimeUTC - Date.now()) + REQUEUE_BUFFER_MS + Math.floor(Math.random() * REQUEUE_JITTER_MS);
    await issueQueue.add(job.name, job.data, { delay: Math.max(0, delay) });
    return { status: 'requeued', repository, delay };
}

export async function processTaskImportJob(job) {
    const { id: jobId, name: jobName, data } = job;
    const {
        taskDescription,
        repository,
        correlationId,
        user
    } = data;
    const correlatedLogger = logger.withCorrelation(correlationId);
    const stateManager = getStateManager(jobId);
    
    correlatedLogger.info({ 
        jobId,
        jobName,
        repository, 
        user,
        taskDescriptionLength: taskDescription?.length || 0,
        taskDescriptionPreview: taskDescription?.substring(0, 100) + '...'
    }, 'Processing task import job...');

    let octokit;
    let localRepoPath;
    let worktreeInfo;

    try {
        await stateManager.updateState(TaskStates.SETUP, 'Initializing task import process');
        
        octokit = await withRetry(
            () => getAuthenticatedOctokit(),
            { ...retryConfigs.githubApi, correlationId },
            'get_authenticated_octokit'
        );

        const [repoOwner, repoName] = repository.split('/');
        
        if (!repoOwner || !repoName) {
            throw new Error(`Invalid repository format: ${repository}. Expected format: owner/name`);
        }

        const githubToken = await octokit.auth();
        const repoUrl = getRepoUrl({ repoOwner, repoName });

        await ensureGitRepository(correlatedLogger);

        await stateManager.updateState(TaskStates.SETUP, 'Cloning repository if needed');
        const { ensureRepoCloned } = await import('../git/repoManager.js');
        localRepoPath = await ensureRepoCloned(repoUrl, repoOwner, repoName, githubToken.token);

        await stateManager.updateState(TaskStates.SETUP, 'Creating worktree for analysis');

        worktreeInfo = await createWorktreeForIssue(
            localRepoPath,
            'import',
            'Task Import Analysis',
            repoOwner,
            repoName,
            null,
            octokit,
            'planner'
        );

        correlatedLogger.info({ 
            worktreePath: worktreeInfo.worktreePath, 
            branchName: worktreeInfo.branchName 
        }, 'Created worktree for task import analysis');

        await stateManager.updateState(TaskStates.AI_PROCESSING, 'Generating task import prompt');
        
        const prompt = generateTaskImportPrompt(taskDescription, repoOwner, repoName, worktreeInfo.worktreePath);

        await stateManager.updateState(TaskStates.AI_PROCESSING, 'Executing Claude analysis');
        
        const claudeResult = await executeClaudeCode({
            worktreePath: worktreeInfo.worktreePath,
            issueRef: { 
                number: 'import',
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
                stdout: claudeResult.output?.rawOutput || claudeResult.output
            }, 'Task import job completed successfully - Claude executed gh commands');
        } else {
            correlatedLogger.error({
                repository,
                user,
                error: claudeResult.error
            }, 'Task import job failed');
        }
        
        await stateManager.updateState(TaskStates.CLEANUP, 'Cleaning up worktree');
        await stateManager.updateState(TaskStates.COMPLETED, 'Task import completed successfully');

        return { 
            status: 'complete', 
            repository,
            success: claudeResult.success,
            jobId,
            claudeResult: {
                success: claudeResult.success,
                executionTime: claudeResult.executionTime,
                conversationTurns: claudeResult.conversationLog?.length || 0,
                stdout: claudeResult.output?.rawOutput || claudeResult.output
            }
        };

    } catch (error) {
        if (error instanceof UsageLimitError) {
            return handleUsageLimitError(error, job, correlatedLogger, repository);
        }
        correlatedLogger.error({ error: error.message, stack: error.stack }, 'Task import job failed');
        await stateManager.updateState(TaskStates.FAILED, `Task import failed: ${error.message}`);
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
                correlatedLogger.warn({ error: cleanupError.message }, 'Failed to cleanup worktree');
            }
        }
    }
}
