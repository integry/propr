import 'dotenv/config';
import { Job, Worker } from 'bullmq';
import { createWorker, ANALYSIS_QUEUE_NAME } from '@gitfix/core';
import type { AnalysisJobData, JobResult } from '@gitfix/core';
import { logger } from '@gitfix/core';
import { generateCorrelationId } from '@gitfix/core';
import { db } from '@gitfix/core';
import { getExecutionAnalysis } from '@gitfix/core';
import { loadSettings } from '@gitfix/core';
import { resolveModelAlias } from '@gitfix/core';
import { resolveAgentFromSetting } from '@gitfix/core';
import { AgentRegistry } from '@gitfix/core';

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
        // Ensure agent registry is initialized
        const registry = AgentRegistry.getInstance();
        await registry.ensureInitialized();

        const settings = await loadSettings();
        const configuredSetting = (settings.analysis_model_fast as string) || 'haiku';

        // Try to resolve as alias:model format first, fall back to model alias resolution
        let fastModel: string;
        const agentResolution = resolveAgentFromSetting(configuredSetting);

        if (agentResolution) {
            // Setting was in alias:model format or matched an agent alias
            fastModel = agentResolution.model;
            correlatedLogger.info({
                configuredSetting,
                agentAlias: agentResolution.agent.config.alias,
                resolvedModel: fastModel
            }, 'Resolved analysis model from agent setting');
        } else {
            // Fall back to legacy model alias resolution
            fastModel = resolveModelAlias(configuredSetting);
            correlatedLogger.info({
                configuredSetting,
                resolvedModel: fastModel
            }, 'Resolved analysis model from model alias (legacy)');
        }

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
