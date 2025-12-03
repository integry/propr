import 'dotenv/config';
import { GITHUB_ISSUE_QUEUE_NAME, createWorker, issueQueue } from './queue/taskQueue.js';
import logger, { generateCorrelationId } from './utils/logger.js';
import { getAuthenticatedOctokit } from './auth/githubAuth.js';
import { handleError } from './utils/errorHandler.js';
import { withRetry, retryConfigs } from './utils/retryHandler.js';
import { getStateManager, TaskStates } from './utils/workerStateManager.js';
import { db, isEnabled as isDbEnabled } from './db/postgres.js';
import { 
    ensureRepoCloned, 
    createWorktreeForIssue,
    cleanupWorktree,
    getRepoUrl
} from './git/repoManager.js';
import { ensureGitRepository } from './utils/git/gitValidation.js';
import { executeClaudeCode, buildClaudeDockerImage, UsageLimitError } from './claude/claudeService.js';
import { generateTaskImportPrompt } from './claude/prompts/promptGenerator.js';
import Redis from 'ioredis';
import { loadSettings, loadAiPrimaryTag, loadPrLabel } from './config/configRepoManager.js';
import { processGitHubIssueJob } from './jobs/processGitHubIssueJob.js';
import { processPullRequestCommentJob } from './jobs/processPullRequestCommentJob.js';

// Configuration
const AI_PROCESSING_TAG = process.env.AI_PROCESSING_TAG || 'AI-processing';
const AI_DONE_TAG = process.env.AI_DONE_TAG || 'AI-done';

async function getAiPrimaryTag() {
    try {
        if (process.env.CONFIG_REPO) {
            return await loadAiPrimaryTag();
        }
    } catch (error) {
        logger.warn({ error: error.message }, 'Failed to load AI primary tag from config, using fallback');
    }
    return process.env.AI_PRIMARY_TAG || 'AI';
}

async function getPrLabel() {
    try {
        if (process.env.CONFIG_REPO) {
            return await loadPrLabel();
        }
    } catch (error) {
        logger.warn({ error: error.message }, 'Failed to load PR label from config, using fallback');
    }
    return process.env.PR_LABEL || 'gitfix';
}

// Buffer to add AFTER the reset timestamp to ensure limit is reset
const REQUEUE_BUFFER_MS = parseInt(process.env.REQUEUE_BUFFER_MS || (5 * 60 * 1000), 10); // 5 minutes buffer
// Jitter to prevent thundering herd if multiple jobs reset at the same time
const REQUEUE_JITTER_MS = parseInt(process.env.REQUEUE_JITTER_MS || (2 * 60 * 1000), 10); // 2 minutes jitter







/**
 * Processes a task import job from the queue
 * @param {import('bullmq').Job} job - The job to process
 * @returns {Promise<Object>} Processing result
 */
