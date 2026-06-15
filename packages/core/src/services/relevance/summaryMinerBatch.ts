import type { Logger } from 'pino';
import logger from '../../utils/logger.js';
import { Agent } from '../../agents/types.js';
import { db } from '../../db/connection.js';
import { logSummarizationCall } from './summaryMinerMetrics.js';
import { persistLlmLog, createLlmLogFromAnalysis } from '../../utils/llmLogger.js';
import { isQuotaExhaustionError, withRetry, type RetryOptions } from '../../utils/retryHandler.js';
import { resolveExpectedSummaryPath } from './summaryMinerDirectoryHelpers.js';
import {
  clearSummarizationCooldown,
  clearSummarizationPrimaryQuotaFailures,
  isSummarizationInvalidResponseError,
  recordPrimarySummarizationQuotaFailure,
  recordPrimarySummarizationResponseFailure,
  recordSummarizationCooldown
} from '../../config/configManager.js';

const CHARS_PER_TOKEN_ESTIMATE = 3;
const SUMMARIZATION_RETRY_BASE_DELAY_MS = process.env.NODE_ENV === 'test' ? 0 : 2000;

const SUMMARIZATION_RETRY: RetryOptions = {
  maxAttempts: 3,
  baseDelay: SUMMARIZATION_RETRY_BASE_DELAY_MS,
  maxDelay: 15000,
  exponentialBase: 2,
  retryableErrors: ['SUMMARIZATION_INVALID_RESPONSE'],
};

// The fallback model is given a single attempt: the requirement is to retry the
// quota-limited batch once with the fallback, not to re-run the fallback itself.
const SUMMARIZATION_FALLBACK_RETRY: RetryOptions = {
  maxAttempts: 1,
  baseDelay: SUMMARIZATION_RETRY_BASE_DELAY_MS,
  maxDelay: 15000,
  exponentialBase: 2,
  retryableErrors: ['SUMMARIZATION_INVALID_RESPONSE'],
};

export interface BatchFile {
  path: string;
  content: string;
  blobHash: string;
}

