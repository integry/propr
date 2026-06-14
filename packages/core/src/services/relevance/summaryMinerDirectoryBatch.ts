import type { Logger } from 'pino';
import { Agent } from '../../agents/types.js';
import { logSummarizationCall } from './summaryMinerMetrics.js';
import { persistLlmLog, createLlmLogFromAnalysis } from '../../utils/llmLogger.js';
import { isQuotaExhaustionError, withRetry, type RetryOptions } from '../../utils/retryHandler.js';
import {
  clearSummarizationCooldown,
  clearSummarizationPrimaryQuotaFailures,
  recordPrimarySummarizationQuotaFailure,
  recordSummarizationCooldown
} from '../../config/configManager.js';
import {
  type DirectoryInfo, type DirectoryResult,
  buildBatchDirectoryPrompt, parseBatchDirectoryResponse
} from './summaryMinerDirectoryHelpers.js';

const CHARS_PER_TOKEN_ESTIMATE = 3;

const SUMMARIZATION_RETRY = {
  maxAttempts: 3,
  baseDelay: 2000,
  maxDelay: 15000,
  exponentialBase: 2,
} as const;

export type DirectoryBatchResult = DirectoryResult[] & {
  fallbackUsed: boolean;
  stopProcessing: boolean;
  primaryAgentAlias?: string;
  fallbackAgentAlias?: string;
};

interface DirectoryBatchMetadata {
  fallbackUsed: boolean;
  stopProcessing: boolean;
  primaryAgentAlias?: string;
  fallbackAgentAlias?: string;
}

interface ProcessDirectoryBatchOptions {
  directories: DirectoryInfo[];
  agent: Agent;
  log: Logger;
  modelOverride?: string;
  modelUsed?: string;
  primaryAgentAliasSetting?: string;
  fallbackAgent?: Agent;
  fallbackModelOverride?: string;
  fallbackModelUsed?: string;
  fallbackAgentAliasSetting?: string;
  fullName: string;
  branch: string;
}

class SummarizationCooldownRecordedError extends Error {
  constructor(error: unknown) {
    super((error as Error).message);
    this.name = 'SummarizationCooldownRecordedError';
    this.cause = error;
  }
}

export async function processDirectoryBatch(options: ProcessDirectoryBatchOptions): Promise<DirectoryBatchResult> {
  const { directories } = options;
  if (directories.length === 0) return withFallbackMetadata([], { fallbackUsed: false, stopProcessing: false });

  const prompt = buildBatchDirectoryPrompt(directories);
  const startTime = Date.now();
  const estimatedInputTokens = Math.ceil(prompt.length / CHARS_PER_TOKEN_ESTIMATE);
  const estimatedOutputTokens = directories.length * 150;
  const state = createDirectoryBatchState(options);

  try {
    await analyzeDirectoryBatchWithFallback({ ...options, prompt, state });
    state.success = state.results.some(r => r.summary !== null);
    options.log.debug({ batchSize: directories.length, successCount: state.results.filter(r => r.summary).length }, 'Processed directory batch');
  } catch (error) {
    state.errorMessage = (error as Error).message;
    state.stopProcessing = error instanceof SummarizationCooldownRecordedError;
    options.log.warn({ error: state.errorMessage, batchSize: directories.length }, 'Failed to process directory batch');
    state.results = directories.map(d => ({ dirPath: d.dirPath, summary: null }));
  }

  const durationMs = Date.now() - startTime;
  await logDirectoryBatchCall({ ...options, state, estimatedInputTokens, estimatedOutputTokens, durationMs });
  return withFallbackMetadata(state.results, {
    fallbackUsed: state.fallbackUsed,
    stopProcessing: state.stopProcessing,
    primaryAgentAlias: state.fallbackPrimaryAgentAlias,
    fallbackAgentAlias: state.fallbackAgentAlias
  });
}

