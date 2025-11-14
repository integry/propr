import 'dotenv/config';
import { createWorker, ANALYSIS_QUEUE_NAME } from './queue/taskQueue.js';
import logger, { generateCorrelationId } from './utils/logger.js';
import { db } from './db/postgres.js';
import { getExecutionAnalysis } from './services/analysisService.js';
import { loadSettings } from './config/configRepoManager.js';

async function processAnalysisJob(job) {
  const { executionId, sessionId, correlationId } = job.data;
  const correlatedLogger = logger.withCorrelation(correlationId);
  correlatedLogger.info({ executionId }, 'Starting execution analysis job...');

  try {
    const settings = await loadSettings();
    const fastModel = settings.analysis_model_fast || 'claude-haiku-4-5';

    const analysisReport = await getExecutionAnalysis({
      executionId,
      sessionId,
      correlationId,
      model: fastModel,
    });

    await db('llm_executions')
      .where({ execution_id: executionId })
      .update({ analysis_report: JSON.stringify(analysisReport) });

    correlatedLogger.info({ executionId }, 'Execution analysis complete and saved.');
    return { success: true };
  } catch (error) {
    correlatedLogger.error({ executionId, error: error.message }, 'Execution analysis job failed');
    throw error;
  }
}

function startAnalysisWorker() {
  const workerId = `analysis-worker:${generateCorrelationId()}`;
  
  logger.info({
    queue: ANALYSIS_QUEUE_NAME,
    concurrency: 2,
    workerId
  }, 'Starting Analysis Worker...');
  
  const worker = createWorker(ANALYSIS_QUEUE_NAME, processAnalysisJob, { concurrency: 2 });

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
