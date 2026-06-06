import { MODEL_LIMITS, TIKTOKEN_TO_CLAUDE_RATIO, getEffectiveTokenLimit, getModelHardLimit, DEFAULT_CONTEXT_LEVEL } from '../../config/modelLimits.js';
import { countTokens, estimateTokens } from '../../utils/tokenCalculation.js';
import { findRelevantFiles } from '../relevanceService.js';
import { getAgentRegistry } from '../../agents/AgentRegistry.js';
import { parseFileReferences, getResolvedPaths } from '../relevance/fileReferenceParser.js';
import logger from '../../utils/logger.js';
import { getModelPricing } from '../pricingService.js';

import {
  CLAUDE_CODE_OVERHEAD,
  CODEX_PLANNER_INPUT_LIMIT_CHARS,
  type MinimalLogger,
  type TaskDraftConfig,
  type ParsedContextConfig,
  type FindFilesOptions
} from './planningTypes.js';

export { getModelHardLimit };

const API_VALIDATION_THRESHOLD = 0.80;
const DEFAULT_OUTPUT_TOKENS = 4000;
const SONNET_MODEL_ID = 'anthropic/claude-sonnet-4-20250514';

export function parseContextConfig(contextConfig: TaskDraftConfig | null, modelId?: string): ParsedContextConfig {
  const effectiveModelId = contextConfig?.generationModel || modelId;
  return {
    baseBranch: contextConfig?.baseBranch,
    granularity: contextConfig?.granularity || 'balanced',
    contextLevel: contextConfig?.contextLevel ?? DEFAULT_CONTEXT_LEVEL,
    compress: contextConfig?.compress ?? false,
    tokenLimit: getEffectiveTokenLimit(effectiveModelId, contextConfig?.contextLevel ?? DEFAULT_CONTEXT_LEVEL),
    manualFiles: contextConfig?.manualFiles || [],
    autoFiles: contextConfig?.autoFiles || [],
    contextRepositories: contextConfig?.contextRepositories || [],
    generationModel: contextConfig?.generationModel
  };
}

export function getDefaultModelLimit(): number {
  return MODEL_LIMITS['default'];
}

export function getRawInputCharLimit(modelId?: string): number | null {
  const modelLower = modelId?.toLowerCase().trim() || '';
  if (!modelLower) return null;

  const agentAlias = modelLower.includes(':') ? modelLower.split(':')[0] : '';
  const modelName = modelLower.includes(':') ? modelLower.split(':').slice(1).join(':') : modelLower;
  const isCodex = agentAlias === 'codex' || modelName.includes('codex') || modelName.startsWith('gpt-');

  return isCodex ? CODEX_PLANNER_INPUT_LIMIT_CHARS : null;
}

export async function validatePromptTokens(
  prompt: string,
  modelLimit: number,
  correlatedLogger: MinimalLogger,
  modelId?: string
): Promise<{ valid: boolean; tokenCount: number; source: 'tiktoken' | 'api' }> {
  const tiktokenEstimate = estimateTokens(prompt);
  const modelLower = modelId?.toLowerCase() || '';
  const isOpenAI = modelLower.includes('gpt-') || modelLower.includes('codex') || modelLower.includes('openai');
  const isGemini = modelLower.includes('gemini');
  const tokenRatio = isOpenAI ? 1.0 : (isGemini ? 1.1 : TIKTOKEN_TO_CLAUDE_RATIO);
  const conservativeEstimate = Math.ceil(tiktokenEstimate * tokenRatio);
  const effectiveLimit = modelLimit - CLAUDE_CODE_OVERHEAD;

  correlatedLogger.info({ tiktokenEstimate, conservativeEstimate, effectiveLimit, modelLimit }, 'Initial token estimate');

  if (conservativeEstimate > effectiveLimit) {
    correlatedLogger.warn({ conservativeEstimate, effectiveLimit, overage: conservativeEstimate - effectiveLimit },
      'Prompt exceeds token limit (conservative estimate)');
    return { valid: false, tokenCount: conservativeEstimate, source: 'tiktoken' };
  }

  if (conservativeEstimate < effectiveLimit * API_VALIDATION_THRESHOLD) {
    return { valid: true, tokenCount: conservativeEstimate, source: 'tiktoken' };
  }

  correlatedLogger.info('Token count close to limit, attempting API validation');

  try {
    const apiTokenCount = await countTokens(prompt);
    correlatedLogger.info({ apiTokenCount, effectiveLimit }, 'API token count received');

    if (apiTokenCount > effectiveLimit) {
      correlatedLogger.warn({ apiTokenCount, effectiveLimit, overage: apiTokenCount - effectiveLimit },
        'Prompt exceeds token limit according to API');
      return { valid: false, tokenCount: apiTokenCount, source: 'api' };
    }

    return { valid: true, tokenCount: apiTokenCount, source: 'api' };
  } catch (error) {
    correlatedLogger.warn({ error: (error as Error).message }, 'API token counting failed, using conservative tiktoken estimate');
    return { valid: true, tokenCount: conservativeEstimate, source: 'tiktoken' };
  }
}

export async function calculateCostEstimate(
  totalTokens: number,
  warnings: string[],
  correlatedLogger: { warn: typeof logger.warn }
): Promise<number> {
  try {
    const pricing = await getModelPricing(SONNET_MODEL_ID);
    if (pricing) return totalTokens * pricing.prompt + DEFAULT_OUTPUT_TOKENS * pricing.completion;
    warnings.push('Using fallback pricing - could not fetch current model pricing');
  } catch (e) {
    warnings.push('Using fallback pricing - pricing service error');
    correlatedLogger.warn({ error: (e as Error).message }, 'Failed to get model pricing');
  }
  return (totalTokens / 1_000_000) * 3 + (DEFAULT_OUTPUT_TOKENS / 1_000_000) * 15;
}

export async function findFilesForPlan(opts: FindFilesOptions): Promise<string[]> {
  const { worktreePath, draft, manualFiles, autoFiles, correlationId, contextModel } = opts;
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;

  const fileRefResult = await parseFileReferences(draft.initial_prompt, worktreePath, { correlationId });
  const referencedFiles = getResolvedPaths(fileRefResult);

  const allManualFiles = [...new Set([...manualFiles, ...referencedFiles])];

  if (autoFiles.length > 0) {
    correlatedLogger.info({ manualCount: allManualFiles.length, cachedAutoCount: autoFiles.length }, 'Using cached auto files');
    return [...new Set([...allManualFiles, ...autoFiles])];
  }

  const registry = getAgentRegistry();
  await registry.ensureInitialized();
  let agent = registry.getDefaultAgent();
  if (contextModel && contextModel.includes(':')) {
    const agentAlias = contextModel.split(':')[0];
    const selectedAgent = registry.getAgentByAlias(agentAlias);
    if (selectedAgent) agent = selectedAgent;
  }

  const relevanceResult = await findRelevantFiles(worktreePath, fileRefResult.cleanedPrompt || draft.initial_prompt, {
    correlationId, useSummaryScoring: !!agent, useLLMKeywords: true, agent,
    repoName: draft.repository, modelId: contextModel
  });

  const autoFilePaths = relevanceResult.files.map(f => f.path);
  correlatedLogger.info({ manualCount: allManualFiles.length, autoCount: autoFilePaths.length }, 'Found files for plan');

  return [...new Set([...allManualFiles, ...autoFilePaths])];
}