interface DirectoryBatchState {
  agentUsed: Agent;
  modelLogged: string;
  success: boolean;
  errorMessage?: string;
  results: DirectoryResult[];
  fallbackUsed: boolean;
  stopProcessing: boolean;
  fallbackPrimaryAgentAlias?: string;
  fallbackAgentAlias?: string;
}

function createDirectoryBatchState(options: ProcessDirectoryBatchOptions): DirectoryBatchState {
  const { agent, modelOverride, modelUsed } = options;
  return {
    agentUsed: agent,
    modelLogged: modelUsed || modelOverride || agent.config.defaultModel || 'unknown',
    success: false,
    results: [],
    fallbackUsed: false,
    stopProcessing: false
  };
}

async function analyzeDirectoryBatchWithFallback(options: ProcessDirectoryBatchOptions & {
  prompt: string;
  state: DirectoryBatchState;
}): Promise<void> {
  const { prompt, directories, agent, modelOverride, modelUsed, fullName, branch, primaryAgentAliasSetting, state } = options;
  try {
    state.results = await analyzeDirectoryBatchWithAgent({
      prompt, directories, agent, model: modelUsed ?? modelOverride, context: `directory_aggregation:${fullName}`
    });
    await clearSummarizationPrimaryQuotaFailures({
      primaryAgentAlias: primaryAgentAliasSetting || agent.config.alias,
      repository: fullName,
      branch
    });
  } catch (primaryError) {
    await handlePrimaryDirectoryFailure(primaryError, options);
  }
}

async function handlePrimaryDirectoryFailure(
  primaryError: unknown,
  options: ProcessDirectoryBatchOptions & { prompt: string; state: DirectoryBatchState }
): Promise<void> {
  const { agent, primaryAgentAliasSetting, fallbackAgent, fallbackAgentAliasSetting, fullName, branch } = options;
  if (!isQuotaExhaustionError(primaryError)) throw primaryError;

  const primaryAgentAlias = primaryAgentAliasSetting || agent.config.alias;
  if (!fallbackAgent || !fallbackAgentAliasSetting) {
    await recordPrimarySummarizationQuotaFailure({ primaryAgentAlias });
    await recordSummarizationCooldown({
      repository: fullName,
      branch,
      primaryAgentAlias,
      reason: 'Primary directory summarization model is quota-limited and no fallback model is configured.'
    });
    throw new SummarizationCooldownRecordedError(primaryError);
  }

  await analyzeDirectoryBatchWithFallbackAgent(primaryError, primaryAgentAlias, options);
}

async function analyzeDirectoryBatchWithFallbackAgent(
  primaryError: unknown,
  primaryAgentAlias: string,
  options: ProcessDirectoryBatchOptions & { prompt: string; state: DirectoryBatchState }
): Promise<void> {
  const { prompt, directories, fallbackAgent, fallbackModelOverride, fallbackModelUsed, fallbackAgentAliasSetting, fullName, branch, log, state } = options;
  await recordPrimarySummarizationQuotaFailure({ primaryAgentAlias, fallbackAgentAlias: fallbackAgentAliasSetting });
  log.warn({
    error: (primaryError as Error).message,
    primaryAgentAlias,
    fallbackAgentAlias: fallbackAgent?.config.alias,
    fallbackModel: fallbackModelUsed ?? fallbackModelOverride
  }, 'Primary directory summarization model quota-limited; retrying batch with fallback');

  try {
    state.results = await analyzeDirectoryBatchWithAgent({
      prompt,
      directories,
      agent: fallbackAgent as Agent,
      model: fallbackModelUsed ?? fallbackModelOverride,
      context: `directory_aggregation_fallback:${fullName}`,
      retryOptions: SUMMARIZATION_RETRY
    });
    state.fallbackUsed = true;
    state.fallbackPrimaryAgentAlias = primaryAgentAlias;
    state.fallbackAgentAlias = fallbackAgentAliasSetting;
    state.agentUsed = fallbackAgent as Agent;
    state.modelLogged = fallbackModelUsed ?? fallbackModelOverride ?? fallbackAgent?.config.defaultModel ?? 'unknown';
    await clearSummarizationCooldown(fullName, branch, {
      primaryAgentAlias,
      fallbackAgentAlias: fallbackAgentAliasSetting,
      clearDegradationWarning: true
    });
  } catch (fallbackError) {
    await recordSummarizationCooldown({
      repository: fullName,
      branch,
      primaryAgentAlias,
      fallbackAgentAlias: fallbackAgentAliasSetting,
      reason: isQuotaExhaustionError(fallbackError)
        ? 'Primary and fallback directory summarization models are quota-limited.'
        : `Primary directory summarization model is quota-limited and fallback directory summarization failed: ${(fallbackError as Error).message}`
    });
    throw new SummarizationCooldownRecordedError(fallbackError);
  }
}