interface SummaryResult {
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

interface ProcessSingleBatchOptions {
  fullName: string;
  batch: BatchFile[];
  agent: Agent;
  log: Logger;
  modelUsed: string;
  customPrompt?: string;
  primaryAgentAliasSetting?: string;
  fallbackAgent?: Agent;
  fallbackModelOverride?: string;
  fallbackModelUsed?: string;
  fallbackAgentAliasSetting?: string;
  branch: string;
}

export interface ProcessSingleBatchResult {
  success: boolean;
  fallbackUsed: boolean;
  stopProcessing: boolean;
  primaryAgentAlias?: string;
  fallbackAgentAlias?: string;
}

export const DEFAULT_INSTRUCTIONS = `You are a code expert. Analyze the following source code files.
For each file, provide a summary (3-4 sentences) covering:
1. Primary purpose of the file
2. Key functions, classes, or exports it provides
3. What other parts of the system it interacts with or depends on`;

const JSON_FORMAT_RULES = `Return ONLY valid JSON in this exact format:
{
  "summaries": [
    { "path": "relative/path/to/file", "summary": "This file handles... It provides... It interacts with..." }
  ]
}

Important:
- Include ALL files listed below in your response
- Each summary should be 3-4 sentences with specific details
- Mention key function/class names when relevant
- Focus on what the file does and how it connects to the system
- Return valid JSON only, no markdown or other formatting`;

class SummarizationCooldownRecordedError extends Error {
  constructor(error: unknown) {
    super((error as Error).message);
    this.name = 'SummarizationCooldownRecordedError';
    this.cause = error;
  }
}

class RetryableSummarizationResponseError extends Error {
  code = 'SUMMARIZATION_INVALID_RESPONSE';
}

export async function processSingleBatch(options: ProcessSingleBatchOptions): Promise<ProcessSingleBatchResult> {
  const {
    fullName, batch, agent, log, modelUsed, customPrompt, branch,
    primaryAgentAliasSetting, fallbackAgent, fallbackModelOverride, fallbackModelUsed, fallbackAgentAliasSetting
  } = options;
  const prompt = buildBatchPrompt(batch, customPrompt);
  const startTime = Date.now();
  const estimatedInputTokens = Math.ceil(prompt.length / CHARS_PER_TOKEN_ESTIMATE);
  const estimatedOutputTokens = batch.length * 120;
  let success = false;
  let errorMessage: string | undefined;
  let agentUsed = agent;
  let modelLogged = modelUsed;
  let fallbackUsed = false;
  let stopProcessing = false;
  let fallbackPrimaryAgentAlias: string | undefined;
  let fallbackAgentAlias: string | undefined;

  try {
    const summaries = await analyzeBatchWithFallback({
      prompt, batch, agent, log, modelUsed, primaryAgentAliasSetting,
      fallbackAgent, fallbackModelOverride, fallbackModelUsed, fallbackAgentAliasSetting, fullName, branch
    });
    agentUsed = summaries.agentUsed;
    modelLogged = summaries.modelLogged;
    fallbackUsed = summaries.fallbackUsed;
    fallbackPrimaryAgentAlias = summaries.primaryAgentAlias;
    fallbackAgentAlias = summaries.fallbackAgentAlias;
    await saveBatchSummaries({ fullName, batch, summaries: summaries.results, modelUsed: modelLogged, branch });
    success = true;
    log.debug({ savedCount: summaries.results.length }, 'Saved batch summaries');
  } catch (error) {
    errorMessage = (error as Error).message;
    stopProcessing = error instanceof SummarizationCooldownRecordedError;
    log.error({ error: errorMessage, fileCount: batch.length }, 'Failed to process batch');
  }

  const durationMs = Date.now() - startTime;
  await logFileBatchCall({
    log, fullName, batch, modelLogged, agentUsed, estimatedInputTokens,
    estimatedOutputTokens, durationMs, success, errorMessage
  });
  return {
    success,
    fallbackUsed,
    stopProcessing,
    primaryAgentAlias: fallbackPrimaryAgentAlias,
    fallbackAgentAlias
  };
}

async function analyzeBatchWithFallback(options: ProcessSingleBatchOptions & { prompt: string }): Promise<{
  results: SummaryResult[];
  agentUsed: Agent;
  modelLogged: string;
  fallbackUsed: boolean;
  primaryAgentAlias?: string;
  fallbackAgentAlias?: string;
}> {
  const {
    prompt, batch, agent, log, modelUsed, primaryAgentAliasSetting,
    fallbackAgent, fallbackModelOverride, fallbackModelUsed, fallbackAgentAliasSetting, fullName, branch
  } = options;

  try {
    const results = await analyzeBatchWithAgent({
      prompt, batch, agent, model: modelUsed, context: `batch_summarization:${fullName}`, fullName
    });
    await clearSummarizationPrimaryQuotaFailures({
      primaryAgentAlias: primaryAgentAliasSetting || agent.config.alias,
      repository: fullName,
      branch
    });
    return { results, agentUsed: agent, modelLogged: modelUsed, fallbackUsed: false };
  } catch (primaryError) {
    const primaryAgentAlias = primaryAgentAliasSetting || agent.config.alias;
    if (!isQuotaExhaustionError(primaryError)) {
      if (!fallbackAgent || !fallbackAgentAliasSetting) {
        throw primaryError;
      }

      log.warn({
        error: (primaryError as Error).message,
        primaryAgentAlias,
        fallbackAgentAlias: fallbackAgent.config.alias,
        fallbackModel: fallbackModelUsed ?? fallbackModelOverride
      }, 'Primary summarization failed; retrying batch with fallback');

      const results = await analyzeBatchWithAgent({
        prompt,
        batch,
        agent: fallbackAgent,
        model: fallbackModelUsed ?? fallbackModelOverride,
        context: `batch_summarization_fallback:${fullName}`,
        fullName,
        retryOptions: SUMMARIZATION_FALLBACK_RETRY
      });
      if (isSummarizationInvalidResponseError(primaryError)) {
        await recordPrimarySummarizationResponseFailure({
          primaryAgentAlias,
          fallbackAgentAlias: fallbackAgentAliasSetting,
          reason: (primaryError as Error).message
        });
      }
      return {
        results,
        agentUsed: fallbackAgent,
        modelLogged: fallbackModelUsed ?? fallbackModelOverride ?? fallbackAgent.config.defaultModel ?? 'unknown',
        fallbackUsed: true,
        primaryAgentAlias,
        fallbackAgentAlias: fallbackAgentAliasSetting
      };
    }

    if (!fallbackAgent || !fallbackAgentAliasSetting) {
      await recordPrimarySummarizationQuotaFailure({ primaryAgentAlias });
      await recordSummarizationCooldown({
        repository: fullName,
        branch,
        primaryAgentAlias,
        reason: 'Primary summarization model is quota-limited and no fallback model is configured.'
      });
      throw new SummarizationCooldownRecordedError(primaryError);
    }

    await recordPrimarySummarizationQuotaFailure({ primaryAgentAlias, fallbackAgentAlias: fallbackAgentAliasSetting });

    log.warn({
      error: (primaryError as Error).message,
      primaryAgentAlias: agent.config.alias,
      fallbackAgentAlias: fallbackAgent.config.alias,
      fallbackModel: fallbackModelUsed ?? fallbackModelOverride
    }, 'Primary summarization model quota-limited; retrying batch with fallback');

    try {
      const results = await analyzeBatchWithAgent({
        prompt,
        batch,
        agent: fallbackAgent,
        model: fallbackModelUsed ?? fallbackModelOverride,
        context: `batch_summarization_fallback:${fullName}`,
        fullName,
        retryOptions: SUMMARIZATION_FALLBACK_RETRY
      });
      await clearSummarizationCooldown(fullName, branch, {
        primaryAgentAlias,
        fallbackAgentAlias: fallbackAgentAliasSetting,
        clearDegradationWarning: true
      });
      return {
        results,
        agentUsed: fallbackAgent,
        modelLogged: fallbackModelUsed ?? fallbackModelOverride ?? fallbackAgent.config.defaultModel ?? 'unknown',
        fallbackUsed: true,
        primaryAgentAlias,
        fallbackAgentAlias: fallbackAgentAliasSetting
      };
    } catch (fallbackError) {
      await recordCooldownAfterFallbackFailure({
        error: fallbackError, fullName, branch, agent, primaryAgentAliasSetting, fallbackAgentAliasSetting
      });
      throw new SummarizationCooldownRecordedError(fallbackError);
    }
  }
}

async function recordCooldownAfterFallbackFailure(options: {
  error: unknown;
  fullName: string;
  branch: string;
  agent: Agent;
  primaryAgentAliasSetting?: string;
  fallbackAgentAliasSetting: string;
}): Promise<void> {
  const { error, fullName, branch, agent, primaryAgentAliasSetting, fallbackAgentAliasSetting } = options;
  const fallbackWasQuotaLimited = isQuotaExhaustionError(error);

  await recordSummarizationCooldown({
    repository: fullName,
    branch,
    primaryAgentAlias: primaryAgentAliasSetting || agent.config.alias,
    fallbackAgentAlias: fallbackAgentAliasSetting,
    reason: fallbackWasQuotaLimited
      ? 'Primary and fallback summarization models are quota-limited.'
      : `Primary summarization model is quota-limited and fallback summarization failed: ${(error as Error).message}`
  });
}

async function analyzeBatchWithAgent(options: {
  prompt: string;
  batch: BatchFile[];
  agent: Agent;
  model?: string;
  context: string;
  fullName: string;
  retryOptions?: RetryOptions;
}): Promise<SummaryResult[]> {
  const { prompt, batch, agent, model, context, fullName, retryOptions = SUMMARIZATION_RETRY } = options;
  return withRetry(
    async () => {
      const analysisResult = await agent.analyze(prompt, {
        model,
        responseFormat: 'json',
        executionType: 'summarization',
        repository: fullName,
        metadata: { phase: 'batch_summarization', fileCount: batch.length },
        suppressLlmLog: true
      });
      if (!analysisResult.success) {
        throw new Error(analysisResult.error || 'Summarization agent analysis failed');
      }
      const parsed = parseBatchResponse(analysisResult.response, batch.map(file => file.path));
      if (parsed.length === 0) {
        throw new RetryableSummarizationResponseError(`No valid summaries parsed for batch of ${batch.length} files`);
      }
      const summarizedPaths = new Set(parsed.map(result => result.path));
      const missingPaths = batch.map(file => file.path).filter(filePath => !summarizedPaths.has(filePath));
      if (missingPaths.length > 0) {
        throw new RetryableSummarizationResponseError(`Missing summaries for ${missingPaths.length} of ${batch.length} files: ${missingPaths.slice(0, 5).join(', ')}`);
      }
      return parsed;
    },
    retryOptions,
    context
  );
}

function buildBatchPrompt(batch: BatchFile[], customPrompt?: string): string {
  const filesContent = batch.map(f =>
    `--- START ${f.path} ---\n${f.content}\n--- END ${f.path} ---`
  ).join('\n\n');
  const instructions = customPrompt && customPrompt.trim().length > 0
    ? customPrompt
    : DEFAULT_INSTRUCTIONS;

  return `${instructions}

${JSON_FORMAT_RULES}

FILES:
${filesContent}`;
}

export function parseBatchResponse(response: string, expectedPaths?: string[]): SummaryResult[] {
  try {
    const jsonMatch = response.match(/\{[\s\S]*"summaries"[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn('No JSON found in batch response');
      return [];
    }

    const parsed = JSON.parse(jsonMatch[0]) as { summaries: SummaryResult[] };
    if (!parsed.summaries || !Array.isArray(parsed.summaries)) {
      logger.warn('Invalid summaries format in response');
      return [];
    }

    return parsed.summaries
      .filter(s =>
        typeof s.path === 'string' &&
        typeof s.summary === 'string' &&
        s.path.trim().length > 0 &&
        s.summary.trim().length > 0
      )
      .map(s => {
        const expectedPath = expectedPaths
          ? resolveExpectedSummaryPath(s.path, expectedPaths)
          : s.path.trim();
        return expectedPath
          ? { path: expectedPath, summary: s.summary.trim() }
          : null;
      })
      .filter((s): s is SummaryResult => s !== null);
  } catch (error) {
    logger.warn({ error: (error as Error).message }, 'Failed to parse batch response');
    return [];
  }
}

async function saveBatchSummaries(options: SaveBatchSummariesOptions): Promise<void> {
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

async function logFileBatchCall(options: {
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
