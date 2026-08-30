import type { Logger } from 'pino';
import { Agent, type AnalyzeOptions } from '../../agents/types.js';
import { isQuotaExhaustionError, withRetry, type RetryOptions } from '../../utils/retryHandler.js';
import { saveBatchSummaries, logFileBatchCall, type SummaryResult } from './summaryMinerBatchPersistence.js';
import { clearSummarizationCooldown, clearSummarizationPrimaryQuotaFailures, isSummarizationInvalidResponseError, promoteSummarizationFallbackIfNeeded } from '../../config/configManager.js';
import { recordPrimarySummarizationQuotaFailure, recordPrimarySummarizationResponseFailure, recordSummarizationCooldown } from '../../config/configManager.js';
import { SyntheticPoolExhaustedError, type SyntheticRoutingSession } from '../syntheticRoutingService.js';
import { SyntheticAgent } from '../../agents/SyntheticAgent.js';
import { buildBatchPrompt, parseBatchResponse, type BatchFile } from './summaryMinerBatchHelpers.js';

export { DEFAULT_INSTRUCTIONS, parseBatchResponse } from './summaryMinerBatchHelpers.js';
export type { BatchFile } from './summaryMinerBatchHelpers.js';

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

interface ProcessSingleBatchOptions {
  fullName: string; batch: BatchFile[];
  agent: Agent; log: Logger;
  modelUsed: string; customPrompt?: string;
  primaryAgentAliasSetting?: string; fallbackAgent?: Agent;
  fallbackModelOverride?: string; fallbackModelUsed?: string;
  fallbackAgentAliasSetting?: string; branch: string;
  routingSession?: SyntheticRoutingSession;
  fallbackRoutingSession?: SyntheticRoutingSession;
}

export interface ProcessSingleBatchResult {
  success: boolean; fallbackUsed: boolean; stopProcessing: boolean;
  primaryAgentAlias?: string; fallbackAgentAlias?: string;
}

interface BatchAnalysisResult {
  results: SummaryResult[]; agentUsed: Agent; modelLogged: string;
  routingMetadata?: Record<string, unknown>; fallbackUsed: boolean;
  primaryAgentAlias?: string; fallbackAgentAlias?: string;
}

type BatchAnalysisOptions = ProcessSingleBatchOptions & {
  prompt: string;
  onFallbackAttempt: () => void;
};

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
  const fallbackRoutingSession = beginFallbackRoutingSession(
    fallbackAgent,
    fallbackModelUsed ?? fallbackModelOverride
  );
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
  let routingMetadata: Record<string, unknown> | undefined;
  let fallbackAttempted = false;

  try {
    const summaries = await analyzeBatchWithFallback({
      prompt, batch, agent, log, modelUsed, primaryAgentAliasSetting,
      fallbackAgent, fallbackModelOverride, fallbackModelUsed, fallbackAgentAliasSetting, fullName, branch,
      routingSession: options.routingSession,
      fallbackRoutingSession,
      onFallbackAttempt: () => { fallbackAttempted = true; },
    });
    agentUsed = summaries.agentUsed;
    modelLogged = summaries.modelLogged;
    fallbackUsed = summaries.fallbackUsed;
    fallbackPrimaryAgentAlias = summaries.primaryAgentAlias;
    fallbackAgentAlias = summaries.fallbackAgentAlias;
    routingMetadata = summaries.routingMetadata;
    await saveBatchSummaries({ fullName, batch, summaries: summaries.results, modelUsed: modelLogged, branch });
    success = true;
    log.debug({ savedCount: summaries.results.length }, 'Saved batch summaries');
  } catch (error) {
    errorMessage = (error as Error).message;
    stopProcessing = error instanceof SummarizationCooldownRecordedError;
    if (fallbackAttempted && fallbackAgent) {
      agentUsed = fallbackAgent;
      routingMetadata = fallbackRoutingSession?.routingMetadata;
      modelLogged = fallbackModelUsed ?? fallbackModelOverride ?? fallbackAgent.config.defaultModel ?? 'unknown';
    } else {
      routingMetadata = options.routingSession?.routingMetadata;
    }
    const physicalModel = routingMetadata?.physicalModel;
    if (typeof physicalModel === 'string') modelLogged = physicalModel;
    log.error({ error: errorMessage, fileCount: batch.length }, 'Failed to process batch');
  }

  const durationMs = Date.now() - startTime;
  await logFileBatchCall({
    log, fullName, batch, modelLogged, agentUsed, estimatedInputTokens,
    estimatedOutputTokens, durationMs, success, errorMessage, routingMetadata
  });
  return {
    success,
    fallbackUsed,
    stopProcessing,
    primaryAgentAlias: fallbackPrimaryAgentAlias,
    fallbackAgentAlias
  };
}

