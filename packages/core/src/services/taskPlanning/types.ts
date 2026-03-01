/**
 * Type definitions for the task planning service.
 */

import type { Plan, PlanItem } from '../../claude/prompts/plannerPrompts.js';
import type { Attachment } from '../attachmentService.js';
import type {
  GenerationTrace, Granularity, TaskDraftConfig, MinimalLogger, Base64Image, ContextRepository
} from '../planningHelpers.js';

export { Plan, PlanItem };

/** Loaded images with token count */
export interface LoadedImages {
  images: Base64Image[];
  totalTokens: number;
}

/** Chat message structure for seeding refinement chat history */
export interface ChatHistoryMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

/** Metadata about granularity enforcement actions */
export interface GranularityEnforcementMetadata {
  /** Whether enforcement was applied */
  enforced: boolean;
  /** The granularity setting that was used */
  granularity: Granularity;
  /** Original task count before enforcement */
  originalTaskCount: number;
  /** Final task count after enforcement */
  finalTaskCount: number;
  /** Human-readable message about the enforcement action */
  message?: string;
}

/** Result of granularity enforcement */
export interface EnforceGranularityResult {
  plan: Plan;
  metadata: GranularityEnforcementMetadata;
}

export interface GeneratePlanOptions {
  draftId: string;
  worktreePath: string;
  githubToken: string;
  correlationId?: string;
}

export interface TokenBudgetResult {
  summaryTokenCost: number;
  smartSummaryBudget: number;
  additionalContextBudget: number;
  repomixTokenLimit: number;
}

export interface TokenBudgetOptions {
  tokenLimit: number;
  attachmentTokens: number;
  fullSummaryText: string;
  hasContextRepositories: boolean;
  correlatedLogger: MinimalLogger;
}

export interface AdditionalContextResult {
  context?: string;
}

export interface AdditionalContextOptions {
  contextRepositories: ContextRepository[] | undefined;
  additionalContextBudget: number;
  githubToken: string;
  draftId: string;
  correlationId: string | undefined;
  correlatedLogger: MinimalLogger;
}

export interface RefinePlanOptions {
  currentPlan: Plan;
  instruction: string;
  worktreePath: string;
  repository: string;
  githubToken: string;
  correlationId?: string;
  originalContext?: string;
  /** Draft ID for LLM metrics tracking */
  draftId?: string;
}

export interface RefinePlanResult {
  plan: Plan;
  action: 'modified' | 'answered' | 'clarify';
  summary: string;
}

export interface RefinePlanEstimation {
  estimatedDurationMs: number;
  startedAt: string;
  isHistoricalEstimate: boolean;
  sampleCount: number;
}

/** Internal interface for task draft records */
export interface TaskDraft {
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

export interface CallLLMOptions {
  draftId: string;
  /** Full context XML including all enrichments (repomix, summaries, images, etc.) */
  fullContext: string;
  worktreePath: string;
  githubToken: string;
  repository: string;
  correlationId?: string;
  /** Token limit based on user's context level setting */
  tokenLimit: number;
  /** Model to use for plan generation (e.g., 'opus', 'claude:claude-opus-4-5-20251101') */
  model?: string;
  /** Optional context from additional repositories (marked as example/reference only) */
  additionalContext?: string;
  /** Granularity setting for task enforcement */
  granularity: Granularity;
}

export interface CallLLMForPlanResult {
  plan: Plan;
  enforcementMetadata: GranularityEnforcementMetadata;
}

export interface ContextGenerationResult {
  fullContext: string;
  contextResult: {
    context: string;
    includedFiles: string[];
    totalTokens: number;
  };
}

export interface ContextGenerationParams {
  worktreePath: string;
  config: {
    compress: boolean;
    granularity: Granularity;
    contextRepositories?: ContextRepository[];
  };
  relevantFilePaths: string[];
  candidateSummaries: { path: string; summary: string }[];
  budgets: TokenBudgetResult;
  base64Images: Base64Image[];
  draft: TaskDraft;
  draftId: string;
  githubToken: string;
  correlationId?: string;
  generationModel: string;
  correlatedLogger: MinimalLogger;
}
