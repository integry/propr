import 'dotenv/config';
import { Job, Worker } from 'bullmq';
import type { Logger } from 'pino';
import { createWorker, INDEXING_QUEUE_NAME, indexingQueue } from '@gitfix/core';
import type { IndexingJobData, JobResult } from '@gitfix/core';
import { logger } from '@gitfix/core';
import { generateCorrelationId } from '@gitfix/core';
import { db } from '@gitfix/core';
import { indexRepo, clearRepositorySummaries, updateRepositoryStatus } from '@gitfix/core';
import { loadSummarizationSettings, loadMonitoredRepos } from '@gitfix/core';
import { ensureRepoCloned, getRepoUrl, getAuthenticatedOctokit } from '@gitfix/core';

process.on('uncaughtException', (error: Error) => {
    logger.fatal({ error: error.message, stack: error.stack }, 'Uncaught exception in indexing worker');
    process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
    logger.fatal({ reason }, 'Unhandled rejection in indexing worker');
    process.exit(1);
});

interface IndexingResult extends JobResult {
    success: boolean;
    filesProcessed?: number;
    duration?: number;
}

// How often to scan for repos needing indexing (default: 5 minutes)
const SCAN_INTERVAL_MS = parseInt(process.env.INDEXING_SCAN_INTERVAL_MS || '300000', 10);

// How often to re-index repos that are already indexed (default: 24 hours)
const REINDEX_INTERVAL_MS = parseInt(process.env.INDEXING_REINDEX_INTERVAL_MS || '86400000', 10);

/**
 * Process a single indexing job
 */
async function processIndexingJob(job: Job<IndexingJobData>): Promise<IndexingResult> {
    const { repository, repoPath, correlationId, fullReindex } = job.data;
    const correlatedLogger = logger.withCorrelation(correlationId);
    const startTime = Date.now();

    correlatedLogger.info({ repository, repoPath, fullReindex }, 'Starting indexing job...');

    try {
        // Check if summarization is enabled
        const settings = await loadSummarizationSettings();
        if (!settings.enabled) {
            correlatedLogger.info('Summarization is disabled, skipping indexing job');
            return { status: 'skipped', success: true };
        }

        // If full reindex requested, clear existing summaries first
        if (fullReindex) {
            correlatedLogger.info({ repository }, 'Full reindex requested, clearing existing summaries');
            await clearRepositorySummaries(repository);
        }

        // Run the indexing
        await indexRepo(repoPath, {
            correlationId,
            fullName: repository
        });

        const duration = Date.now() - startTime;
        correlatedLogger.info({ repository, duration }, 'Indexing job completed successfully');

        return {
            status: 'completed',
            success: true,
            duration
        };
    } catch (error) {
        const err = error as Error;
        correlatedLogger.error(
            { repository, error: err.message, stack: err.stack },
            'Indexing job failed'
        );
        throw error;
    }
}

interface RepoStatus {
    full_name: string;
    indexing_status: string;
    last_indexed_at: string | null;
    updated_at: string | null;
}

interface IndexDecision {
    shouldIndex: boolean;
    reason: string;
}

// Consider indexing stuck if status hasn't changed in 30 minutes
const STUCK_INDEXING_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Determine if a repository needs indexing based on its status
 */
function shouldIndexRepository(repoStatus: RepoStatus | undefined): IndexDecision {
    if (!repoStatus || repoStatus.indexing_status === 'idle') {
        return { shouldIndex: true, reason: 'never indexed' };
    }
    if (repoStatus.indexing_status === 'failed') {
        return { shouldIndex: true, reason: 'previous indexing failed' };
    }
    if (repoStatus.indexing_status === 'indexing') {
        // Check if stuck (status unchanged for too long)
        const updatedAt = repoStatus.updated_at ? new Date(repoStatus.updated_at) : null;
        if (updatedAt && (Date.now() - updatedAt.getTime()) > STUCK_INDEXING_TIMEOUT_MS) {
            return { shouldIndex: true, reason: 'stuck indexing (timeout recovery)' };
        }
        return { shouldIndex: false, reason: 'currently indexing' };
    }

    const lastIndexed = repoStatus.last_indexed_at ? new Date(repoStatus.last_indexed_at) : null;
    if (lastIndexed && (Date.now() - lastIndexed.getTime()) > REINDEX_INTERVAL_MS) {
        return { shouldIndex: true, reason: 'stale index' };
    }

    return { shouldIndex: false, reason: 'up to date' };
}

/**
 * Clone a repository and return its local path
 */
async function cloneRepositoryForIndexing(repoName: string): Promise<string> {
    const [owner, name] = repoName.split('/');
    const octokit = await getAuthenticatedOctokit();
    const { token } = await octokit.auth({ type: "installation" }) as { token: string };
    const repoUrl = getRepoUrl({ repoOwner: owner, repoName: name });
    return ensureRepoCloned({ repoUrl, owner, repoName: name, authToken: token });
}

/**
 * Queue an indexing job for a repository
 */
