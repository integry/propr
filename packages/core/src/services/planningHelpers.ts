import { db } from '../db/connection.js';
import { MODEL_LIMITS, TIKTOKEN_TO_CLAUDE_RATIO, getEffectiveTokenLimit, ContextLevel, DEFAULT_CONTEXT_LEVEL } from '../config/modelLimits.js';
import { countTokens, estimateTokens } from '../utils/tokenCalculation.js';
import { findRelevantFiles } from './relevanceService.js';
import { getModelPricing } from './pricingService.js';
import { getAgentRegistry } from '../agents/AgentRegistry.js';
import { generateContext } from './contextService.js';
import { parseFileReferences, getResolvedPaths } from './relevance/fileReferenceParser.js';
import logger from '../utils/logger.js';
import type { LogFn } from 'pino';
import { simpleGit } from 'simple-git';
import { Plan, GRANULARITY_INSTRUCTIONS, PLANNER_SYSTEM_PROMPT } from '../claude/prompts/plannerPrompts.js';

/** Number of most relevant files to include summaries for */
export const RELEVANT_SUMMARY_COUNT = 100;

/** Reserved overhead for system prompts, XML structure, etc. */
export const RESERVED_OVERHEAD_TOKENS = 5000;

/** Chars per token estimate (conservative) */
export const CHARS_PER_TOKEN = 3;

/** Minimal logger interface compatible with both pino Logger and EnhancedLogger */
export type MinimalLogger = { info: LogFn; warn: LogFn };

export type Granularity = 'single' | 'balanced' | 'granular';

export interface TaskDraftConfig {
  baseBranch: string;
  granularity: Granularity;
  contextLevel?: ContextLevel;
  compress?: boolean;
  manualFiles: string[];
  autoFiles: string[];
}

export interface ParsedContextConfig {
  baseBranch?: string;
  granularity: Granularity;
  contextLevel: ContextLevel;
  compress: boolean;
  tokenLimit: number;
  manualFiles: string[];
  autoFiles: string[];
}

export function parseContextConfig(contextConfig: TaskDraftConfig | null): ParsedContextConfig {
  return {
    baseBranch: contextConfig?.baseBranch,
    granularity: contextConfig?.granularity || 'balanced',
    contextLevel: contextConfig?.contextLevel ?? DEFAULT_CONTEXT_LEVEL,
    compress: contextConfig?.compress ?? false,
    tokenLimit: getEffectiveTokenLimit(undefined, contextConfig?.contextLevel ?? DEFAULT_CONTEXT_LEVEL),
    manualFiles: contextConfig?.manualFiles || [],
    autoFiles: contextConfig?.autoFiles || []
  };
}

export async function checkoutBaseBranch(
  worktreePath: string,
  baseBranch: string | undefined,
  correlatedLogger: MinimalLogger
): Promise<void> {
  if (!baseBranch) return;
  try {
    await checkoutBranch(worktreePath, baseBranch);
    correlatedLogger.info({ baseBranch, worktreePath }, 'Checked out configured base branch');
  } catch (error) {
    if (error instanceof BranchNotFoundError) throw error;
    correlatedLogger.warn({ baseBranch, error: (error as Error).message }, 'Failed to checkout base branch');
  }
}

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
  const trace: GenerationTrace = { steps: Array.isArray(rawTrace?.steps) ? rawTrace.steps : [] };

  const existingStepIndex = trace.steps.findIndex((s) => s.name === step);
  if (existingStepIndex >= 0) {
    trace.steps[existingStepIndex] = { ...trace.steps[existingStepIndex], status, data: { ...trace.steps[existingStepIndex].data, ...data } };
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

  // Get agent for semantic scoring
  const registry = getAgentRegistry();
  await registry.ensureInitialized();
  const agent = registry.getDefaultAgent();

  // Let semantic scorer default to HEAD branch
  const relevanceResult = await findRelevantFiles(worktreePath, draft.initial_prompt, {
    correlationId,
    useSummaryScoring: !!agent,
    agent,
    repoName: draft.repository
  });
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

export class PlanningFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanningFailedError';
  }
}