async function analyzeBatchWithFallback(
  options: BatchAnalysisOptions
): Promise<BatchAnalysisResult> {
  const {
    prompt, batch, agent, log, modelUsed, primaryAgentAliasSetting, fullName, branch
  } = options;

  try {
    const results = await analyzeBatchWithAgent({
      prompt, batch, agent, model: modelUsed, context: `batch_summarization:${fullName}`, fullName,
      routingSession: options.routingSession,
    });
    // Clearing quota-failure bookkeeping is best-effort: a transient runtime-state
    // read/write error here must not discard a batch the LLM summarized successfully.
    await clearSummarizationPrimaryQuotaFailuresSafe(
      { primaryAgentAlias: primaryAgentAliasSetting || agent.config.alias, repository: fullName, branch },
      log
    );
    const routingMetadata = options.routingSession?.routingMetadata;
    const physicalModel = routingMetadata?.physicalModel;
    return {
      results,
      agentUsed: agent,
      modelLogged: typeof physicalModel === 'string' ? physicalModel : modelUsed,
      routingMetadata,
      fallbackUsed: false,
    };
  } catch (primaryError) {
    return analyzeBatchAfterPrimaryFailure(
      primaryError, primaryAgentAliasSetting || agent.config.alias, options
    );
  }
}

async function analyzeNonQuotaPrimaryFailure(
  primaryError: unknown,
  primaryAgentAlias: string,
  options: BatchAnalysisOptions
): Promise<BatchAnalysisResult> {
  if (!isSummarizationInvalidResponseError(primaryError)) throw primaryError;
  if (options.fallbackAgent && options.fallbackAgentAliasSetting) {
    return analyzeBatchWithInvalidResponseFallback(primaryError, primaryAgentAlias, options);
  }
  await recordSummarizationCooldown({
    repository: options.fullName,
    branch: options.branch,
    primaryAgentAlias,
    reason: 'Primary summarization model returned unusable output after retries and no fallback model is configured.'
  });
  throw new SummarizationCooldownRecordedError(primaryError);
}

