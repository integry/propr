/* eslint-disable max-lines */
import { db } from '../db/connection.js';
import { MODEL_LIMITS, TIKTOKEN_TO_CLAUDE_RATIO, getEffectiveTokenLimit, getModelHardLimit, ContextLevel, DEFAULT_CONTEXT_LEVEL, MAX_CONTEXT_LEVEL } from '../config/modelLimits.js';
import { MODEL_INFO_MAP } from '../config/modelDefinitions.js';
import { countTokens, estimateTokens } from '../utils/tokenCalculation.js';
import { findRelevantFiles } from './relevanceService.js';
import { getModelPricing } from './pricingService.js';
import { getAgentRegistry } from '../agents/AgentRegistry.js';
import { generateContext, selectFilesWithinLimit } from './contextService.js';
import { parseFileReferences, getResolvedPaths } from './relevance/fileReferenceParser.js';
import logger from '../utils/logger.js';
import type { LogFn } from 'pino';
import { simpleGit } from 'simple-git';
import { Plan, GRANULARITY_INSTRUCTIONS, PLANNER_SYSTEM_PROMPT } from '../claude/prompts/plannerPrompts.js';
import type { Attachment } from './attachmentService.js';
import { buildSummaryContext } from './relevance/contextBuilder.js';
import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';

/**
 * Compute a hash of content-affecting parameters to determine if regeneration is needed.
 * Does NOT include granularity or contextLevel since those don't affect actual content.
 */
function computeContentHash(params: {
  prompt: string;
  baseBranch: string;
  compress: boolean;
  manualFiles: string[];
  attachmentsJson: string;
}): string {
  const data = JSON.stringify([
    params.prompt,
    params.baseBranch,
    params.compress,
    params.manualFiles.sort(),
    params.attachmentsJson
  ]);
  return crypto.createHash('md5').update(data).digest('hex');
}

/** Number of most relevant files to include summaries for */
export const RELEVANT_SUMMARY_COUNT = 100;

/** Reserved overhead for system prompts, XML structure, etc. */
export const RESERVED_OVERHEAD_TOKENS = 5000;

/** Chars per token estimate (conservative) */
export const CHARS_PER_TOKEN = 3;

/** Minimal logger interface compatible with both pino Logger and EnhancedLogger */
export type MinimalLogger = { info: LogFn; warn: LogFn };

export type Granularity = 'single' | 'balanced' | 'granular';

/**
 * Configuration for an additional context repository.
 * These repositories provide examples and documentation only - no code changes will be made to them.
 */
export interface ContextRepository {
  /** Repository identifier in format "owner/repo" */
  repository: string;
  /** Optional branch, defaults to the repository's default branch */
  branch?: string;
  /** Optional description of what this repository provides (e.g., "UI component examples") */
  description?: string;
}

/** Cached context data to avoid regeneration when only settings change */
export interface ContextCache {
  /** Hash of content-affecting params (prompt, branch, compress, files, attachments) */
  contentHash: string;
  /** Generated repomix output */
  repomixContext: string;
  /** Smart summaries (codebase overview) */
  smartSummaries?: string;
  /** Auto-detected relevant file paths */
  autoFilePaths: string[];
  /** Included files from repomix */
  includedFiles: string[];
  /** Token counts */
  repomixTokens: number;
  smartSummaryTokens: number;
  /** Per-file token counts for simulated truncation */
  fileTokenCounts: Record<string, number>;
  /** The token limit used when generating this cache (for validation) */
  cachedMaxTokenLimit?: number;
  /** Relevance scores for auto-detected files (path -> score 0-100) */
  fileScores?: Record<string, number>;
}

export interface TaskDraftConfig {
  baseBranch: string;
  granularity: Granularity;
  contextLevel?: ContextLevel;
  compress?: boolean;
  manualFiles: string[];
  autoFiles: string[];
  /** Additional repositories to include as reference context only (no code changes) */
  contextRepositories?: ContextRepository[];
  /** Cached context to avoid regeneration */
  contextCache?: ContextCache;
}