async function logDirectoryBatchCall(options: ProcessDirectoryBatchOptions & {
  state: DirectoryBatchState;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  durationMs: number;
}): Promise<void> {
  const { directories, fullName, log, state, estimatedInputTokens, estimatedOutputTokens, durationMs } = options;
  await logSummarizationCall({
    timestamp: new Date().toISOString(), callType: 'directory_aggregation', model: state.modelLogged,
    agentAlias: state.agentUsed.config.alias, repository: fullName, estimatedInputTokens, estimatedOutputTokens,
    estimatedTotalTokens: estimatedInputTokens + estimatedOutputTokens,
    fileCount: directories.length, success: state.success, durationMs, error: state.errorMessage
  }, log);

  await persistLlmLog(createLlmLogFromAnalysis({
    executionType: 'summarization', modelUsed: state.modelLogged, executionTimeMs: durationMs, success: state.success,
    tokenUsage: { input_tokens: estimatedInputTokens, output_tokens: estimatedOutputTokens },
    error: state.errorMessage, repository: fullName, agentAlias: state.agentUsed.config.alias,
    metadata: { directoryCount: directories.length, phase: 'directory_aggregation' },
    workRef: { workType: 'repository', workRepository: fullName },
  }));
}

function withFallbackMetadata(
  results: DirectoryResult[],
  metadata: DirectoryBatchMetadata
): DirectoryBatchResult {
  const batchResult = results as DirectoryBatchResult;
  batchResult.fallbackUsed = metadata.fallbackUsed;
  batchResult.stopProcessing = metadata.stopProcessing;
  batchResult.primaryAgentAlias = metadata.primaryAgentAlias;
  batchResult.fallbackAgentAlias = metadata.fallbackAgentAlias;
  return batchResult;
}

async function analyzeDirectoryBatchWithAgent(options: {
  prompt: string;
  directories: DirectoryInfo[];
  agent: Agent;
  model?: string;
  context: string;
  retryOptions?: RetryOptions;
}): Promise<DirectoryResult[]> {
  const { prompt, directories, agent, model, context, retryOptions = SUMMARIZATION_RETRY } = options;
  return withRetry(
    async () => {
      const analysisResult = await agent.analyze(prompt, { model, responseFormat: 'json' });
      if (!analysisResult.success) {
        throw new Error(analysisResult.error || 'Directory summarization agent analysis failed');
      }
      const parsed = parseBatchDirectoryResponse(analysisResult.response, directories.map(d => d.dirPath));
      if (!parsed.some(r => r.summary !== null)) {
        throw new Error(`No valid directory summaries parsed for batch of ${directories.length} directories`);
      }
      const missingDirs = parsed.filter(result => result.summary === null).map(result => result.dirPath);
      if (missingDirs.length > 0) {
        throw new Error(`Missing summaries for ${missingDirs.length} of ${directories.length} directories: ${missingDirs.slice(0, 5).join(', ')}`);
      }
      return parsed;
    },
    retryOptions,
    context
  );
}
