/**
 * Type definitions for the planning service.
 * Extracted from planningHelpers.ts for better organization.
 */

import type { LogFn } from 'pino';
import { CODEX_CLI_CONTEXT_LIMIT } from '../../config/modelLimits.js';
import type { ContextLevel } from '../../config/modelLimits.js';
import type { Attachment } from '../attachmentService.js';
import type { StepStatus } from '@propr/shared';

/** Reserved overhead for system prompts, XML structure, etc. */
export const RESERVED_OVERHEAD_TOKENS = 5000;

/** Chars per token estimate (conservative) */
export const CHARS_PER_TOKEN = 3;

/** Buffer for Claude Code overhead */
export const CLAUDE_CODE_OVERHEAD = 5000;

/** Codex CLI planner calls are capped to the usable input budget, after output reservation. */
export const CODEX_RAW_INPUT_LIMIT_CHARS = CODEX_CLI_CONTEXT_LIMIT * CHARS_PER_TOKEN;

/** Leave room for agent-specific prompt suffixes added after planner validation. */
export const CODEX_RAW_INPUT_SAFETY_MARGIN_CHARS = 30_000;

/** Planner prompt cap for Codex-backed analysis calls. */
export const CODEX_PLANNER_INPUT_LIMIT_CHARS = CODEX_RAW_INPUT_LIMIT_CHARS - CODEX_RAW_INPUT_SAFETY_MARGIN_CHARS;

/** Minimal logger interface compatible with both pino Logger and EnhancedLogger */
export type MinimalLogger = { info: LogFn; warn: LogFn; error: LogFn };

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
  /** Model to use for plan generation (e.g., 'opus', 'claude:claude-opus-4-5-20251101') - overrides global setting */
  generationModel?: string;
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
  /** Model to use for plan generation (e.g., 'opus', 'claude:claude-opus-4-5-20251101') */
  generationModel?: string;
}

export interface GenerationTraceStep {
  name: string;
  status: StepStatus;
  data?: Record<string, unknown>;
}

export interface GenerationTrace {
  steps: GenerationTraceStep[];
}

export interface TokenValidationResult {
  valid: boolean;
  tokenCount: number;
  limit: number;
  utilization: number;
  exceedsHardLimit?: boolean;
  exceeds80Percent?: boolean;
  warning?: string;
}

export interface SmartFileSelection {
  path: string;
  reason: string;
  source: 'manual' | 'auto' | 'context-repo';
  /** Repository name for context-repo files */
  repository?: string;
  score?: number;
}

export interface PreviewStats {
  totalTokens: number;
  tiktokenCount?: number;
  costEstimate: number;
  contextLength: number;
  fileCount: number;
  /** File count from additional context repositories */
  contextRepoFileCount?: number;
  attachmentTokens?: number;
  maxTokens: number;
  /** Name of the model used for context limits (e.g., "Claude Sonnet 4.5") */
  modelName?: string;
  /** Full context window size of the model in tokens (e.g., 200000, 1000000) */
  modelMaxContextTokens?: number;
  /** Estimated percentage of the 5-hour session usage this task will consume */
  usageEstimatePercent?: number;
}

export interface PreviewResult {
  success: boolean;
  stats: PreviewStats;
  smartSelection: SmartFileSelection[];
  warnings: string[];
  /** Token counts per file for client-side context level simulation */
  fileTokenCounts?: Record<string, number>;
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
  /** Additional repositories to include as reference context */
  contextRepositories?: ContextRepository[];
  /** GitHub token for cloning context repositories */
  githubToken?: string;
  /** Files to exclude from the generated context */
  excludedFiles?: string[];
}

export interface Base64Image {
  name: string;
  mimeType: string;
  base64Data: string;
}

export interface FindFilesOptions {
  draftId: string;
  worktreePath: string;
  draft: TaskDraftForFind;
  manualFiles: string[];
  autoFiles: string[];
  correlationId?: string;
  contextModel?: string;
}

export interface TaskDraftForFind {
  initial_prompt: string;
  repository: string;
  attachments?: string | Attachment[];
}

/** Internal interface for task draft records */
export interface TaskDraft {
  draft_id: string;
  repository: string;
  initial_prompt: string;
  context_config?: TaskDraftConfig | string;
  attachments?: string | Attachment[];
  generated_context?: string;
}

/** Parameters for context regeneration */
export interface RegenerateContextParams {
  draftId: string;
  baseBranch: string;
  worktreePath: string;
  prompt: string;
  manualFiles: string[];
  draft: TaskDraft;
  contextModel?: string;
  /** Generation model for token ratio calculation (tiktoken is accurate for OpenAI, needs adjustment for Claude) */
  generationModel?: string;
  compress: boolean;
  previewTokenLimit: number;
  correlationId?: string;
  correlatedLogger: MinimalLogger;
  /** Files to exclude from the generated context */
  excludedFiles?: string[];
}

/** Result of context regeneration */
export interface RegenerateContextResult {
  repomixContext: string;
  smartSummaries?: string;
  autoFilePaths: string[];
  includedFiles: string[];
  repomixTokens: number;
  smartSummaryTokens: number;
  securityWarnings: string[];
  fileTokenCounts: Record<string, number>;
  fileScores: Record<string, number>;
}

/** Extracted context data from cache or regeneration */
export interface ContextData {
  repomixContext: string;
  smartSummaries?: string;
  autoFilePaths: string[];
  includedFiles: string[];
  repomixTokens: number;
  smartSummaryTokens: number;
  fileTokenCounts: Record<string, number>;
  fileScores: Record<string, number>;
}

/** Result of loading additional context from repositories */
export interface AdditionalContextLoadResult {
  additionalContext?: string;
  additionalContextTokens: number;
  additionalContextFiles: number;
  additionalContextFilesIncluded: Array<{ repository: string; path: string; score?: number; reason?: string }>;
  warnings: string[];
}
