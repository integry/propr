import { Queue, Worker } from 'bullmq'; 
import Redis from 'ioredis';
import logger from '../utils/logger.js';
import 'dotenv/config';

// Redis configuration
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);

const connectionOptions = {
    host: REDIS_HOST,
    port: REDIS_PORT,
    maxRetriesPerRequest: null, // Important for BullMQ
    enableReadyCheck: false,
};

// Create Redis connection
const redisConnection = new Redis(connectionOptions);

redisConnection.on('connect', () => {
    logger.info('Successfully connected to Redis for BullMQ.');
});

redisConnection.on('error', (err) => {
    logger.error({ err }, 'Redis connection error for BullMQ.');
});

// Queue configuration
export const GITHUB_ISSUE_QUEUE_NAME = process.env.GITHUB_ISSUE_QUEUE_NAME || 'github-issue-processor';
 
// Comment batching delay in milliseconds (default: 3000ms / 3 seconds)
export const COMMENT_BATCH_DELAY_MS = parseInt(process.env.COMMENT_BATCH_DELAY_MS || '3000', 10);

// Create the issue processing queue
export const issueQueue = new Queue(GITHUB_ISSUE_QUEUE_NAME, {
    connection: redisConnection,
    defaultJobOptions: {
        attempts: 3,
        backoff: {
            type: 'exponential',
            delay: 2000,
        },
        removeOnComplete: {
            age: 24 * 3600, // Keep completed jobs for 24 hours
            count: 1000,    // Keep max 1000 completed jobs
        },
        removeOnFail: {
            age: 7 * 24 * 3600, // Keep failed jobs for 7 days
        },
    },
});

issueQueue.on('error', (err) => {
    logger.error({ queue: GITHUB_ISSUE_QUEUE_NAME, err }, 'Queue error');
});

export const ANALYSIS_QUEUE_NAME = process.env.ANALYSIS_QUEUE_NAME || 'analysis-processor';

export const analysisQueue = new Queue(ANALYSIS_QUEUE_NAME, {
    connection: redisConnection,
    defaultJobOptions: {
        attempts: 2,
        backoff: {
            type: 'exponential',
            delay: 60000,
        },
        removeOnComplete: {
            age: 24 * 3600,
            count: 1000,
        },
        removeOnFail: true,
    },
});

analysisQueue.on('error', (err) => {
    logger.error({ queue: ANALYSIS_QUEUE_NAME, err }, 'Analysis Queue error');
});

/**
 * Creates and starts a BullMQ worker
 * @param {string} queueName - The name of the queue to process
 * @param {Function} processorFunction - The async function to process jobs
 * @param {Object} options - Optional worker configuration
 * @param {number} options.concurrency - Worker concurrency (defaults to env var or 5)
 * @returns {Worker} The created worker instance
 */