async function queueIndexingJob(
    repoName: string,
    repoPath: string,
    reason: string,
    log: Logger
): Promise<void> {
    const jobCorrelationId = generateCorrelationId();
    const priority = reason === 'previous indexing failed' ? 'high' : 'normal';

    await indexingQueue.add(
        'indexRepository',
        {
            repository: repoName,
            repoPath,
            correlationId: jobCorrelationId,
            priority
        },
        {
            jobId: `index-${repoName.replace('/', '-')}-${Date.now()}`,
            priority: reason === 'previous indexing failed' ? 1 : 5
        }
    );

    log.info({ repository: repoName, reason, jobCorrelationId }, 'Queued repository for indexing');
}

/**
 * Process a single repository for potential indexing
 */
async function processRepositoryForIndexing(
    repoName: string,
    log: Logger
): Promise<void> {
    const repoStatus = await db('repositories')
        .where({ full_name: repoName })
        .first() as RepoStatus | undefined;

    const decision = shouldIndexRepository(repoStatus);

    if (!decision.shouldIndex) {
        log.debug({ repository: repoName, reason: decision.reason }, 'Skipping repository');
        return;
    }

    // Check if job already queued
    const existingJobs = await indexingQueue.getJobs(['waiting', 'active', 'delayed']);
    const alreadyQueued = existingJobs.some((j: { data: IndexingJobData }) => j.data.repository === repoName);

    if (alreadyQueued) {
        log.debug({ repository: repoName }, 'Indexing job already queued, skipping');
        return;
    }

    // Clone and queue
    const repoPath = await cloneRepositoryForIndexing(repoName);
    await queueIndexingJob(repoName, repoPath, decision.reason, log);
}

/**
 * Scan monitored repositories and queue indexing jobs for those needing updates
 */
async function scanAndQueueRepositories(): Promise<void> {
    const correlationId = generateCorrelationId();
    const correlatedLogger = logger.withCorrelation(correlationId);

    try {
        const settings = await loadSummarizationSettings();
        if (!settings.enabled || !settings.agent_alias) {
            correlatedLogger.debug('Summarization not fully configured, skipping repository scan');
            return;
        }

        const repos = await loadMonitoredRepos();
        if (repos.length === 0) {
            correlatedLogger.debug('No monitored repositories configured');
            return;
        }

        correlatedLogger.info({ repoCount: repos.length }, 'Scanning repositories for indexing');

        for (const repoName of repos) {
            try {
                await processRepositoryForIndexing(repoName, correlatedLogger);
            } catch (repoError) {
                correlatedLogger.error(
                    { repository: repoName, error: (repoError as Error).message },
                    'Error processing repository for indexing'
                );
            }
        }
    } catch (error) {
        correlatedLogger.error({ error: (error as Error).message }, 'Failed to scan repositories for indexing');
    }
}

function startIndexingWorker(): Worker<IndexingJobData, IndexingResult> {
    const workerId = `indexing-worker:${generateCorrelationId()}`;

    logger.info({
        queue: INDEXING_QUEUE_NAME,
        concurrency: 1, // Process one repo at a time to avoid overwhelming the system
        workerId,
        scanIntervalMs: SCAN_INTERVAL_MS,
        reindexIntervalMs: REINDEX_INTERVAL_MS
    }, 'Starting Indexing Worker...');

    const worker = createWorker<IndexingJobData, IndexingResult>(
        INDEXING_QUEUE_NAME,
        processIndexingJob,
        { concurrency: 1 }
    );

    // Handle failed jobs - update repository status
    worker.on('failed', async (job, error) => {
        if (job?.data?.repository) {
            logger.error(
                { repository: job.data.repository, error: error.message },
                'Indexing job failed, marking repository as failed'
            );
            try {
                await updateRepositoryStatus(job.data.repository, 'failed');
            } catch (updateError) {
                logger.error(
                    { repository: job.data.repository, error: (updateError as Error).message },
                    'Failed to update repository status after job failure'
                );
            }
        }
    });

    // Start periodic repository scanning
    const scanInterval = setInterval(async () => {
        try {
            await scanAndQueueRepositories();
        } catch (error) {
            logger.error({ error: (error as Error).message }, 'Error in periodic repository scan');
        }
    }, SCAN_INTERVAL_MS);

    // Run initial scan after a short delay to allow worker to fully start
    setTimeout(async () => {
        try {
            logger.info('Running initial repository scan...');
            await scanAndQueueRepositories();
        } catch (error) {
            logger.error({ error: (error as Error).message }, 'Error in initial repository scan');
        }
    }, 5000);

    process.on('SIGINT', async () => {
        logger.info('Indexing Worker received SIGINT, shutting down gracefully...');
        clearInterval(scanInterval);
        await worker.close();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        logger.info('Indexing Worker received SIGTERM, shutting down gracefully...');
        clearInterval(scanInterval);
        await worker.close();
        process.exit(0);
    });

    return worker;
}

export { processIndexingJob, startIndexingWorker, scanAndQueueRepositories };

if (import.meta.url === `file://${process.argv[1]}`) {
    startIndexingWorker();
}
