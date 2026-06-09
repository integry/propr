import 'dotenv/config';
import { Job, Worker } from 'bullmq';
import type { Logger } from 'pino';
import { simpleGit } from 'simple-git';
import { createWorker, INDEXING_QUEUE_NAME, indexingQueue } from '@propr/core';
import type { IndexingJobData, JobResult } from '@propr/core';
import { logger } from '@propr/core';
import { generateCorrelationId } from '@propr/core';
import { db } from '@propr/core';
import { indexRepo, scanProcessableGitFiles, updateRepositoryStatus } from '@propr/core';
import { loadSummarizationSettings, loadMonitoredReposRaw } from '@propr/core';
import type { RepoToMonitor } from '@propr/core';
import { ensureRepoCloned, getRepoUrl, getAuthenticatedOctokit, fetchLatestChanges } from '@propr/core';

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
    const { repository, repoPath, correlationId, fullReindex, baseBranch = 'HEAD' } = job.data;
    const correlatedLogger = logger.withCorrelation(correlationId);
    const startTime = Date.now();

    correlatedLogger.info({ repository, repoPath, fullReindex, branch: baseBranch }, 'Starting indexing job...');

    try {
        // Check if summarization is enabled
        const settings = await loadSummarizationSettings();
        if (!settings.enabled) {
            correlatedLogger.info('Summarization is disabled, skipping indexing job');
            return { status: 'skipped', success: true };
        }

        // Run the indexing
        // Note: We no longer clear summaries before indexing. If fullReindex is true,
        // indexRepo will process all files but preserve existing summaries as fallback
        // in case of failure. Old summaries for deleted files are cleaned up by indexRepo.
        await indexRepo(repoPath, {
            correlationId,
            fullName: repository,
            branch: baseBranch,
            fullReindex
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
    branch: string;
    indexing_status: string;
    last_indexed_at: string | null;
    updated_at: string | null;
    last_indexed_hash: string | null;
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
function shouldIndexRepository(repoStatus: RepoStatus | undefined, currentHash?: string): IndexDecision {
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

    // Check for new commits - if current hash differs from last indexed hash
    if (currentHash && repoStatus.last_indexed_hash && currentHash !== repoStatus.last_indexed_hash) {
        return { shouldIndex: true, reason: 'new commits detected' };
    }

    // If hash is missing (first run after migration), trigger indexing to populate it
    if (currentHash && !repoStatus.last_indexed_hash) {
        return { shouldIndex: true, reason: 'missing index hash' };
    }

    // Fallback: Re-index if stale (24 hour safety net)
    const lastIndexed = repoStatus.last_indexed_at ? new Date(repoStatus.last_indexed_at) : null;
    if (lastIndexed && (Date.now() - lastIndexed.getTime()) > REINDEX_INTERVAL_MS) {
        return { shouldIndex: true, reason: 'stale index' };
    }

    return { shouldIndex: false, reason: 'up to date' };
}

async function getIndexCompleteness(repoName: string, repoPath: string, branch: string, log: Logger): Promise<{
    complete: boolean;
    indexedCount: number;
    processableCount: number;
    missingCount: number;
}> {
    const processableFiles = await scanProcessableGitFiles(repoPath, log);
    const processablePaths = processableFiles.map(file => `${repoName}/${file.path}`);

    if (processablePaths.length === 0) {
        return { complete: true, indexedCount: 0, processableCount: 0, missingCount: 0 };
    }

    const CHUNK_SIZE = 500;
    let indexedCount = 0;
    for (let i = 0; i < processablePaths.length; i += CHUNK_SIZE) {
        const chunk = processablePaths.slice(i, i + CHUNK_SIZE);
        const result = await db('file_summaries')
            .whereIn('path', chunk)
            .andWhere({ branch })
            .count<{ count: number | string }>('path as count')
            .first();
        indexedCount += Number(result?.count || 0);
    }

    const missingCount = processablePaths.length - indexedCount;
    return {
        complete: missingCount === 0,
        indexedCount,
        processableCount: processablePaths.length,
        missingCount
    };
}

/**
 * Clone a repository and return its local path
 */
async function cloneRepositoryForIndexing(repoName: string, branch: string): Promise<string> {
    const [owner, name] = repoName.split('/');
    const octokit = await getAuthenticatedOctokit();
    const { token } = await octokit.auth({ type: "installation" }) as { token: string };
    const repoUrl = getRepoUrl({ repoOwner: owner, repoName: name });
    // ensureRepoCloned already supports baseBranch - pass it unless it's HEAD
    return ensureRepoCloned({
        repoUrl,
        owner,
        repoName: name,
        authToken: token,
        baseBranch: branch === 'HEAD' ? undefined : branch
    });
}

interface QueueIndexingJobOptions {
    repoName: string;
    repoPath: string;
    reason: string;
    log: Logger;
    branch: string;
}

/**
 * Queue an indexing job for a repository
 */
async function queueIndexingJob(options: QueueIndexingJobOptions): Promise<void> {
    const { repoName, repoPath, reason, log, branch } = options;

    // Final check right before queueing to prevent race conditions
    // (the earlier check may be stale due to slow clone operations)
    const existingJobs = await indexingQueue.getJobs(['waiting', 'active', 'delayed', 'prioritized']);
    const alreadyQueued = existingJobs.some((j: { data: IndexingJobData }) =>
        j.data.repository === repoName && (j.data.baseBranch || 'HEAD') === branch
    );

    if (alreadyQueued) {
        log.debug({ repository: repoName, branch }, 'Indexing job already queued (final check), skipping');
        return;
    }

    const jobCorrelationId = generateCorrelationId();
    const priority = reason === 'previous indexing failed' ? 'high' : 'normal';

    await indexingQueue.add(
        'indexRepository',
        {
            repository: repoName,
            repoPath,
            correlationId: jobCorrelationId,
            priority,
            baseBranch: branch
        },
        {
            jobId: `index-${repoName.replace('/', '-')}-${branch}-${Date.now()}`,
            priority: reason === 'previous indexing failed' ? 1 : 5
        }
    );

    await updateRepositoryStatus(repoName, 'indexing', branch);
    log.info({ repository: repoName, branch, reason, jobCorrelationId }, 'Queued repository for indexing');
}

/**
 * Process a single repository for potential indexing
 */
async function processRepositoryForIndexing(
    repoConfig: RepoToMonitor,
    log: Logger
): Promise<void> {
    const repoName = repoConfig.name;
    const branch = repoConfig.baseBranch || 'HEAD';

    const repoStatus = await db('repositories')
        .where({ full_name: repoName, branch })
        .first() as RepoStatus | undefined;

    // If currently indexing, perform quick stuck check without cloning
    if (repoStatus?.indexing_status === 'indexing') {
        const decision = shouldIndexRepository(repoStatus);
        if (!decision.shouldIndex) {
            log.debug({ repository: repoName, branch, reason: decision.reason }, 'Skipping repository');
            return;
        }
    }

    // Check if job already queued before cloning to save bandwidth
    const existingJobs = await indexingQueue.getJobs(['waiting', 'active', 'delayed', 'prioritized']);
    const alreadyQueued = existingJobs.some((j: { data: IndexingJobData }) =>
        j.data.repository === repoName && (j.data.baseBranch || 'HEAD') === branch
    );

    if (alreadyQueued) {
        log.debug({ repository: repoName, branch }, 'Indexing job already queued, skipping');
        return;
    }

    // Clone/fetch to get latest state
    const repoPath = await cloneRepositoryForIndexing(repoName, branch);

    // Explicitly fetch latest changes before getting the hash
    // This ensures we have the most up-to-date remote state for comparison
    const [owner, name] = repoName.split('/');
    const octokit = await getAuthenticatedOctokit();
    const { token } = await octokit.auth({ type: "installation" }) as { token: string };

    const fetchResult = await fetchLatestChanges({
        owner,
        repoName: name,
        authToken: token,
        branch: branch === 'HEAD' ? undefined : branch
    });

    if (!fetchResult.success) {
        log.warn(
            { repository: repoName, branch, error: fetchResult.error },
            'Failed to fetch latest changes, will continue with existing local state'
        );
    } else {
        log.info({ repository: repoName, branch }, 'Successfully fetched latest changes before indexing check');
    }

    // Get the hash of the configured branch (not just HEAD, since same repo can track different branches)
    // This hash should now reflect the freshly fetched remote state
    let currentHash: string | undefined;
    try {
        const git = simpleGit(repoPath);
        // Use origin refs to get the remote branch state, not the local checkout state.
        // For 'HEAD', use origin/HEAD (the remote's default branch), not local HEAD
        // (which is whatever branch happens to be checked out locally).
        const refToResolve = branch === 'HEAD' ? 'origin/HEAD' : `origin/${branch}`;
        currentHash = await git.revparse([refToResolve]);
    } catch (hashError) {
        log.warn({ repository: repoName, branch, error: (hashError as Error).message }, 'Failed to get branch hash');
    }

    const decision = shouldIndexRepository(repoStatus, currentHash);

    if (!decision.shouldIndex && repoStatus?.indexing_status === 'completed') {
        const completeness = await getIndexCompleteness(repoName, repoPath, branch, log);
        if (!completeness.complete) {
            decision.shouldIndex = true;
            decision.reason = 'completed index is missing summaries';
            log.info({ repository: repoName, branch, ...completeness }, 'Completed index is incomplete, queueing reindex');
        }
    }

    if (!decision.shouldIndex) {
        log.debug({ repository: repoName, branch, reason: decision.reason, currentHash, lastIndexedHash: repoStatus?.last_indexed_hash }, 'Skipping repository');
        return;
    }

    await queueIndexingJob({ repoName, repoPath, reason: decision.reason, log, branch });
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

        // Load full config objects to access baseBranch
        const repos = await loadMonitoredReposRaw();
        const enabledRepos = repos.filter(r => r.enabled);

        if (enabledRepos.length === 0) {
            correlatedLogger.debug('No monitored repositories configured');
            return;
        }

        correlatedLogger.info({ repoCount: enabledRepos.length }, 'Scanning repositories for indexing');

        for (const repoConfig of enabledRepos) {
            try {
                await processRepositoryForIndexing(repoConfig, correlatedLogger);
            } catch (repoError) {
                correlatedLogger.error(
                    { repository: repoConfig.name, branch: repoConfig.baseBranch || 'HEAD', error: (repoError as Error).message },
                    'Error processing repository for indexing'
                );
            }
        }
    } catch (error) {
        correlatedLogger.error({ error: (error as Error).message }, 'Failed to scan repositories for indexing');
    }
}

async function startIndexingWorker(): Promise<Worker<IndexingJobData, IndexingResult>> {
    const workerId = `indexing-worker:${generateCorrelationId()}`;

    logger.info({
        queue: INDEXING_QUEUE_NAME,
        concurrency: 1, // Process one repo at a time to avoid overwhelming the system
        workerId,
        scanIntervalMs: SCAN_INTERVAL_MS,
        reindexIntervalMs: REINDEX_INTERVAL_MS
    }, 'Starting Indexing Worker...');

    const worker = await createWorker<IndexingJobData, IndexingResult>(
        INDEXING_QUEUE_NAME,
        processIndexingJob,
        { concurrency: 1 }
    );

    // Handle failed jobs - update repository status
    worker.on('failed', async (job, error) => {
        if (job?.data?.repository) {
            const branch = job.data.baseBranch || 'HEAD';
            logger.error(
                { repository: job.data.repository, branch, error: error.message },
                'Indexing job failed, marking repository as failed'
            );
            try {
                await updateRepositoryStatus(job.data.repository, 'failed', branch);
            } catch (updateError) {
                logger.error(
                    { repository: job.data.repository, branch, error: (updateError as Error).message },
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
    startIndexingWorker().catch(err => {
        logger.error({ error: err.message }, 'Failed to start indexing worker');
        process.exit(1);
    });
}