export interface SmartFileSelection {
  path: string;
  reason: string;
  source: 'manual' | 'auto';
  score?: number;
}

export interface PreviewStats {
  totalTokens: number;
  tiktokenCount?: number;
  costEstimate: number;
  contextLength: number;
  fileCount: number;
}

export interface PreviewResult {
  success: boolean;
  stats: PreviewStats;
  smartSelection: SmartFileSelection[];
  warnings: string[];
}

export interface GenerateContextPreviewOptions {
  draftId: string;
  prompt: string;
  baseBranch: string;
  granularity: Granularity;
  contextLevel?: ContextLevel;
  compress?: boolean;
  files?: string[];
  worktreePath: string;
  correlationId?: string;
}

interface BuildFullContextOptions {
  userRequest: string;
  repomixContext: string;
  granularity: Granularity;
  fileSummaries?: string;
}

export function buildFullContext(options: BuildFullContextOptions): string {
  const { userRequest, repomixContext, granularity, fileSummaries } = options;
  const granularitySpec = GRANULARITY_INSTRUCTIONS[granularity];
  const summariesSection = fileSummaries && fileSummaries.trim().length > 0
    ? `\n  <relevant-file-summaries>\n${fileSummaries}\n  </relevant-file-summaries>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<llm-context>
  <system-prompt><![CDATA[${PLANNER_SYSTEM_PROMPT}]]></system-prompt>
  <user-request><![CDATA[${userRequest}]]></user-request>
  <granularity-spec><![CDATA[${granularitySpec}]]></granularity-spec>
  <repository-context>
${repomixContext}
  </repository-context>${summariesSection}
  <output-guidelines><![CDATA[Output ONLY a valid JSON array. No markdown, no explanations.]]></output-guidelines>
</llm-context>`;
}

interface TaskDraft {
  draft_id: string;
  user_id: string;
  repository: string;
  name: string;
  initial_prompt: string;
  plan_json: Plan;
  context_config: TaskDraftConfig;
  generation_trace: GenerationTrace;
  status: string;
  created_at: Date;
  updated_at: Date;
}

