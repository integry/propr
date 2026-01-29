/* eslint-disable max-lines */
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

export interface TaskDraftConfig {
  baseBranch: string;
  granularity: Granularity;
  contextLevel?: ContextLevel;
  compress?: boolean;
  manualFiles: string[];
  autoFiles: string[];
  /** Additional repositories to include as reference context only (no code changes) */
  contextRepositories?: ContextRepository[];
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

export function parseContextConfig(contextConfig: TaskDraftConfig | null): ParsedContextConfig {
  return {
    baseBranch: contextConfig?.baseBranch,
    granularity: contextConfig?.granularity || 'balanced',
    contextLevel: contextConfig?.contextLevel ?? DEFAULT_CONTEXT_LEVEL,
    compress: contextConfig?.compress ?? false,
    tokenLimit: getEffectiveTokenLimit(undefined, contextConfig?.contextLevel ?? DEFAULT_CONTEXT_LEVEL),
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
}

/** Helper to get agent based on context model prefix */
async function getAgentForContextModel(contextModel: string | undefined, correlatedLogger: MinimalLogger) {
  const registry = getAgentRegistry();
  await registry.ensureInitialized();
  let agent = registry.getDefaultAgent();
  if (contextModel && contextModel.includes(':')) {
    const agentAlias = contextModel.split(':')[0];
    const selectedAgent = registry.getAgentByAlias(agentAlias);
    if (selectedAgent) {
      agent = selectedAgent;
      correlatedLogger.info({ agentAlias, contextModel }, 'Using agent from contextModel prefix for preview');
    }
  }
  return agent;
}

/** Helper to build smart file selection from context result */
function buildSmartSelection(
  compress: boolean,
  includedFiles: string[],
  manualFiles: string[],
  relevanceFiles: { path: string; reason: string; score: number }[]
): SmartFileSelection[] {
  const includedFilesSet = new Set(includedFiles);

  if (compress) {
    const relevanceScores = new Map(relevanceFiles.map(f => [f.path, f]));
    return includedFiles.map(path => {
      const relevanceInfo = relevanceScores.get(path);
      if (manualFiles.includes(path)) return { path, reason: 'Explicitly included', source: 'manual' as const };
      if (relevanceInfo) return { path, reason: `${relevanceInfo.reason} (score: ${relevanceInfo.score})`, source: 'auto' as const, score: relevanceInfo.score };
      return { path, reason: 'Included via compression', source: 'auto' as const };
    });
  }

  return [
    ...manualFiles.filter(p => includedFilesSet.has(p)).map(p => ({ path: p, reason: 'Explicitly included', source: 'manual' as const })),
    ...relevanceFiles.filter(f => includedFilesSet.has(f.path)).map(f => ({ path: f.path, reason: `${f.reason} (score: ${f.score})`, source: 'auto' as const, score: f.score }))
  ];
}

/** Helper to calculate score distribution for logging */
function calculateScoreDistribution(files: { score: number }[]) {
  return {
    high: files.filter(f => f.score > 80).length,
    medium: files.filter(f => f.score > 50 && f.score <= 80).length,
    low: files.filter(f => f.score <= 50).length
  };
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
  const { userRequest, repomixContext, granularity, fileSummaries, images, additionalContext } = options;
  const granularitySpec = GRANULARITY_INSTRUCTIONS[granularity];
  const granularityReminder = getGranularityReminder(granularity);
  const summariesSection = fileSummaries && fileSummaries.trim().length > 0
    ? `\n  <relevant-file-summaries>\n${fileSummaries}\n  </relevant-file-summaries>` : '';

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
  <granularity-spec><![CDATA[${granularitySpec}]]></granularity-spec>
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
  status: string;
  created_at: Date;
  updated_at: Date;
}

export async function generateContextPreview(options: GenerateContextPreviewOptions): Promise<PreviewResult> {
  const { draftId, prompt, baseBranch, granularity, contextLevel = DEFAULT_CONTEXT_LEVEL, compress = false, files, worktreePath, correlationId, contextModel } = options;
  const previewTokenLimit = getEffectiveTokenLimit(undefined, contextLevel);
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;
  const warnings: string[] = [];

  if (!db) throw new PlanningFailedError('Database not available');
  correlatedLogger.info({ draftId, baseBranch, granularity, contextModel }, 'Starting context preview generation');

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

  // Get agent for semantic scoring based on contextModel prefix (e.g., "claude:model-id" -> use claude agent)
  const agent = await getAgentForContextModel(contextModel, correlatedLogger);

  // Use cleaned prompt (without @references) for relevance search
  // Enable LLM keyword extraction for better alternatives and spelling variants
  // Pass modelId for context analysis if specified
  const relevanceResult = await findRelevantFiles(worktreePath, fileRefResult.cleanedPrompt || prompt, {
    correlationId,
    useSummaryScoring: !!agent,
    useLLMKeywords: true,
    agent,
    repoName: draft.repository,
    branch: baseBranch,
    modelId: contextModel
  });

  // Combine: user-provided files + @referenced files + auto-detected files
  const manualFiles = [...new Set([...(files || []), ...referencedFiles])];
  const autoFilePaths = relevanceResult.files.map(f => f.path);
  const combinedFiles = [...new Set([...manualFiles, ...autoFilePaths])];

  correlatedLogger.info({
    manualFiles: { count: manualFiles.length, files: manualFiles.slice(0, 10) },
    autoFiles: { count: autoFilePaths.length, topCandidates: relevanceResult.files.slice(0, 5).map(f => ({ path: f.path, score: f.score, reason: f.reason })) },
    scoreDistribution: calculateScoreDistribution(relevanceResult.files),
    combinedCount: combinedFiles.length,
    overlap: manualFiles.filter(f => autoFilePaths.includes(f)).length
  }, 'Preview file selection breakdown');

  const filesToInclude = compress ? undefined : (combinedFiles.length > 0 ? combinedFiles : undefined);
  const priorityFiles = compress ? combinedFiles : undefined;
  const contextResult = await generateContext({ repoPath: worktreePath, filesToInclude, priorityFiles, tokenLimit: previewTokenLimit, compress, correlationId });

  // Add warning if files were skipped due to security concerns
  if (contextResult.skippedSecurityFiles && contextResult.skippedSecurityFiles.length > 0) {
    const skippedPaths = contextResult.skippedSecurityFiles.map(f => f.filePath).join(', ');
    warnings.push(`${contextResult.skippedSecurityFiles.length} file(s) skipped due to potential secrets: ${skippedPaths}`);
  }

  const costEstimate = await calculateCostEstimate(contextResult.totalTokens, warnings, correlatedLogger);

  const smartSelection = buildSmartSelection(
    compress,
    contextResult.includedFiles,
    manualFiles,
    relevanceResult.files
  );

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
