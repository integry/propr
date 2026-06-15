import type { Logger } from 'pino';
import { Agent } from '../../agents/types.js';
import { db } from '../../db/connection.js';
import { logSummarizationCall } from './summaryMinerMetrics.js';
import { persistLlmLog, createLlmLogFromAnalysis } from '../../utils/llmLogger.js';
import type { BatchFile } from './summaryMinerBatch.js';

export interface SummaryResult {
  path: string;
  summary: string;
}

interface SaveBatchSummariesOptions {
  fullName: string;
  batch: BatchFile[];
  summaries: SummaryResult[];
  modelUsed: string;
  branch: string;
}

export async function saveBatchSummaries(options: SaveBatchSummariesOptions): Promise<void> {
  const { fullName, batch, summaries, modelUsed, branch } = options;
  const summaryMap = new Map(summaries.map(s => [s.path, s.summary]));

  for (const file of batch) {
    const summary = summaryMap.get(file.path);
    if (!summary) continue;

    await db('file_summaries')
      .insert({
        path: `${fullName}/${file.path}`,
        branch,
        summary,
        commit_hash: file.blobHash,
        model_used: modelUsed,
        last_updated_at: db.fn.now()
      })
      .onConflict(['path', 'branch'])
      .merge({
        summary,
        commit_hash: file.blobHash,
        model_used: modelUsed,
        last_updated_at: db.fn.now()
      });
  }
}

export async function logFileBatchCall(options: {
  log: Logger;
  fullName: string;
  batch: BatchFile[];
  modelLogged: string;
  agentUsed: Agent;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  durationMs: number;
  success: boolean;
  errorMessage?: string;
}): Promise<void> {
  const {
    log, fullName, batch, modelLogged, agentUsed, estimatedInputTokens,
    estimatedOutputTokens, durationMs, success, errorMessage
  } = options;

  await logSummarizationCall({
    timestamp: new Date().toISOString(),
    callType: 'batch_summarization',
    model: modelLogged,
    agentAlias: agentUsed.config.alias,
    repository: fullName,
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedTotalTokens: estimatedInputTokens + estimatedOutputTokens,
    fileCount: batch.length,
    success,
    durationMs,
    error: errorMessage
  }, log);

  await persistLlmLog(createLlmLogFromAnalysis({
    executionType: 'summarization',
    modelUsed: modelLogged,
    executionTimeMs: durationMs,
    success,
    tokenUsage: { input_tokens: estimatedInputTokens, output_tokens: estimatedOutputTokens },
    error: errorMessage,
    repository: fullName,
    agentAlias: agentUsed.config.alias,
    workRef: { workType: 'repository', workRepository: fullName },
  }));
}