async function analyzeBatchAfterPrimaryFailure(
  primaryError: unknown,
  primaryAgentAlias: string,
  options: BatchAnalysisOptions
): Promise<BatchAnalysisResult> {
  const {
    prompt, batch, agent, log, fallbackAgent, fallbackModelOverride,
    fallbackModelUsed, fallbackAgentAliasSetting, fullName, branch
  } = options;
  const syntheticRouteUnavailable = primaryError instanceof SyntheticPoolExhaustedError;
  // Only quota/usage-limit exhaustion and invalid model output trigger the
  // fallback model. An exhausted synthetic route is also eligible because it
  // represents the configured primary pool being unavailable for this call.
  if (!isQuotaExhaustionError(primaryError) && !syntheticRouteUnavailable) {
    return analyzeNonQuotaPrimaryFailure(primaryError, primaryAgentAlias, options);
  }

  if (syntheticRouteUnavailable && (!fallbackAgent || !fallbackAgentAliasSetting)) {
    throw primaryError;
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

  if (!syntheticRouteUnavailable) {
    await recordPrimarySummarizationQuotaFailure({ primaryAgentAlias, fallbackAgentAlias: fallbackAgentAliasSetting });
  }

  log.warn({
    error: (primaryError as Error).message,
    primaryAgentAlias: agent.config.alias,
    fallbackAgentAlias: fallbackAgent.config.alias,
    fallbackModel: fallbackModelUsed ?? fallbackModelOverride
  }, primaryFallbackWarning(syntheticRouteUnavailable));

  const fallbackRoutingSession = options.fallbackRoutingSession;
  options.onFallbackAttempt();
  try {
    const results = await analyzeBatchWithAgent({
      prompt,
      batch,
      agent: fallbackAgent,
      model: fallbackModelUsed ?? fallbackModelOverride,
      context: `batch_summarization_fallback:${fullName}`,
      fullName,
      retryOptions: SUMMARIZATION_FALLBACK_RETRY,
      routingSession: fallbackRoutingSession,
    });
    if (!syntheticRouteUnavailable) {
      await clearSummarizationCooldown(fullName, branch, {
        primaryAgentAlias,
        fallbackAgentAlias: fallbackAgentAliasSetting,
        clearDegradationWarning: true
      });
      // Promote only now that the fallback has proven it can summarize this batch.
      await promoteSummarizationFallbackIfNeeded({ primaryAgentAlias, fallbackAgentAlias: fallbackAgentAliasSetting });
    }
    const routingMetadata = fallbackRoutingSession?.routingMetadata;
    const physicalModel = routingMetadata?.physicalModel;
    return {
      results,
      agentUsed: fallbackAgent,
      modelLogged: typeof physicalModel === 'string'
        ? physicalModel
        : fallbackModelUsed ?? fallbackModelOverride ?? fallbackAgent.config.defaultModel ?? 'unknown',
      routingMetadata,
      fallbackUsed: true,
      primaryAgentAlias,
      fallbackAgentAlias: fallbackAgentAliasSetting
    };
  } catch (fallbackError) {
    if (syntheticRouteUnavailable) throw fallbackError;
    await recordCooldownAfterFallbackFailure({
      error: fallbackError, fullName, branch, agent,
      primaryAgentAliasSetting: options.primaryAgentAliasSetting, fallbackAgentAliasSetting
    });
    throw new SummarizationCooldownRecordedError(fallbackError);
  }
}

function primaryFallbackWarning(syntheticRouteUnavailable: boolean): string {
  return syntheticRouteUnavailable
    ? 'Primary synthetic summarization route unavailable; retrying batch with fallback'
    : 'Primary summarization model quota-limited; retrying batch with fallback';
}

async function analyzeBatchWithInvalidResponseFallback(
  primaryError: unknown,
  primaryAgentAlias: string,
  options: BatchAnalysisOptions
): Promise<BatchAnalysisResult> {
  const {
    prompt, batch, fallbackAgent, fallbackModelOverride, fallbackModelUsed,
    fallbackAgentAliasSetting, fullName, log
  } = options;
  log.warn({
    error: (primaryError as Error).message,
    primaryAgentAlias,
    fallbackAgentAlias: fallbackAgent?.config.alias,
    fallbackModel: fallbackModelUsed ?? fallbackModelOverride
  }, 'Primary summarization returned unusable output; retrying batch with fallback');

  const fallbackRoutingSession = options.fallbackRoutingSession;
  options.onFallbackAttempt();
  const results = await analyzeBatchWithAgent({
    prompt,
    batch,
    agent: fallbackAgent as Agent,
    model: fallbackModelUsed ?? fallbackModelOverride,
    context: `batch_summarization_fallback:${fullName}`,
    fullName,
    retryOptions: SUMMARIZATION_FALLBACK_RETRY,
    routingSession: fallbackRoutingSession,
  });
  await recordPrimarySummarizationResponseFailure({
    primaryAgentAlias,
    fallbackAgentAlias: fallbackAgentAliasSetting as string,
    reason: (primaryError as Error).message
  });
  const routingMetadata = fallbackRoutingSession?.routingMetadata;
  const physicalModel = routingMetadata?.physicalModel;
  return {
    results,
    agentUsed: fallbackAgent as Agent,
    modelLogged: typeof physicalModel === 'string'
      ? physicalModel
      : fallbackModelUsed ?? fallbackModelOverride ?? fallbackAgent?.config.defaultModel ?? 'unknown',
    routingMetadata,
    fallbackUsed: true,
    primaryAgentAlias,
    fallbackAgentAlias: fallbackAgentAliasSetting
  };
}

function beginFallbackRoutingSession(agent: Agent | undefined, model: string | undefined): SyntheticRoutingSession | undefined {
  return agent instanceof SyntheticAgent ? agent.beginRoutingSession(model) : undefined;
}

async function clearSummarizationPrimaryQuotaFailuresSafe(
  options: { primaryAgentAlias?: string; repository?: string; branch?: string },
  log: Logger
): Promise<void> {
  try {
    await clearSummarizationPrimaryQuotaFailures(options);
  } catch (error) {
    log.warn({ error: (error as Error).message, ...options }, 'Failed to clear summarization quota-failure bookkeeping after successful batch');
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
  routingSession?: SyntheticRoutingSession;
}): Promise<SummaryResult[]> {
  const { prompt, batch, agent, model, context, fullName, retryOptions = SUMMARIZATION_RETRY, routingSession } = options;
  return withRetry(
    async () => {
      const analyzeOptions: AnalyzeOptions = {
        model,
        responseFormat: 'json',
        executionType: 'summarization',
        repository: fullName,
        metadata: { phase: 'batch_summarization', fileCount: batch.length },
        suppressLlmLog: true
      };
      const analysisResult = routingSession
        ? await routingSession.analyze(prompt, analyzeOptions)
        : await agent.analyze(prompt, analyzeOptions);
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
