import { db } from '../db/connection.js';
import { MODEL_LIMITS, TIKTOKEN_TO_CLAUDE_RATIO } from '../config/modelLimits.js';
import { countTokens, estimateTokens } from '../utils/tokenCalculation.js';
import { findRelevantFiles } from './relevanceService.js';
import { getModelPricing } from './pricingService.js';
import logger from '../utils/logger.js';
import { simpleGit } from 'simple-git';

// Threshold for API validation (80% of model limit)
const API_VALIDATION_THRESHOLD = 0.80;
// Buffer for Claude Code overhead
export const CLAUDE_CODE_OVERHEAD = 5000;

export interface GenerationTraceStep {
  name: string;
  status: 'pending' | 'completed' | 'failed';
  data?: Record<string, unknown>;
}

export interface GenerationTrace {
  steps: GenerationTraceStep[];
}

export async function updateTrace(
  draftId: string,
  step: string,
  status: 'pending' | 'completed' | 'failed',
  data?: Record<string, unknown>
): Promise<void> {
  if (!db) return;

  const draft = await db('task_drafts')
    .where({ draft_id: draftId })
    .select('generation_trace')
    .first();

  const rawTrace = draft?.generation_trace as GenerationTrace | undefined;
  const trace: GenerationTrace = {
    steps: Array.isArray(rawTrace?.steps) ? rawTrace.steps : []
  };

  const existingStepIndex = trace.steps.findIndex((s) => s.name === step);
  if (existingStepIndex >= 0) {
    trace.steps[existingStepIndex] = {
      ...trace.steps[existingStepIndex],
      status,
      data: { ...trace.steps[existingStepIndex].data, ...data }
    };
  } else {
    trace.steps.push({ name: step, status, data });
  }

  await db('task_drafts')
    .where({ draft_id: draftId })
    .update({ generation_trace: JSON.stringify(trace) });
}

export interface TokenValidationResult {
  valid: boolean;
  tokenCount: number;
  source: 'tiktoken' | 'api';
}

/**
 * Validate prompt token count before sending to LLM.
 * Uses tiktoken estimate first, then validates with Anthropic API if close to limit.
 */
export async function validatePromptTokens(
  prompt: string,
  modelLimit: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  correlatedLogger: any
): Promise<TokenValidationResult> {
  const tiktokenEstimate = estimateTokens(prompt);
  const effectiveLimit = modelLimit - CLAUDE_CODE_OVERHEAD;

  correlatedLogger.info({ tiktokenEstimate, effectiveLimit, modelLimit }, 'Initial token estimate');

  // If well under the threshold, tiktoken is good enough
  if (tiktokenEstimate < effectiveLimit * API_VALIDATION_THRESHOLD) {
    return { valid: true, tokenCount: tiktokenEstimate, source: 'tiktoken' };
  }

  // Close to limit - try to validate with API if available
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
    // API not available (no key or error) - fall back to tiktoken with conservative estimate
    correlatedLogger.warn({ error: (error as Error).message }, 'API token counting failed, using tiktoken estimate');

    // Apply conservative ratio since tiktoken underestimates
    const conservativeEstimate = Math.ceil(tiktokenEstimate * TIKTOKEN_TO_CLAUDE_RATIO);
    const valid = conservativeEstimate < effectiveLimit;

    if (!valid) {
      correlatedLogger.warn({ conservativeEstimate, effectiveLimit },
        'Prompt likely exceeds token limit (conservative tiktoken estimate)');
    }

    return { valid, tokenCount: conservativeEstimate, source: 'tiktoken' };
  }
}

export class BranchNotFoundError extends Error {
  constructor(branch: string) {
    super(`Branch '${branch}' not found`);
    this.name = 'BranchNotFoundError';
  }
}

export async function checkoutBranch(repoPath: string, branch: string): Promise<void> {
  const git = simpleGit(repoPath);
  try {
    await git.fetch(['origin', '--prune']);
  } catch (e) {
    logger.warn({ repoPath, branch, error: (e as Error).message }, 'Failed to fetch');
  }

  try {
    const branchExists = await git.raw(['rev-parse', '--verify', `origin/${branch}`]).then(() => true).catch(() => false);
    if (!branchExists) {
      const localExists = await git.raw(['rev-parse', '--verify', branch]).then(() => true).catch(() => false);
      if (!localExists) throw new BranchNotFoundError(branch);
    }
    await git.checkout(branch);
    try {
      await git.pull('origin', branch);
    } catch {
      logger.debug({ repoPath, branch }, 'Pull failed, using local');
    }
  } catch (error) {
    if (error instanceof BranchNotFoundError) throw error;
    throw new BranchNotFoundError(branch);
  }
}

export function getDefaultModelLimit(): number {
  return MODEL_LIMITS['default'];
}

const DEFAULT_OUTPUT_TOKENS = 4000;
const SONNET_MODEL_ID = 'anthropic/claude-sonnet-4-20250514';

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

interface TaskDraftForFind {
  repository: string;
  initial_prompt: string;
}

export interface FindFilesOptions {
  draftId: string;
  worktreePath: string;
  draft: TaskDraftForFind;
  manualFiles: string[];
  autoFiles: string[];
  correlationId?: string;
}

export async function findFilesForPlan(opts: FindFilesOptions): Promise<string[]> {
  const { draftId, worktreePath, draft, manualFiles, autoFiles, correlationId } = opts;
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;
  await updateTrace(draftId, 'relevance', 'pending');
  const hasPrecomputedFiles = manualFiles.length > 0 || autoFiles.length > 0;

  if (hasPrecomputedFiles) {
    const relevantFilePaths = [...new Set([...manualFiles, ...autoFiles])];
    correlatedLogger.info({
      selectionSource: 'precomputed',
      manualFiles: { count: manualFiles.length, files: manualFiles.slice(0, 10) },
      autoFiles: { count: autoFiles.length, files: autoFiles.slice(0, 10) },
      totalUniqueFiles: relevantFilePaths.length,
      overlap: manualFiles.filter(f => autoFiles.includes(f)).length
    }, 'File selection breakdown (precomputed)');

    await updateTrace(draftId, 'relevance', 'completed', {
      keywords: [],
      candidates: relevantFilePaths.map(p => ({ path: p, reason: manualFiles.includes(p) ? 'manual' : 'auto', score: 100 })),
      source: 'precomputed'
    });
    return relevantFilePaths;
  }

  correlatedLogger.info({ repository: draft.repository }, 'Finding relevant files');
  const relevanceResult = await findRelevantFiles(worktreePath, draft.initial_prompt, { correlationId });
  const relevantFilePaths = relevanceResult.files.map(f => f.path);

  correlatedLogger.info({
    selectionSource: 'auto-relevance',
    totalFound: relevanceResult.files.length,
    keywordsDetected: relevanceResult.keywordsDetected,
    topCandidates: relevanceResult.files.slice(0, 5).map(f => ({ path: f.path, score: f.score, reason: f.reason })),
    scoreDistribution: {
      high: relevanceResult.files.filter(f => f.score > 80).length,
      medium: relevanceResult.files.filter(f => f.score > 50 && f.score <= 80).length,
      low: relevanceResult.files.filter(f => f.score <= 50).length
    }
  }, 'Relevance analysis complete');

  await updateTrace(draftId, 'relevance', 'completed', {
    keywords: relevanceResult.keywordsDetected,
    candidates: relevanceResult.files.map(f => ({ path: f.path, reason: f.reason, score: f.score }))
  });
  return relevantFilePaths;
}