async function processTaskImportJob(job) {
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
        // Phase 1: Setup
        await stateManager.updateState(TaskStates.SETUP, 'Initializing task import process');
        
        // Get authenticated Octokit instance
        octokit = await withRetry(
            () => getAuthenticatedOctokit(),
            { ...retryConfigs.githubApi, correlationId },
            'get_authenticated_octokit'
        );

        // Parse repository into owner and name
        const [repoOwner, repoName] = repository.split('/');
        
        if (!repoOwner || !repoName) {
            throw new Error(`Invalid repository format: ${repository}. Expected format: owner/name`);
        }

        const githubToken = await octokit.auth();
        const repoUrl = getRepoUrl({ repoOwner, repoName });

        // Ensure we're in a valid git repository before proceeding
        await ensureGitRepository(correlatedLogger);

        // Step 1: Ensure repository is cloned
        await stateManager.updateState(TaskStates.SETUP, 'Cloning repository if needed');
        localRepoPath = await ensureRepoCloned(repoUrl, repoOwner, repoName, githubToken.token);

        // Step 2: Create a worktree for the task import analysis
        await stateManager.updateState(TaskStates.SETUP, 'Creating worktree for analysis');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
        const worktreeDirName = `task-import-${timestamp}`;

        // Use placeholder values for issue-specific parameters
        worktreeInfo = await createWorktreeForIssue(
            localRepoPath,
            'import', // issueNumber placeholder
            'Task Import Analysis', // title
            repoOwner,
            repoName,
            null, // Use auto-detected default branch
            octokit,
            'planner' // modelName placeholder
        );

        correlatedLogger.info({ 
            worktreePath: worktreeInfo.worktreePath, 
            branchName: worktreeInfo.branchName 
        }, 'Created worktree for task import analysis');

        // Phase 2: AI Processing
        await stateManager.updateState(TaskStates.AI_PROCESSING, 'Generating task import prompt');
        
        // Step 3: Generate the task import prompt
        const prompt = generateTaskImportPrompt(taskDescription, repoOwner, repoName, worktreeInfo.worktreePath);

        await stateManager.updateState(TaskStates.AI_PROCESSING, 'Executing Claude analysis');
        
        // Step 4: Execute Claude Code with the task import prompt
        const claudeResult = await executeClaudeCode({
            worktreePath: worktreeInfo.worktreePath,
            issueRef: { 
                number: 'import', // placeholder
                repoOwner, 
                repoName 
            },
            githubToken: githubToken.token,
            customPrompt: prompt,
            branchName: worktreeInfo.branchName,
            modelName: 'claude-3-5-sonnet-20241022' // Use a specific model for planning
        });

        correlatedLogger.info({
            success: claudeResult.success,
            executionTime: claudeResult.executionTime,
            conversationTurns: claudeResult.conversationLog?.length || 0
        }, 'Claude task import analysis completed');

        // Log the result (this is a fire-and-forget job)
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
        
        // Phase 3: Cleanup
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
            correlatedLogger.warn({
                repository,
                resetTimestamp: error.resetTimestamp
            }, 'Claude usage limit hit during task import processing. Requeueing job.');

            const resetTimeUTC = error.resetTimestamp ? (error.resetTimestamp * 1000) : (Date.now() + 60 * 60 * 1000);
            const delay = (resetTimeUTC - Date.now()) + REQUEUE_BUFFER_MS + Math.floor(Math.random() * REQUEUE_JITTER_MS);

            // Re-add the job to the queue with delay
            await issueQueue.add(job.name, job.data, { delay: Math.max(0, delay) });
            
            // Don't throw - job is handled by requeueing
            return { 
                status: 'requeued', 
                repository,
                delay
            };
        } else {
            // Handle all other errors
            correlatedLogger.error({
                error: error.message,
                stack: error.stack
            }, 'Task import job failed');
            
            await stateManager.updateState(TaskStates.FAILED, `Task import failed: ${error.message}`);
            
            handleError(error, 'Failed to process task import job', { correlationId });
            throw error;
        }
    } finally {
        // Cleanup worktree
        if (localRepoPath && worktreeInfo) {
            try {
                await cleanupWorktree(localRepoPath, worktreeInfo.worktreePath, worktreeInfo.branchName, {
                    deleteBranch: true, // Always delete branch for task imports
                    success: true
                });
            } catch (cleanupError) {
                correlatedLogger.warn({ error: cleanupError.message }, 'Failed to cleanup worktree');
            }
        }
    }
}


/**
 * Creates log files for detailed Claude execution data
 * @param {Object} claudeResult - Result from Claude Code execution
 * @param {Object} issueRef - Issue reference
 * @returns {Promise<Object>} File paths and metadata
 */

/**
 * Resets all worker-related queue data
 */
async function resetWorkerQueues() {
    logger.info('Resetting worker queue data...');
    
    try {
        const redis = new Redis({
            host: process.env.REDIS_HOST || '127.0.0.1',
            port: parseInt(process.env.REDIS_PORT || '6379', 10),
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
        });

        // Get all keys related to our queue
        const queueName = GITHUB_ISSUE_QUEUE_NAME;
        const keys = await redis.keys(`bull:${queueName}:*`);
        
        if (keys.length > 0) {
            logger.info({
                queueName,
                keysCount: keys.length
            }, 'Found worker queue keys to delete');
            
            // Delete all queue-related keys
            await redis.del(...keys);
            
            logger.info({
                queueName,
                deletedKeys: keys.length
            }, 'Successfully cleared all worker queue data');
        } else {
            logger.info({ queueName }, 'No worker queue data found to clear');
        }
        
        // Clean up Redis connection
        await redis.quit();
        
    } catch (error) {
        logger.error({ error: error.message }, 'Failed to reset worker queue data');
        throw error;
    }
}

/**
 * Parse command line arguments
 */
function parseArguments() {
    const args = process.argv.slice(2);
    const options = {
        reset: false,
        help: false
    };
    
    for (const arg of args) {
        switch (arg) {
            case '--reset':
                options.reset = true;
                break;
            case '--help':
            case '-h':
                options.help = true;
                break;
            default:
                if (arg.startsWith('--')) {
                    logger.warn({ argument: arg }, 'Unknown command line argument');
                }
        }
    }
    
    return options;
}

/**
 * Display help information
 */
function showHelp() {
    console.log(`
GitHub Issue Worker

Usage: node src/worker.js [options]

Options:
  --reset    Clear all queue data before starting worker
  --help     Show this help message

Examples:
  node src/worker.js                 # Start worker normally
  node src/worker.js --reset         # Reset queues and start worker
`);
}