export interface ParsedContextConfig {
  baseBranch?: string;
  granularity: Granularity;
  contextLevel: ContextLevel;
  compress: boolean;
  tokenLimit: number;
  manualFiles: string[];
  autoFiles: string[];
  /** Additional repositories to include as reference context only */
  contextRepositories: ContextRepository[];
}

export function parseContextConfig(contextConfig: TaskDraftConfig | null, modelId?: string): ParsedContextConfig {
  return {
    baseBranch: contextConfig?.baseBranch,
    granularity: contextConfig?.granularity || 'balanced',
    contextLevel: contextConfig?.contextLevel ?? DEFAULT_CONTEXT_LEVEL,
    compress: contextConfig?.compress ?? false,
    tokenLimit: getEffectiveTokenLimit(modelId, contextConfig?.contextLevel ?? DEFAULT_CONTEXT_LEVEL),
    manualFiles: contextConfig?.manualFiles || [],
    autoFiles: contextConfig?.autoFiles || [],
    contextRepositories: contextConfig?.contextRepositories || []
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
  // Apply ratio to get conservative Claude token estimate
  const conservativeEstimate = Math.ceil(tiktokenEstimate * TIKTOKEN_TO_CLAUDE_RATIO);
  const effectiveLimit = modelLimit - CLAUDE_CODE_OVERHEAD;

  correlatedLogger.info({ tiktokenEstimate, conservativeEstimate, effectiveLimit, modelLimit }, 'Initial token estimate');

  // Check conservative estimate against limit
  if (conservativeEstimate > effectiveLimit) {
    correlatedLogger.warn({ conservativeEstimate, effectiveLimit, overage: conservativeEstimate - effectiveLimit },
      'Prompt exceeds token limit (conservative estimate)');
    return { valid: false, tokenCount: conservativeEstimate, source: 'tiktoken' };
  }

  // If well under the threshold with conservative estimate, tiktoken is good enough
  if (conservativeEstimate < effectiveLimit * API_VALIDATION_THRESHOLD) {
    return { valid: true, tokenCount: conservativeEstimate, source: 'tiktoken' };
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
    // API not available (no key or error) - use conservative estimate already calculated
    correlatedLogger.warn({ error: (error as Error).message }, 'API token counting failed, using conservative tiktoken estimate');
    return { valid: true, tokenCount: conservativeEstimate, source: 'tiktoken' };
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

// Re-export for use by taskPlanningService
export { getModelHardLimit };

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
  /** Model to use for context analysis (e.g., 'haiku', 'claude:claude-haiku-4-5-20251001') */
  contextModel?: string;
}

export async function findFilesForPlan(opts: FindFilesOptions): Promise<string[]> {
  const { draftId, worktreePath, draft, manualFiles, autoFiles, correlationId, contextModel } = opts;
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

  correlatedLogger.info({ repository: draft.repository, contextModel }, 'Finding relevant files');

  // Get agent for semantic scoring based on contextModel prefix (e.g., "claude:model-id" -> use claude agent)
  const registry = getAgentRegistry();
  await registry.ensureInitialized();
  let agent = registry.getDefaultAgent();
  if (contextModel && contextModel.includes(':')) {
    const agentAlias = contextModel.split(':')[0];
    const selectedAgent = registry.getAgentByAlias(agentAlias);
    if (selectedAgent) {
      agent = selectedAgent;
      correlatedLogger.info({ agentAlias, contextModel }, 'Using agent from contextModel prefix');
    }
  }

  // Let semantic scorer default to HEAD branch
  // Pass modelId for context analysis if specified
  const relevanceResult = await findRelevantFiles(worktreePath, draft.initial_prompt, {
    correlationId,
    useSummaryScoring: !!agent,
    agent,
    repoName: draft.repository,
    modelId: contextModel
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
  attachmentTokens?: number;
  maxTokens: number;
  /** Name of the model used for context limits (e.g., "Claude Sonnet 4.5") */
  modelName?: string;
  /** Full context window size of the model in tokens (e.g., 200000, 1000000) */
  modelMaxContextTokens?: number;
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
  /** Model to use for context analysis (e.g., 'haiku', 'claude:claude-haiku-4-5-20251001') */
  contextModel?: string;
  /** Model to use for generation, determining the max context window */
  generationModel?: string;
}

export interface Base64Image {
  name: string;
  mimeType: string;
  base64Data: string;
}

interface BuildFullContextOptions {
  userRequest: string;
  repomixContext: string;
  granularity: Granularity;
  fileSummaries?: string;
  /** Smart context with directory and file summaries (tiered by relevance) */
  smartSummaries?: string;
  images?: Base64Image[];
  /** Context from additional repositories (marked as example/reference only) */
  additionalContext?: string;
}

/**
 * Get a final reminder string based on granularity to reinforce task count constraints
 */
function getGranularityReminder(granularity: Granularity): string {
  switch (granularity) {
    case 'single':
      return `FINAL REMINDER — SINGLE TASK MODE:
⚠️ You MUST return a JSON array with EXACTLY 1 element.
⚠️ Do NOT create multiple tasks. Combine everything into ONE comprehensive task.
⚠️ Array length must equal 1. This is mandatory.`;
    case 'balanced':
      return `REMINDER: Aim for 2-4 tasks total. Group related changes together.`;
    case 'granular':
      return `REMINDER: Create fine-grained tasks (5+ if needed). Each task should be small and focused.`;
  }
}

export function buildFullContext(options: BuildFullContextOptions): string {
  const { userRequest, repomixContext, granularity, fileSummaries, smartSummaries, images, additionalContext } = options;
  const granularitySpec = GRANULARITY_INSTRUCTIONS[granularity];
  const granularityReminder = getGranularityReminder(granularity);
  const summariesSection = fileSummaries && fileSummaries.trim().length > 0
    ? `\n  <relevant-file-summaries>\n${fileSummaries}\n  </relevant-file-summaries>` : '';

  // Build smart summaries section (directory structure and file summaries)
  const smartSummariesSection = smartSummaries && smartSummaries.trim().length > 0
    ? `\n  <codebase-overview>\n${smartSummaries}\n  </codebase-overview>` : '';

  // Build images section if images are provided
  let imagesSection = '';
  if (images && images.length > 0) {
    const imageEntries = images.map(img =>
      `    <image name="${img.name}" type="${img.mimeType}"><![CDATA[data:${img.mimeType};base64,${img.base64Data}]]></image>`
    ).join('\n');
    imagesSection = `\n  <attachments>\n${imageEntries}\n  </attachments>`;
  }

  // Build additional context section if provided (from context repositories)
  let additionalContextSection = '';
  if (additionalContext && additionalContext.trim().length > 0) {
    additionalContextSection = `
  <example-context>
<![CDATA[
=== REFERENCE MATERIAL ONLY - DO NOT IMPLEMENT IN THESE LOCATIONS ===
The following content is provided as examples and documentation reference.
Do NOT create or modify files based on paths shown here.
All implementation must be done in the target repository only.

${additionalContext}

=== END REFERENCE MATERIAL ===
]]>
  </example-context>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<llm-context>
  <system-prompt><![CDATA[${PLANNER_SYSTEM_PROMPT}]]></system-prompt>
  <user-request><![CDATA[${userRequest}]]></user-request>${imagesSection}
  <granularity-spec><![CDATA[${granularitySpec}]]></granularity-spec>${smartSummariesSection}
  <repository-context>
${repomixContext}
  </repository-context>${summariesSection}${additionalContextSection}
  <output-guidelines><![CDATA[Output ONLY a valid JSON array. No markdown, no explanations.]]></output-guidelines>
  <granularity-reminder><![CDATA[${granularityReminder}]]></granularity-reminder>
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
  attachments?: string | Attachment[];
  status: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * Parse attachments from draft (JSON string from SQLite or array)
 */
function parseDraftAttachments(attachments: string | Attachment[] | undefined): Attachment[] {
  if (!attachments) return [];
  if (typeof attachments === 'string') {
    try { return JSON.parse(attachments); } catch { return []; }
  }
  return Array.isArray(attachments) ? attachments : [];
}

/**
 * Parse existing context_config from draft
 */
function parseExistingContextConfig(contextConfig: TaskDraftConfig | string | null | undefined): TaskDraftConfig | null {
  if (!contextConfig) return null;
  if (typeof contextConfig === 'string') {
    try { return JSON.parse(contextConfig); } catch { return null; }
  }
  return contextConfig as TaskDraftConfig;
}

/**
 * Load images from attachments and calculate tokens
 */
async function loadImagesFromAttachments(
  attachments: Attachment[],
  correlatedLogger: MinimalLogger
): Promise<{ base64Images: Base64Image[]; imageTokens: number }> {
  const base64Images: Base64Image[] = [];
  let imageTokens = 0;
  for (const img of attachments.filter(a => a.type === 'image')) {
    try {
      const absolutePath = path.isAbsolute(img.storedPath)
        ? img.storedPath
        : path.join(process.cwd(), img.storedPath);
      const imageData = await fs.readFile(absolutePath);
      const base64Data = imageData.toString('base64');
      imageTokens += Math.ceil((base64Data.length / 4) * 1.1);
      base64Images.push({ name: img.originalName, mimeType: img.mimeType, base64Data });
    } catch (error) {
      correlatedLogger.warn({ imagePath: img.storedPath, error: (error as Error).message }, 'Failed to load image for preview');
    }
  }
  return { base64Images, imageTokens };
}

interface RegenerateContextParams {
  baseBranch: string;
  worktreePath: string;
  prompt: string;
  manualFiles: string[];
  draft: TaskDraft;
  contextModel: string | undefined;
  compress: boolean;
  previewTokenLimit: number;
  correlationId: string | undefined;
  correlatedLogger: MinimalLogger;
}

interface ContextData {
  repomixContext: string;
  smartSummaries: string | undefined;
  autoFilePaths: string[];
  includedFiles: string[];
  repomixTokens: number;
  smartSummaryTokens: number;
  fileTokenCounts: Record<string, number>;
  /** Relevance scores for auto-detected files (path -> score 0-100) */
  fileScores: Record<string, number>;
}

/**
 * Extract context data from cache
 */
function extractContextFromCache(cache: ContextCache): ContextData {
  return {
    repomixContext: cache.repomixContext,
    smartSummaries: cache.smartSummaries,
    autoFilePaths: cache.autoFilePaths,
    includedFiles: cache.includedFiles,
    repomixTokens: cache.repomixTokens,
    smartSummaryTokens: cache.smartSummaryTokens,
    fileTokenCounts: cache.fileTokenCounts,
    fileScores: cache.fileScores || {}
  };
}

/**
 * Get cache invalidation reason for logging
 */
function getCacheInvalidationReason(
  cache: ContextCache | undefined,
  contentHash: string,
  cacheHasSufficientLimit: boolean,
  maxTokenLimit: number
): string {
  if (!cache) return 'no cache';
  if (cache.contentHash !== contentHash) return 'content changed';
  if (!cache.fileTokenCounts) return 'missing fileTokenCounts';
  if (!cacheHasSufficientLimit) return `cached limit (${cache.cachedMaxTokenLimit}) < required (${maxTokenLimit})`;
  return 'unknown';
}

/**
 * Calculate attachment tokens from loaded attachments
 */
function calculateAttachmentTokens(attachments: Attachment[], imageTokens: number): number {
  const textAttachmentTokens = attachments
    .filter(a => a.type === 'text')
    .reduce((sum, a) => sum + (a.tokenEstimate || 0), 0);
  return imageTokens + textAttachmentTokens;
}

/**
 * Build smart selection array from included files
 */
function buildSmartSelection(
  manualFiles: string[],
  autoFilePaths: string[],
  includedFilesSet: Set<string>,
  fileScores: Record<string, number>
): SmartFileSelection[] {
  return [
    ...manualFiles.filter(p => includedFilesSet.has(p)).map(p => ({
      path: p,
      reason: 'Explicitly included',
      source: 'manual' as const,
      score: fileScores[p] ?? 100  // Manual files get 100 if no score
    })),
    ...autoFilePaths.filter(p => includedFilesSet.has(p) && !manualFiles.includes(p)).map(p => ({
      path: p,
      reason: 'Auto-detected',
      source: 'auto' as const,
      score: fileScores[p] ?? 0
    }))
  ];
}

/**
 * Get model display info from model ID
 */
function getModelDisplayInfo(generationModel: string | undefined): { modelName?: string; modelMaxContextTokens?: number } {
  if (!generationModel) return {};
  const effectiveModelId = generationModel.includes(':') ? generationModel.split(':')[1] : generationModel;
  const modelInfo = MODEL_INFO_MAP[effectiveModelId];
  if (!modelInfo) return {};
  return { modelName: modelInfo.name, modelMaxContextTokens: modelInfo.maxTokens };
}

interface RegenerateContextResult {
  repomixContext: string;
  smartSummaries: string | undefined;
  autoFilePaths: string[];
  includedFiles: string[];
  repomixTokens: number;
  smartSummaryTokens: number;
  securityWarnings: string[];
  fileTokenCounts: Record<string, number>;
  /** Relevance scores for auto-detected files (path -> score 0-100) */
  fileScores: Record<string, number>;
}

/**
 * Regenerate context when content has changed
 */
async function regenerateContext(params: RegenerateContextParams): Promise<RegenerateContextResult> {
  const { baseBranch, worktreePath, prompt, manualFiles, draft, contextModel, compress, previewTokenLimit, correlationId, correlatedLogger } = params;
  const securityWarnings: string[] = [];

  try {
    await checkoutBranch(worktreePath, baseBranch);
    correlatedLogger.info({ baseBranch, worktreePath }, 'Checked out branch for preview');
  } catch (error) {
    if (error instanceof BranchNotFoundError) throw error;
    throw new PlanningFailedError(`Failed to checkout branch '${baseBranch}': ${(error as Error).message}`);
  }

  // Parse @file references from the prompt
  const fileRefResult = await parseFileReferences(prompt, worktreePath, { correlationId });
  const referencedFiles = getResolvedPaths(fileRefResult);
  const allManualFiles = [...manualFiles];
  if (referencedFiles.length > 0) {
    allManualFiles.push(...referencedFiles);
  }

  // Get agent for semantic scoring
  const registry = getAgentRegistry();
  await registry.ensureInitialized();
  let agent = registry.getDefaultAgent();
  if (contextModel && contextModel.includes(':')) {
    const agentAlias = contextModel.split(':')[0];
    const selectedAgent = registry.getAgentByAlias(agentAlias);
    if (selectedAgent) agent = selectedAgent;
  }

  // Find relevant files
  const relevanceResult = await findRelevantFiles(worktreePath, fileRefResult.cleanedPrompt || prompt, {
    correlationId, useSummaryScoring: !!agent, useLLMKeywords: true, agent,
    repoName: draft.repository, branch: baseBranch, modelId: contextModel
  });

  const autoFilePaths = relevanceResult.files.map(f => f.path);
  // Build a map of file paths to their relevance scores
  const fileScores: Record<string, number> = {};
  for (const file of relevanceResult.files) {
    fileScores[file.path] = file.score;
  }
  const combinedFiles = [...new Set([...allManualFiles, ...autoFilePaths])];

  correlatedLogger.info({ manualFiles: { count: allManualFiles.length }, autoFiles: { count: autoFilePaths.length }, combinedCount: combinedFiles.length }, 'Preview file selection');

  const filesToInclude = compress ? undefined : (combinedFiles.length > 0 ? combinedFiles : undefined);
  const priorityFiles = compress ? combinedFiles : undefined;
  const contextResult = await generateContext({ repoPath: worktreePath, filesToInclude, priorityFiles, tokenLimit: previewTokenLimit, compress, correlationId });

  // Build smart summary context
  const smartSummaryBudget = Math.floor(previewTokenLimit * 0.1);
  const smartSummaryResult = await buildSummaryContext({ tokenBudget: smartSummaryBudget, priorityPaths: combinedFiles, repoName: draft.repository as string, correlationId });

  // Add warning if files were skipped due to security concerns
  if (contextResult.skippedSecurityFiles && contextResult.skippedSecurityFiles.length > 0) {
    const skippedPaths = contextResult.skippedSecurityFiles.map(f => f.filePath).join(', ');
    securityWarnings.push(`${contextResult.skippedSecurityFiles.length} file(s) skipped due to potential secrets: ${skippedPaths}`);
  }

  return {
    repomixContext: contextResult.context,
    smartSummaries: smartSummaryResult.context || undefined,
    autoFilePaths,
    includedFiles: contextResult.includedFiles,
    repomixTokens: contextResult.totalTokens,
    smartSummaryTokens: smartSummaryResult.estimatedTokens || 0,
    securityWarnings,
    fileTokenCounts: contextResult.fileTokenCounts,
    fileScores
  };
}

export async function generateContextPreview(options: GenerateContextPreviewOptions): Promise<PreviewResult> {
  const { draftId, prompt, baseBranch, granularity, contextLevel = DEFAULT_CONTEXT_LEVEL, compress = false, files, worktreePath, correlationId, contextModel, generationModel } = options;
  const targetTokenLimit = getEffectiveTokenLimit(generationModel, contextLevel);
  const maxTokenLimit = getEffectiveTokenLimit(generationModel, MAX_CONTEXT_LEVEL);
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;
  const warnings: string[] = [];

  if (!db) throw new PlanningFailedError('Database not available');
  correlatedLogger.info({ draftId, baseBranch, granularity, contextModel, generationModel, targetTokenLimit, maxTokenLimit }, 'Starting context preview generation');

  const draft = await db<TaskDraft>('task_drafts').where({ draft_id: draftId }).first();
  if (!draft) throw new PlanningFailedError(`Draft not found: ${draftId}`);

  const attachments = parseDraftAttachments(draft.attachments);
  const existingConfig = parseExistingContextConfig(draft.context_config);
  const manualFiles = [...new Set([...(files || [])])];
  const contentHash = computeContentHash({
    prompt, baseBranch, compress, manualFiles,
    attachmentsJson: JSON.stringify(attachments.map(a => ({ id: a.id, storedPath: a.storedPath })))
  });

  const cache = existingConfig?.contextCache;
  const cacheHasSufficientLimit = !cache?.cachedMaxTokenLimit || cache.cachedMaxTokenLimit >= maxTokenLimit;
  const canUseCache = cache && cache.contentHash === contentHash && cache.fileTokenCounts && cacheHasSufficientLimit;

  const { base64Images, imageTokens } = await loadImagesFromAttachments(attachments, correlatedLogger);
  const attachmentTokens = calculateAttachmentTokens(attachments, imageTokens);

  let contextData: ContextData;
  if (canUseCache) {
    correlatedLogger.info({ contentHash }, 'Using cached context (only settings changed)');
    contextData = extractContextFromCache(cache);
  } else {
    const reason = getCacheInvalidationReason(cache, contentHash, cacheHasSufficientLimit, maxTokenLimit);
    correlatedLogger.info({ contentHash, hadCache: !!cache, reason }, 'Regenerating context at MAX_CONTEXT_LEVEL');
    const result = await regenerateContext({
      baseBranch, worktreePath, prompt, manualFiles, draft, contextModel,
      compress, previewTokenLimit: maxTokenLimit, correlationId, correlatedLogger
    });
    contextData = {
      repomixContext: result.repomixContext,
      smartSummaries: result.smartSummaries,
      autoFilePaths: result.autoFilePaths,
      includedFiles: result.includedFiles,
      repomixTokens: result.repomixTokens,
      smartSummaryTokens: result.smartSummaryTokens,
      fileTokenCounts: result.fileTokenCounts,
      fileScores: result.fileScores
    };
    warnings.push(...result.securityWarnings);
  }

  const { repomixContext, smartSummaries, autoFilePaths, includedFiles, smartSummaryTokens, fileTokenCounts, fileScores } = contextData;
  const combinedFiles = [...new Set([...manualFiles, ...autoFilePaths])];
  const simulatedSelection = selectFilesWithinLimit(
    fileTokenCounts, targetTokenLimit,
    compress ? undefined : (combinedFiles.length > 0 ? combinedFiles : undefined),
    compress ? combinedFiles : undefined
  );

  const simulatedIncludedFiles = simulatedSelection.selectedFiles;
  const simulatedTokens = simulatedSelection.currentTokens;
  const includedFilesSet = new Set(simulatedIncludedFiles);

  correlatedLogger.info({
    cachedFiles: includedFiles.length, cachedTokens: contextData.repomixTokens,
    simulatedFiles: simulatedIncludedFiles.length, simulatedTokens, targetTokenLimit, strategy: simulatedSelection.strategy
  }, 'Simulated file selection for context level');

  const costEstimate = await calculateCostEstimate(simulatedTokens, warnings, correlatedLogger);
  const smartSelection = buildSmartSelection(manualFiles, autoFilePaths, includedFilesSet, fileScores);
  const fullContext = buildFullContext({
    userRequest: prompt, repomixContext, granularity, smartSummaries,
    images: base64Images.length > 0 ? base64Images : undefined
  });

  const newCache: ContextCache = {
    contentHash, repomixContext, smartSummaries, autoFilePaths, includedFiles,
    repomixTokens: contextData.repomixTokens, smartSummaryTokens, fileTokenCounts, cachedMaxTokenLimit: maxTokenLimit,
    fileScores
  };

  await db('task_drafts').where({ draft_id: draftId }).update({
    initial_prompt: prompt,
    context_config: JSON.stringify({ baseBranch, granularity, contextLevel, compress, manualFiles, autoFiles: autoFilePaths, contextCache: newCache }),
    generated_context: fullContext,
    updated_at: db.fn.now()
  });

  const estimatedActualTokens = Math.ceil(simulatedTokens * TIKTOKEN_TO_CLAUDE_RATIO);
  const totalTokens = estimatedActualTokens + attachmentTokens + smartSummaryTokens;
  const { modelName, modelMaxContextTokens } = getModelDisplayInfo(generationModel);

  correlatedLogger.info({ usedCache: canUseCache, tiktokenCount: simulatedTokens, estimatedActualTokens, attachmentTokens, smartSummaryTokens, totalTokens, costEstimate, fileCount: simulatedIncludedFiles.length, modelName, modelMaxContextTokens }, 'Context preview completed');

  return {
    success: true,
    stats: { totalTokens, tiktokenCount: simulatedTokens, costEstimate, contextLength: repomixContext.length, fileCount: simulatedIncludedFiles.length, attachmentTokens, maxTokens: targetTokenLimit, modelName, modelMaxContextTokens },
    smartSelection,
    warnings
  };
}
