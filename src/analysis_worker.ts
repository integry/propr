import 'dotenv/config';
import { Job, Worker } from 'bullmq';
import { createWorker, ANALYSIS_QUEUE_NAME } from './queue/taskQueue.js';
import type { AnalysisJobData, JobResult } from './queue/taskQueue.js';
import logger, { generateCorrelationId } from './utils/logger.js';
import { db } from './db/postgres.js';
import { getExecutionAnalysis } from './services/analysisService.js';
import { loadSettings } from './config/configRepoManager.js';
import { resolveModelAlias } from './config/modelAliases.js';

process.on('uncaughtException', (error: Error) => {
    logger.fatal({ error: error.message, stack: error.stack }, 'Uncaught exception in analysis worker');
    process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
    logger.fatal({ reason }, 'Unhandled rejection in analysis worker');
    process.exit(1);
});

interface AnalysisResult extends JobResult {
    success: boolean;
}

async function processAnalysisJob(job: Job<AnalysisJobData>): Promise<AnalysisResult> {
    const { executionId, sessionId, correlationId } = job.data;
    const correlatedLogger = logger.withCorrelation(correlationId);
    correlatedLogger.info({ executionId }, 'Starting execution analysis job...');

    try {
        const settings = await loadSettings();
        const configuredModel = (settings.analysis_model_fast as string) || 'haiku';
        const fastModel = resolveModelAlias(configuredModel);

        const analysisReport = await getExecutionAnalysis({
            executionId,
            sessionId,
            correlationId,
            model: fastModel,
        });

        if (db) {
            await db('llm_executions')
                .where({ execution_id: executionId })
                .update({ analysis_report: analysisReport });
        }

        correlatedLogger.info({ executionId }, 'Execution analysis complete and saved.');
        return { status: 'completed', success: true };
    } catch (error) {
        const err = error as Error;
        correlatedLogger.error({ executionId, error: err.message }, 'Execution analysis job failed');
        throw error;
    }
}

function startAnalysisWorker(): Worker<AnalysisJobData, AnalysisResult> {
    const workerId = `analysis-worker:${generateCorrelationId()}`;

    logger.info({
        queue: ANALYSIS_QUEUE_NAME,
        concurrency: 2,
        workerId
    }, 'Starting Analysis Worker...');

    const worker = createWorker<AnalysisJobData, AnalysisResult>(ANALYSIS_QUEUE_NAME, processAnalysisJob, { concurrency: 2 });

    process.on('SIGINT', async () => {
        logger.info('Analysis Worker received SIGINT, shutting down gracefully...');
        await worker.close();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        logger.info('Analysis Worker received SIGTERM, shutting down gracefully...');
        await worker.close();
        process.exit(0);
    });

    return worker;
}

export { processAnalysisJob, startAnalysisWorker };

if (import.meta.url === `file://${process.argv[1]}`) {
    startAnalysisWorker();
}