export async function generateContextPreview(options: GenerateContextPreviewOptions): Promise<PreviewResult> {
  const { draftId, prompt, baseBranch, granularity, contextLevel = DEFAULT_CONTEXT_LEVEL, compress = false, files, worktreePath, correlationId } = options;
  const previewTokenLimit = getEffectiveTokenLimit(undefined, contextLevel);
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;
  const warnings: string[] = [];

  if (!db) throw new PlanningFailedError('Database not available');
  correlatedLogger.info({ draftId, baseBranch, granularity }, 'Starting context preview generation');

  const draft = await db<TaskDraft>('task_drafts').where({ draft_id: draftId }).first();
  if (!draft) throw new PlanningFailedError(`Draft not found: ${draftId}`);

  try {
    await checkoutBranch(worktreePath, baseBranch);
    correlatedLogger.info({ baseBranch, worktreePath }, 'Checked out branch for preview');
  } catch (error) {
    if (error instanceof BranchNotFoundError) throw error;
    throw new PlanningFailedError(`Failed to checkout branch '${baseBranch}': ${(error as Error).message}`);
  }

  correlatedLogger.info({ repository: draft.repository }, 'Finding relevant files for preview');

  // Parse @file references from the prompt (e.g., @tab-top.html, @www/css/style.less)
  const fileRefResult = await parseFileReferences(prompt, worktreePath, { correlationId });
  const referencedFiles = getResolvedPaths(fileRefResult);

  if (referencedFiles.length > 0) {
    correlatedLogger.info({
      referencedFiles,
      unresolvedRefs: fileRefResult.references.filter(r => !r.resolved).map(r => r.original)
    }, 'Parsed @file references from prompt');
  }

  const registry = getAgentRegistry();
  await registry.ensureInitialized();
  const agent = registry.getDefaultAgent();

  // Use cleaned prompt (without @references) for relevance search
  // Enable LLM keyword extraction for better alternatives and spelling variants
  const relevanceResult = await findRelevantFiles(worktreePath, fileRefResult.cleanedPrompt || prompt, {
    correlationId,
    useSummaryScoring: !!agent,
    useLLMKeywords: true,
    agent,
    repoName: draft.repository,
    branch: baseBranch
  });

  // Combine: user-provided files + @referenced files + auto-detected files
  const manualFiles = [...new Set([...(files || []), ...referencedFiles])];
  const autoFilePaths = relevanceResult.files.map(f => f.path);
  const combinedFiles = [...new Set([...manualFiles, ...autoFilePaths])];

  correlatedLogger.info({
    manualFiles: { count: manualFiles.length, files: manualFiles.slice(0, 10) },
    autoFiles: { count: autoFilePaths.length, topCandidates: relevanceResult.files.slice(0, 5).map(f => ({ path: f.path, score: f.score, reason: f.reason })) },
    scoreDistribution: {
      high: relevanceResult.files.filter(f => f.score > 80).length,
      medium: relevanceResult.files.filter(f => f.score > 50 && f.score <= 80).length,
      low: relevanceResult.files.filter(f => f.score <= 50).length
    },
    combinedCount: combinedFiles.length,
    overlap: manualFiles.filter(f => autoFilePaths.includes(f)).length
  }, 'Preview file selection breakdown');

  const filesToInclude = compress ? undefined : (combinedFiles.length > 0 ? combinedFiles : undefined);
  const priorityFiles = compress ? combinedFiles : undefined;
  const contextResult = await generateContext({ repoPath: worktreePath, filesToInclude, priorityFiles, tokenLimit: previewTokenLimit, compress, correlationId });
  const costEstimate = await calculateCostEstimate(contextResult.totalTokens, warnings, correlatedLogger);

  const includedFilesSet = new Set(contextResult.includedFiles);

  let smartSelection: SmartFileSelection[];
  if (compress) {
    const relevanceScores = new Map(relevanceResult.files.map(f => [f.path, f]));
    smartSelection = contextResult.includedFiles.map(path => {
      const relevanceInfo = relevanceScores.get(path);
      if (manualFiles.includes(path)) return { path, reason: 'Explicitly included', source: 'manual' as const };
      else if (relevanceInfo) return { path, reason: `${relevanceInfo.reason} (score: ${relevanceInfo.score})`, source: 'auto' as const, score: relevanceInfo.score };
      else return { path, reason: 'Included via compression', source: 'auto' as const };
    });
  } else {
    smartSelection = [
      ...manualFiles.filter(p => includedFilesSet.has(p)).map(p => ({ path: p, reason: 'Explicitly included', source: 'manual' as const })),
      ...relevanceResult.files.filter(f => includedFilesSet.has(f.path)).map(f => ({ path: f.path, reason: `${f.reason} (score: ${f.score})`, source: 'auto' as const, score: f.score }))
    ];
  }

  const fullContext = buildFullContext({ userRequest: prompt, repomixContext: contextResult.context, granularity });

  await db('task_drafts').where({ draft_id: draftId }).update({
    initial_prompt: prompt,
    context_config: JSON.stringify({ baseBranch, granularity, contextLevel, compress, manualFiles, autoFiles: autoFilePaths }),
    generated_context: fullContext,
    updated_at: db.fn.now()
  });

  const estimatedActualTokens = Math.ceil(contextResult.totalTokens * TIKTOKEN_TO_CLAUDE_RATIO);

  correlatedLogger.info({ tiktokenCount: contextResult.totalTokens, estimatedActualTokens, costEstimate, fileCount: contextResult.includedFiles.length }, 'Context preview completed');

  return {
    success: true,
    stats: { totalTokens: estimatedActualTokens, tiktokenCount: contextResult.totalTokens, costEstimate, contextLength: contextResult.totalCharacters, fileCount: contextResult.includedFiles.length },
    smartSelection,
    warnings
  };
}
