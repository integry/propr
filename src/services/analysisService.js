import Redis from 'ioredis';
import { db } from '../db/postgres.js';
import { generateExecutionAnalysisPrompt } from '../claude/prompts/promptGenerator.js';
import { runLightweightLLMAnalysis } from '../claude/claudeService.js';
import logger from '../utils/logger.js';

const redis = new Redis({
  host: process.env.REDIS_HOST || 'redis',
  port: process.env.REDIS_PORT || 6379,
});

export async function getExecutionAnalysis({ executionId, sessionId, correlationId, model }) {
  const correlatedLogger = logger.withCorrelation(correlationId);

  try {
    const promptKey = `execution:prompt:session:${sessionId}`;
    const promptData = JSON.parse(await redis.get(promptKey) || '{}');
    const originalPrompt = promptData.prompt || 'Original prompt not found.';

    const conversationLog = await db('llm_execution_details')
      .where({ execution_id: executionId })
      .orderBy('sequence_number', 'asc');
    
    if (conversationLog.length === 0) {
      correlatedLogger.warn({ executionId }, 'No execution details found for analysis.');
      return { error: 'No execution details found.' };
    }

    const metaPrompt = generateExecutionAnalysisPrompt(originalPrompt, conversationLog, model);

    const analysisText = await runLightweightLLMAnalysis(metaPrompt, model, correlationId);
    
    const analysisReport = {
      generatedAt: new Date().toISOString(),
      modelUsed: model,
      report: analysisText,
    };

    return analysisReport;
  } catch (error) {
    correlatedLogger.error({ 
      executionId, 
      error: error.message,
      stack: error.stack 
    }, 'Failed to generate execution analysis');
    throw error;
  }
}