export function createWorker(queueName, processorFunction, options = {}) {
    const concurrency = options.concurrency || parseInt(process.env.WORKER_CONCURRENCY || '5', 10);
    const worker = new Worker(queueName, processorFunction, {
        connection: redisConnection,
        concurrency: concurrency,
        autorun: true,
    });

    worker.on('completed', async (job, result) => {
        const duration = Date.now() - job.timestamp;
        logger.info({ 
            jobId: job.id, 
            jobName: job.name, 
            result,
            duration
        }, 'Job completed successfully');
        
        // Update metrics
        try {
            const metricsRedis = new Redis(connectionOptions);
            const dateKey = new Date().toISOString().split('T')[0];
            
            // Update overall metrics
            await metricsRedis.incr('metrics:jobs:processed');
            await metricsRedis.incr(`metrics:daily:${dateKey}:processed`);
            
            // Update average processing time
            const totalProcessed = await metricsRedis.get('metrics:jobs:processed') || '1';
            const currentAvg = parseFloat(await metricsRedis.get('metrics:jobs:avgTime') || '0');
            const newAvg = ((currentAvg * (parseInt(totalProcessed) - 1)) + (duration / 1000)) / parseInt(totalProcessed);
            await metricsRedis.set('metrics:jobs:avgTime', newAvg.toFixed(2));
            
            // Track active repository
            const repoFullName = job.data?.repository || (job.data?.repoOwner && job.data?.repoName ? `${job.data.repoOwner}/${job.data.repoName}` : null);
            if (repoFullName) {
                await metricsRedis.sadd('active:repositories', repoFullName);
            }
            
            // Log activity
            const activity = {
                id: `activity-${Date.now()}-${job.id}`,
                type: job.name === 'processGitHubIssue' ? 'issue_processed' : 'pr_processed',
                timestamp: new Date().toISOString(),
                repository: repoFullName,
                issueNumber: job.data?.issueNumber,
                description: `Successfully processed ${job.name === 'processGitHubIssue' ? 'issue' : 'PR'} #${job.data?.issueNumber || 'unknown'}`,
                status: 'success'
            };

            // Store detailed AI metrics in a Sorted Set for time-based querying
            if (result?.claudeResult) {
                const cost = result.claudeResult.claudeCostUsd || result.claudeResult.costUsd || result.claudeResult.finalResult?.cost_usd || 0;
                const aiMetrics = {
                    timestamp: job.timestamp, // Use job start time
                    cost: typeof cost === 'string' ? parseFloat(cost) : cost,
                    model: result.claudeResult.model || job.data?.modelName || 'unknown',
                    turns: result.claudeResult.claudeNumTurns || result.claudeResult.finalResult?.num_turns || 0,
                    executionTimeMs: result.claudeResult.executionTime || 0,
                    issueNumber: job.data?.number,
                    repo: repoFullName,
                    status: 'success',
                    correlationId: job.data?.correlationId || result.correlationId,
                };
                // Use timestamp as score for the sorted set
                await metricsRedis.zadd('metrics:ai:log:v1', job.timestamp, JSON.stringify(aiMetrics));
            }

            await metricsRedis.lpush('system:activity:log', JSON.stringify(activity));
            await metricsRedis.ltrim('system:activity:log', 0, 999); // Keep last 1000 activities
            
            await metricsRedis.quit();
        } catch (error) {
            logger.error({ error: error.message }, 'Failed to update metrics');
        }
    });

    worker.on('failed', async (job, err) => {
        logger.error({ 
            jobId: job?.id, 
            jobName: job?.name, 
            data: job?.data, 
            errMessage: err.message, 
            stack: err.stack,
            attemptsMade: job?.attemptsMade
        }, 'Job failed');
        
        // Update failure metrics
        try {
            const metricsRedis = new Redis(connectionOptions);
            const dateKey = new Date().toISOString().split('T')[0];
            
            // Update failure metrics
            await metricsRedis.incr('metrics:jobs:failed');
            await metricsRedis.incr(`metrics:daily:${dateKey}:failed`);
            
            // Log failed AI metrics to sorted set for complete statistics
            const repoFullName = job?.data?.repository || (job?.data?.repoOwner && job?.data?.repoName ? `${job.data.repoOwner}/${job.data.repoName}` : null);
            const aiMetrics = {
                timestamp: job.timestamp,
                cost: 0, // Failed jobs may still incur cost, but we log 0 for aggregation logic
                model: job.data?.modelName || 'unknown',
                turns: 0,
                executionTimeMs: (job.finishedOn ? job.finishedOn : Date.now()) - (job.timestamp || Date.now()),
                issueNumber: job.data?.number,
                repo: repoFullName,
                status: 'failed',
                correlationId: job.data?.correlationId,
                error: err.message.substring(0, 100), // Log snippet of error
            };
            // Use timestamp as score
            if (job.timestamp) { // Ensure timestamp exists
                 await metricsRedis.zadd('metrics:ai:log:v1', job.timestamp, JSON.stringify(aiMetrics));
            }

            // Log activity
            const activity = {
                id: `activity-${Date.now()}-${job?.id || 'unknown'}`,
                type: 'error',
                timestamp: new Date().toISOString(),
                repository: repoFullName,
                issueNumber: job?.data?.issueNumber,
                description: `Failed to process ${job?.name === 'processGitHubIssue' ? 'issue' : 'PR'} #${job?.data?.issueNumber || 'unknown'}: ${err.message}`,
                status: 'error'
            };
            await metricsRedis.lpush('system:activity:log', JSON.stringify(activity));
            await metricsRedis.ltrim('system:activity:log', 0, 999); // Keep last 1000 activities
            
            await metricsRedis.quit();
        } catch (error) {
            logger.error({ error: error.message }, 'Failed to update failure metrics');
        }
    });

    worker.on('error', (err) => {
        logger.error({ 
            queue: queueName, 
            errMessage: err.message 
        }, 'Worker error');
    });

    worker.on('stalled', (jobId) => {
        logger.warn({ jobId }, 'Job stalled and will be retried');
    });

    logger.info({ 
        queue: queueName,
        concurrency: worker.opts.concurrency 
    }, 'Worker started and listening to queue');
    
    return worker;
}

/**
 * Gracefully shuts down the queue and Redis connection
 */
export async function shutdownQueue() {
    logger.info('Shutting down queue...');
    
    try {
        await issueQueue.close();
        await analysisQueue.close();
        await redisConnection.quit();
        logger.info('Queue shutdown complete');
    } catch (err) {
        logger.error({ err }, 'Error during queue shutdown');
        throw err;
    }
}