/**
 * Starts the worker process
 */
async function startWorker(options = {}) {
    const workerId = `worker:${generateCorrelationId()}`;
    let workerConcurrency = parseInt(process.env.WORKER_CONCURRENCY || '5', 10);
    let aiPrimaryTag = 'AI';

    try {
        if (process.env.CONFIG_REPO) {
            const settings = await loadSettings();
            if (settings.worker_concurrency && typeof settings.worker_concurrency === 'number') {
                workerConcurrency = settings.worker_concurrency;
                logger.info({ concurrency: workerConcurrency }, 'Successfully loaded worker_concurrency from config repo');
            } else {
                logger.info({ concurrency: workerConcurrency }, 'Using worker_concurrency from environment variable');
            }
        }
    } catch (error) {
        logger.warn({ error: error.message }, 'Failed to load settings from config, using environment variable for worker_concurrency');
    }

    // Load AI primary tag
    try {
        aiPrimaryTag = await getAiPrimaryTag();
    } catch (error) {
        logger.warn({ error: error.message }, 'Failed to load AI primary tag, using default');
    }

    logger.info({
        queue: GITHUB_ISSUE_QUEUE_NAME,
        processingTag: AI_PROCESSING_TAG,
        primaryTag: aiPrimaryTag,
        doneTag: AI_DONE_TAG,
        concurrency: workerConcurrency,
        resetPerformed: options.reset || false
    }, 'Starting GitHub Issue Worker...');
    
    // Run database migrations if enabled
    if (isDbEnabled && db) {
        try {
            logger.info('Running database migrations...');
            await db.migrate.latest();
            logger.info('Database migrations completed successfully');
        } catch (error) {
            logger.error({
                error: error.message,
                stack: error.stack
            }, 'Database migration failed - worker will continue but database persistence may not work');
        }
    }
    
    // Initialize Redis connection for heartbeat
    const heartbeatRedis = new Redis({
        host: process.env.REDIS_HOST || 'localhost',
        port: process.env.REDIS_PORT || 6379,
        retryStrategy: times => Math.min(times * 50, 2000)
    });
    
    // Function to send heartbeat
    const sendHeartbeat = async () => {
        try {
            await heartbeatRedis.sadd('system:status:workers', workerId);
            await heartbeatRedis.expire('system:status:workers', 90);
            logger.debug('Worker heartbeat sent');
        } catch (error) {
            logger.error({ error: error.message }, 'Failed to send worker heartbeat');
        }
    };
    
    // Send initial heartbeat
    await sendHeartbeat();
    
    // Set up heartbeat interval (every 30 seconds)
    const heartbeatInterval = setInterval(sendHeartbeat, 30000);
    
    // Ensure Claude Docker image is built before starting worker
    logger.info('Checking Claude Code Docker image...');
    const imageReady = await buildClaudeDockerImage();
    
    if (!imageReady) {
        logger.error('Failed to build Claude Code Docker image. Worker may not function properly.');
        // Continue anyway - worker can still handle Git operations
    } else {
        logger.info('Claude Code Docker image is ready');
    }
    
    const worker = createWorker(GITHUB_ISSUE_QUEUE_NAME, async (job) => {
        if (job.name === 'processGitHubIssue') {
            return processGitHubIssueJob(job);
        } else if (job.name === 'processPullRequestComment') {
            return processPullRequestCommentJob(job);
        } else if (job.name === 'processTaskImport') {
            return processTaskImportJob(job);
        } else {
            throw new Error(`Unknown job type: ${job.name}`);
        }
    }, { concurrency: workerConcurrency });

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
        logger.info('Worker received SIGINT, shutting down gracefully...');
        await heartbeatRedis.srem('system:status:workers', workerId);
        clearInterval(heartbeatInterval);
        await heartbeatRedis.quit();
        await worker.close();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        logger.info('Worker received SIGTERM, shutting down gracefully...');
        await heartbeatRedis.srem('system:status:workers', workerId);
        clearInterval(heartbeatInterval);
        await heartbeatRedis.quit();
        await worker.close();
        process.exit(0);
    });

    return worker;
}

// Export for testing
export { processGitHubIssueJob, processPullRequestCommentJob, processTaskImportJob, startWorker };

// Start worker if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
    const options = parseArguments();
    
    if (options.help) {
        showHelp();
        process.exit(0);
    }
    
    async function main() {
        try {
            if (options.reset) {
                logger.info('Reset flag detected, clearing worker queue data...');
                await resetWorkerQueues();
                logger.info('Worker reset completed successfully');
            }
            
            await startWorker(options);
        } catch (error) {
            logger.error({ error: error.message }, 'Failed to start worker');
            process.exit(1);
        }
    }
    
    main();
}